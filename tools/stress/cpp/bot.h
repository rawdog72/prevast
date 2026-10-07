// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// One simulated player: websocket session, login, a small world-view kept from
// the UNITS stream, and a fixed-rate tick that calls the behavior.
//
// Why C++ and not the Python harness: this box has two physical cores and runs
// the server as well, and the asyncio harness saturated one core at ~173 of 250
// bots while using ~1.7x the server's CPU. Once the generator saturates, the
// server looks faster than it is (less input arriving) and the bot-side tick
// metric looks worse than it is (frames not drained) -- the measurement stops
// describing the server. See tools/stress/README.md.
//
// Everything for one bot runs on a strand shared with the other bots in its
// slice, so the whole fleet needs only as many strands as worker threads and a
// bot never needs a lock.

#pragma once

#include "protocol.h"
#include "stats.h"

#include <boost/asio.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/websocket.hpp>

#include <chrono>
#include <cstdint>
#include <deque>
#include <memory>
#include <random>
#include <string>
#include <unordered_map>
#include <vector>

namespace bot {

namespace net = boost::asio;
namespace beast = boost::beast;
namespace websocket = boost::beast::websocket;
using tcp = boost::asio::ip::tcp;

class Bot;

class Behavior {
public:
	virtual ~Behavior() = default;
	virtual void onSpawn(Bot&) {}
	virtual void onTick(Bot&) {}
};

using BehaviorPtr = std::unique_ptr<Behavior>;

struct Config {
	std::string host = "127.0.0.1";
	std::string port = "7172";
	std::string password;
	std::string nickPrefix = "cppbot";
	int tickHz = 10;
	// Keep a map of every other visible entity. Needed by behaviors that act on
	// the world (itemchurn picks up loot it can see) and by the relevance
	// metrics. Cheap here; it was the dominant cost in the Python harness.
	bool trackOthers = true;
	bool respawn = true;
};

// What we remember about one other visible entity, for the relevance metrics
// and for behaviors that need to find something nearby.
struct Tracked {
	uint16_t endX = 0;
	uint16_t endY = 0;
	uint8_t type = 0;
	uint32_t id = 0;
	uint64_t lastMs = 0;
};

// An entity's identity on the wire is NOT its id alone: a player is sent as
// pid = GUID with id = 0, so every player would collide on key 0. World
// entities are the other way round -- pid 0 and a globally unique id. So the
// key is the pair, which is unique for both shapes.
//
// `type` used to be mixed in too, back when an id was only 16 bits and only
// unique within a class. It is not needed now (ids are unique across every
// class) and including it would be actively wrong: an entity that changed
// type would look like two entities.
//
// The uid-based "slot was recycled" check that used to guard this map is gone
// with uid. It was mostly a no-op anyway -- uid was 0 for the great majority
// of entities, so `tr.uid != rec.uid` compared 0 against 0. Removals erase the
// key, and the pool's cursor rotates through the whole space before reusing an
// id, so diffing across a recycled id needs a MISSED removal -- which is what
// checkvis.py exists to catch.
inline uint32_t entityKey(uint8_t pid, uint32_t id)
{
	return (static_cast<uint32_t>(pid) << 24) | (id & 0x00FFFFFFu);
}

class Bot : public std::enable_shared_from_this<Bot> {
public:
	Bot(net::io_context& io, net::strand<net::io_context::executor_type> strand,
	    const Config& cfg, BehaviorPtr behavior, Stats& stats, int index);

	void start();
	void stop();

	// Called by the fleet timer, already on our strand.
	void tick();

	// Queues a frame. Safe to call from the strand only.
	void send(std::string frame); // a binary frame; std::string is the byte container

	// --- view, read by behaviors ---
	bool alive() const { return m_alive && m_loggedIn; }
	bool loggedIn() const { return m_loggedIn; }
	int index() const { return m_index; }
	uint16_t x() const { return m_x; }
	uint16_t y() const { return m_y; }
	int guid() const { return m_guid; }
	const std::unordered_map<uint32_t, Tracked>& others() const { return m_others; }
	std::vector<proto::ItemSlot>& newItems() { return m_newItems; }

	// Last FULL_INVENTORY snapshot (login only -- the server does not resend it
	// on every change). Empty slots are omitted.
	const std::vector<proto::ItemSlot>& inventory() const { return m_inventory; }
	const proto::ItemSlot* findInventoryItem(uint16_t iid) const;
	std::mt19937& rng() { return m_rng; }
	Stats& stats() { return m_stats; }

	// Counts how many currently-visible entities have this type. Sampled by the
	// reporter, not per tick.
	size_t countVisible(uint8_t type) const;

	// Input de-duplication. MOVE/ROTATION/SHIFT are state-change opcodes --
	// client.js only sends them when the value actually changes -- so behaviors
	// go through these rather than send() to match a real client's traffic.
	void setMove(int mask);
	void setRotation(int degrees);
	void setShift(bool on);
	void setMouseDirection(int dir);

private:
	void doResolveConnect();
	void onConnected();
	void doRead();
	void onRead(beast::error_code ec, std::size_t bytes);
	void handleBinary(const uint8_t* data, size_t n);
	void handleUnits(const uint8_t* data, size_t n);
	void doWrite();
	void fail(beast::error_code ec, const char* what);
	void teardown(bool countDisconnect);
	void scheduleReconnect();

	net::io_context& m_io;
	net::strand<net::io_context::executor_type> m_strand;
	const Config& m_cfg;
	BehaviorPtr m_behavior;
	Stats& m_stats;
	int m_index;

	tcp::resolver m_resolver;
	std::unique_ptr<websocket::stream<tcp::socket>> m_ws;
	beast::flat_buffer m_buffer;
	std::deque<std::string> m_outbox;
	bool m_writing = false;

	std::string m_token;
	int m_guid = -1;
	uint16_t m_x = 0, m_y = 0;
	bool m_havePosition = false;
	bool m_alive = false;
	bool m_loggedIn = false;
	bool m_stopping = false;
	bool m_counted = false;

	uint64_t m_lastSelfMs = 0;
	std::unordered_map<uint32_t, Tracked> m_others;
	std::vector<proto::ItemSlot> m_newItems;
	std::vector<proto::ItemSlot> m_inventory;
	FrameAccum m_accum;

	// Bot 0 publishes a visible-entity census this often, in UNITS frames.
	static constexpr int CENSUS_EVERY_FRAMES = 20;
	int m_censusCountdown = 0;

	int m_lastMove = -1;
	int m_lastRotation = -1;
	int m_lastShift = -1;
	int m_lastMouseDir = -1;

	std::mt19937 m_rng;
	net::steady_timer m_reconnectTimer;
};

using BotPtr = std::shared_ptr<Bot>;

} // namespace bot
