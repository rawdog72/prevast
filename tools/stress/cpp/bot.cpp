// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "bot.h"

#include <boost/asio/connect.hpp>

#include <cmath>
#include <iostream>

namespace bot {

namespace {

uint64_t nowMs()
{
	using namespace std::chrono;
	return static_cast<uint64_t>(duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count());
}

uint32_t distance(int32_t ax, int32_t ay, int32_t bx, int32_t by)
{
	const double dx = static_cast<double>(ax - bx);
	const double dy = static_cast<double>(ay - by);
	return static_cast<uint32_t>(std::lround(std::sqrt(dx * dx + dy * dy)));
}

// A single tick can never legitimately move a player this far; anything bigger
// is a respawn or a teleport and must not pollute the speed average.
constexpr uint32_t MAX_TICK_JUMP = 200;

} // namespace

Bot::Bot(net::io_context& io, net::strand<net::io_context::executor_type> strand,
         const Config& cfg, BehaviorPtr behavior, Stats& stats, int index)
	: m_io(io)
	, m_strand(strand)
	, m_cfg(cfg)
	, m_behavior(std::move(behavior))
	, m_stats(stats)
	, m_index(index)
	, m_resolver(strand)
	, m_rng(static_cast<uint32_t>(index) * 2654435761u + 12345u)
	, m_reconnectTimer(strand)
{
	m_token = m_cfg.nickPrefix + "-" + std::to_string(index) + "-"
	        + std::to_string(m_rng());
}

void Bot::start()
{
	net::post(m_strand, [self = shared_from_this()]() { self->doResolveConnect(); });
}

void Bot::stop()
{
	net::post(m_strand, [self = shared_from_this()]() {
		self->m_stopping = true;
		self->m_reconnectTimer.cancel();
		self->teardown(false);
	});
}

void Bot::doResolveConnect()
{
	if (m_stopping) return;

	m_ws = std::make_unique<websocket::stream<tcp::socket>>(m_strand);
	m_buffer.clear();
	m_outbox.clear();
	m_writing = false;
	m_guid = -1;
	m_havePosition = false;
	m_alive = false;
	m_loggedIn = false;
	m_others.clear();
	m_newItems.clear();
	m_inventory.clear();
	m_lastMove = m_lastRotation = m_lastShift = m_lastMouseDir = -1;

	m_resolver.async_resolve(m_cfg.host, m_cfg.port,
		[self = shared_from_this()](beast::error_code ec, tcp::resolver::results_type results) {
			if (ec) { self->fail(ec, "resolve"); return; }
			net::async_connect(self->m_ws->next_layer(), results,
				[self](beast::error_code ec2, const tcp::endpoint&) {
					if (ec2) { self->fail(ec2, "connect"); return; }
					self->m_ws->next_layer().set_option(tcp::no_delay(true), ec2);
					self->m_ws->async_handshake(self->m_cfg.host, "/",
						[self](beast::error_code ec3) {
							if (ec3) { self->fail(ec3, "ws-handshake"); return; }
							self->onConnected();
						});
				});
		});
}

void Bot::onConnected()
{
	if (m_stopping) return;

	// Binary frames. The game port refuses text ones outright as of 2026-08-12
	// -- Connection::onRead drops the socket -- so this is what makes the bot a
	// client at all, not a preference.
	m_ws->binary(true);
	m_stats.connects.fetch_add(1, std::memory_order_relaxed);
	m_counted = true;
	const int64_t live = m_stats.live.fetch_add(1, std::memory_order_relaxed) + 1;
	m_stats.notePeak(live);

	const std::string nick = m_cfg.nickPrefix + std::to_string(m_index);
	send(proto::login(m_token, nick, static_cast<int>(m_rng() % 4), m_cfg.password));

	m_loggedIn = true;
	m_alive = true;
	m_behavior->onSpawn(*this);

	doRead();
}

void Bot::doRead()
{
	if (m_stopping || !m_ws) return;
	m_ws->async_read(m_buffer,
		[self = shared_from_this()](beast::error_code ec, std::size_t bytes) {
			self->onRead(ec, bytes);
		});
}

void Bot::onRead(beast::error_code ec, std::size_t bytes)
{
	if (ec) { fail(ec, "read"); return; }

	m_stats.framesRx.fetch_add(1, std::memory_order_relaxed);
	m_stats.bytesRx.fetch_add(bytes, std::memory_order_relaxed);

	if (m_ws->got_binary()) {
		// flat_buffer hands back a possibly-segmented sequence; the server
		// writes one frame per message so in practice it is one segment, and
		// beast keeps it contiguous for reads of this size.
		auto seq = m_buffer.data();
		const uint8_t* p = static_cast<const uint8_t*>(seq.data());
		handleBinary(p, bytes);
	}
	// A text frame cannot arrive any more: the server never sends one on this
	// port. The roster, alerts and team updates are binary opcodes 76-81.

	m_buffer.consume(bytes);
	doRead();
}

void Bot::handleBinary(const uint8_t* data, size_t n)
{
	if (n == 0) return;

	switch (static_cast<proto::ServerOp>(data[0])) {
		case proto::ServerOp::BATCH: {
			// Unwrap and re-dispatch. Depth is always one: the server never
			// nests an envelope inside an envelope.
			size_t off = proto::BATCH_HEADER_BYTES;
			while (off + proto::BATCH_SUBHEADER_BYTES <= n) {
				const uint16_t len = proto::readU16(data + off);
				off += proto::BATCH_SUBHEADER_BYTES;
				if (len < 1 || off + len > n) break;
				handleBinary(data + off, len);
				off += len;
			}
			break;
		}

		case proto::ServerOp::UNITS:
			handleUnits(data, n);
			break;

		case proto::ServerOp::HANDSHAKE: {
			proto::Handshake hs;
			if (proto::parseHandshake(data, n, hs)) m_guid = hs.ownGuid;
			break;
		}

		case proto::ServerOp::INVENTORY_SLOT: {
			proto::ItemSlot item;
			if (proto::parseInventorySlot(data, n, item) && item.iid != 0) {
				// Bounded: a behavior that never drains this must not grow it.
				if (m_newItems.size() >= 16) m_newItems.erase(m_newItems.begin());
				m_newItems.push_back(item);
			}
			break;
		}

		case proto::ServerOp::FULL_INVENTORY: {
			m_inventory.clear();
			const size_t slots = proto::inventorySlotCount(n);
			for (size_t i = 0; i < slots; ++i) {
				const proto::ItemSlot slot = proto::inventorySlot(data, i);
				if (slot.iid != 0) m_inventory.push_back(slot);
			}
			break;
		}

		case proto::ServerOp::PLAYER_DIE:
			m_alive = false;
			m_stats.deaths.fetch_add(1, std::memory_order_relaxed);
			break;

		default:
			break;
	}
}

void Bot::handleUnits(const uint8_t* data, size_t n)
{
	const size_t count = proto::unitRecordCount(n);
	m_accum.records += count;

	// A login frame is a full snapshot and clears the client's entity table,
	// so our view has to be reset the same way or every entity in it would
	// look permanently stale to the relevance metrics.
	if (proto::unitsIsLogin(data, n)) m_others.clear();

	const uint64_t t = nowMs();

	for (size_t i = 0; i < count; ++i) {
		const proto::UnitRecord rec = proto::unitRecord(data, i);

		// Our own player. Type 12 shares the pid but is not us.
		if (m_guid >= 0 && rec.pid == static_cast<uint8_t>(m_guid) && rec.type != 12) {
			if (m_havePosition) {
				const uint32_t moved = distance(rec.endX, rec.endY, m_x, m_y);
				const uint64_t dt = t - m_lastSelfMs;
				if (moved <= MAX_TICK_JUMP && dt > 0) {
					m_stats.moveDistance.fetch_add(moved, std::memory_order_relaxed);
					m_stats.moveMillis.fetch_add(dt, std::memory_order_relaxed);
				}
			}
			m_x = rec.endX;
			m_y = rec.endY;
			m_havePosition = true;
			m_lastSelfMs = t;
			continue;
		}

		if (!m_cfg.trackOthers) continue;

		const uint32_t key = entityKey(rec.pid, rec.id);

		if (rec.state == 0) {
			m_others.erase(key);
			continue;
		}

		auto it = m_others.find(key);
		if (it == m_others.end()) {
			m_others.emplace(key, Tracked{ rec.endX, rec.endY, rec.type, rec.id, t });
			continue;
		}

		Tracked& tr = it->second;
		// Projectiles are excluded from the gate on purpose. The server sends
		// one update when a bullet appears and one when it stops (Projectile
		// never overrides isDirty), and the client flies it the rest of the way
		// itself at the speed carried in `state` -- so a long gap between a
		// projectile's updates is the design, not error. Counting them would
		// swamp the players, whose drift is the thing being gated.
		if (m_havePosition && rec.type != proto::TYPE_PROJECTILE) {
			// How far this entity's destination moved while we were not being
			// told about it: the client parks at the destination it was last
			// given, so this is the error a player at this distance sees.
			const uint32_t drift = distance(rec.endX, rec.endY, tr.endX, tr.endY);
			const size_t band = bandOf(distance(rec.endX, rec.endY, m_x, m_y));
			m_accum.updates[band] += 1;
			m_accum.staleMs[band] += (t - tr.lastMs);
			m_accum.drift[band] += drift;
			if (drift > m_accum.driftMax[band]) m_accum.driftMax[band] = drift;
		}
		tr.endX = rec.endX;
		tr.endY = rec.endY;
		tr.type = rec.type;
		tr.lastMs = t;
	}

	m_accum.fold(m_stats);

	// One bot publishes a census of what it can see, so a scenario that is
	// silently doing nothing (no loot ever spawns, no projectile ever flies)
	// shows up in the report instead of being assumed to work. Done here, on
	// our own strand, because the reporter thread cannot walk this map safely.
	if (m_index == 0 && ++m_censusCountdown >= CENSUS_EVERY_FRAMES) {
		m_censusCountdown = 0;
		m_stats.seenPlayers.store(countVisible(proto::TYPE_PLAYER), std::memory_order_relaxed);
		m_stats.seenLoot.store(countVisible(proto::TYPE_LOOT), std::memory_order_relaxed);
		m_stats.seenProjectiles.store(countVisible(proto::TYPE_PROJECTILE), std::memory_order_relaxed);
	}
}

const proto::ItemSlot* Bot::findInventoryItem(uint16_t iid) const
{
	for (const proto::ItemSlot& item : m_inventory) {
		if (item.iid == iid) return &item;
	}
	return nullptr;
}

size_t Bot::countVisible(uint8_t type) const
{
	size_t n = 0;
	for (const auto& [key, tracked] : m_others) {
		if (tracked.type == type) ++n;
	}
	return n;
}

// `frame` is a byte buffer, not text -- std::string is just the container the
// outbox and beast's net::buffer both already take.
void Bot::send(std::string frame)
{
	if (m_stopping || !m_ws) return;
	m_outbox.push_back(std::move(frame));
	if (!m_writing) doWrite();
}

void Bot::doWrite()
{
	if (m_outbox.empty() || !m_ws) { m_writing = false; return; }
	m_writing = true;
	m_ws->async_write(net::buffer(m_outbox.front()),
		[self = shared_from_this()](beast::error_code ec, std::size_t) {
			if (ec) { self->m_writing = false; self->fail(ec, "write"); return; }
			self->m_stats.framesTx.fetch_add(1, std::memory_order_relaxed);
			self->m_outbox.pop_front();
			self->doWrite();
		});
}

void Bot::tick()
{
	if (m_stopping || !m_loggedIn) return;
	m_stats.botTicks.fetch_add(1, std::memory_order_relaxed);
	m_behavior->onTick(*this);
}

void Bot::setMove(int mask)
{
	if (mask == m_lastMove) return;
	m_lastMove = mask;
	send(proto::move(mask));
}

void Bot::setRotation(int degrees)
{
	degrees = ((degrees % 360) + 360) % 360;
	if (degrees == m_lastRotation) return;
	m_lastRotation = degrees;
	send(proto::rotation(degrees));
}

void Bot::setShift(bool on)
{
	const int v = on ? 1 : 0;
	if (v == m_lastShift) return;
	m_lastShift = v;
	send(proto::shift(on));
}

void Bot::setMouseDirection(int dir)
{
	if (dir == m_lastMouseDir) return;
	m_lastMouseDir = dir;
	send(proto::mouseDirection(dir));
}

void Bot::fail(beast::error_code ec, const char* what)
{
	if (m_stopping) return;
	if (ec != websocket::error::closed && ec != net::error::operation_aborted) {
		m_stats.errors.fetch_add(1, std::memory_order_relaxed);
		static std::atomic<int> reported{0};
		// One line per failure kind is enough to diagnose a broken run; a fleet
		// that loses 250 sockets at once must not print 250 times.
		if (reported.fetch_add(1, std::memory_order_relaxed) < 10) {
			std::cerr << "[bot " << m_index << "] " << what << ": " << ec.message() << "\n";
		}
	}
	teardown(true);
	scheduleReconnect();
}

void Bot::teardown(bool countDisconnect)
{
	if (m_counted) {
		m_counted = false;
		m_stats.live.fetch_sub(1, std::memory_order_relaxed);
		if (countDisconnect) m_stats.disconnects.fetch_add(1, std::memory_order_relaxed);
	}
	m_loggedIn = false;
	m_alive = false;
	if (m_ws) {
		beast::error_code ignored;
		m_ws->next_layer().close(ignored);
		m_ws.reset();
	}
}

void Bot::scheduleReconnect()
{
	if (m_stopping || !m_cfg.respawn) return;

	// Bots die of normal gameplay and the server drops the socket, so a
	// single-session bot leaves the test permanently and the population decays
	// mid-run -- useless for comparing builds. Reconnecting (what a real player
	// does) holds the population at the target. Fresh token: reusing it would
	// look like a session takeover rather than a new spawn.
	m_token = m_cfg.nickPrefix + "-" + std::to_string(m_index) + "-" + std::to_string(m_rng());

	const int delayMs = 500 + static_cast<int>(m_rng() % 1500);
	m_reconnectTimer.expires_after(std::chrono::milliseconds(delayMs));
	m_reconnectTimer.async_wait([self = shared_from_this()](beast::error_code ec) {
		if (!ec) self->doResolveConnect();
	});
}

} // namespace bot
