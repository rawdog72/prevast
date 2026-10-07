// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "network/connection.h"
#include "content/configmanager.h"
#include "network/outputmessage.h"
#include "core/perf.h"
#include "network/protocol.h"
#include "network/server.h"
#include "core/tasks.h"

namespace {
constexpr size_t CONNECTION_MAX_MESSAGE = NETWORKMESSAGE_MAXSIZE - NetworkMessage::INITIAL_BUFFER_POSITION;
constexpr size_t CONNECTION_MAX_QUEUED_BYTES = 512 * 1024;
constexpr size_t CONNECTION_MAX_QUEUED_FRAMES = 128;
constexpr size_t CONNECTION_GLOBAL_WRITE_MEMORY = 64 * 1024 * 1024;
constexpr auto CONNECTION_QUEUE_MAX_AGE = std::chrono::seconds(5);
std::atomic<size_t> connectionWriteMemory{0};
double packetBucketCapacity(int32_t rate) { return std::max(2.0 * rate, 50.0); }
}

Connection_ptr ConnectionManager::createConnection(boost::asio::io_context& io, ConstServicePort_ptr service)
{
    auto connection = std::make_shared<Connection>(io, std::move(service));
    std::lock_guard lock(connectionManagerLock);
    connections.insert(connection);
    return connection;
}

bool ConnectionManager::admit(const Connection_ptr& connection, const boost::asio::ip::address& ip)
{
    std::lock_guard lock(connectionManagerLock);
    const size_t maximum = std::clamp(ConfigManager::getNumber(ConfigManager::MAX_CONNECTIONS), 16, 4096);
    const size_t perIp = std::clamp(ConfigManager::getNumber(ConfigManager::MAX_CONNECTIONS_PER_IP), 1, 1024);
    auto it = admittedByIp.find(ip);
    if (admittedCount >= maximum || (it != admittedByIp.end() && it->second >= perIp)) return false;
    ++admittedByIp[ip];
    ++admittedCount;
    connection->admitted = true;
    return true;
}

void ConnectionManager::releaseConnection(const Connection_ptr& connection)
{
    std::lock_guard lock(connectionManagerLock);
    if (connections.erase(connection) && connection->admitted) {
        connection->admitted = false;
        --admittedCount;
        auto it = admittedByIp.find(connection->remoteAddress);
        if (it != admittedByIp.end() && --it->second == 0) admittedByIp.erase(it);
    }
}

Connection::Connection(boost::asio::io_context& io, ConstServicePort_ptr service) :
    readBuffer(CONNECTION_MAX_MESSAGE), readTimer(io), writeTimer(io),
    service_port(std::move(service)), strand(boost::asio::make_strand(io)), ws(strand),
    lastPacketRefill(std::chrono::steady_clock::now()),
    packetTokens(packetBucketCapacity(ConfigManager::getNumber(ConfigManager::MAX_PACKETS_PER_SECOND)))
{
    ws.read_message_max(CONNECTION_MAX_MESSAGE);
    auto timeout = boost::beast::websocket::stream_base::timeout::suggested(boost::beast::role_type::server);
    timeout.handshake_timeout = std::chrono::seconds(10);
    ws.set_option(timeout);
    ws.control_callback([this](boost::beast::websocket::frame_type, boost::beast::string_view) {
        if (!consumePacketToken()) close(FORCE_CLOSE);
    });
}

Connection::~Connection()
{
    // No handlers can still borrow this stream when its last owner disappears.
    clearWrites();
}

bool Connection::consumePacketToken()
{
    if (rateLimitExempt.load(std::memory_order_relaxed)) return true;
    const int32_t rate = ConfigManager::getNumber(ConfigManager::MAX_PACKETS_PER_SECOND);
    if (rate <= 0) return true;
    const auto now = std::chrono::steady_clock::now();
    packetTokens = std::min(packetBucketCapacity(rate), packetTokens +
        std::chrono::duration<double>(now - lastPacketRefill).count() * rate);
    lastPacketRefill = now;
    if (packetTokens < 1) return false;
    --packetTokens;
    return true;
}

void Connection::close(bool force)
{
    // A control-frame flood can request closure many times in one read.
    // Post at most one graceful close and one forced escalation per connection.
    if (force) {
        if (forceCloseRequested.exchange(true, std::memory_order_acq_rel)) return;
        closed.store(true, std::memory_order_release);
    } else if (closed.exchange(true, std::memory_order_acq_rel)) {
        return;
    }
    boost::asio::post(strand, [self = shared_from_this(), force] {
        std::lock_guard lock(self->connectionLock);
        self->connectionState = CONNECTION_STATE_DISCONNECTED;
        if (force || self->messageQueue.empty()) self->closeSocket();
    });
}

void Connection::closeSocket()
{
    // Strand only. Retain admission until dispatcher cleanup completes, bounding
    // release tasks even if a peer repeatedly connects while the game is stalled.
    if (socketClosed) return;
    socketClosed = true;
    closed.store(true, std::memory_order_release);
    readTimer.cancel();
    writeTimer.cancel();
    boost::system::error_code ec;
    ws.next_layer().shutdown(boost::asio::ip::tcp::socket::shutdown_both, ec);
    ws.next_layer().close(ec);
    clearWrites(); // completion handlers own any in-flight payload
    if (protocol) {
        g_dispatcher.addTask([self = shared_from_this()] {
            self->protocol->release();
            ConnectionManager::getInstance().releaseConnection(self);
        });
    } else {
        ConnectionManager::getInstance().releaseConnection(shared_from_this());
    }
}

void Connection::accept(Protocol_ptr selected)
{
    protocol = std::move(selected); // before any stream operation starts
    accept();
}

void Connection::accept()
{
    boost::asio::dispatch(strand, [self = shared_from_this()] {
        if (!self->isOpen()) return;
        self->ws.async_accept(boost::asio::bind_executor(self->strand,
            [self](const boost::system::error_code& ec) { self->onWebSocketAccept(ec); }));
    });
}

void Connection::onWebSocketAccept(const boost::system::error_code& ec)
{
    if (ec) { close(FORCE_CLOSE); return; }
    if (protocol) {
        g_dispatcher.addTask([self = shared_from_this()] {
            if (self->isOpen() && self->protocol) {
                self->protocol->onConnect();
            }
        });
    }
    doRead();
}

void Connection::doRead()
{
    if (!isOpen()) return;
    readTimer.expires_after(std::chrono::seconds(receivedFirst ? CONNECTION_READ_TIMEOUT : 10));
    readTimer.async_wait(boost::asio::bind_executor(strand,
        [weak = weak_from_this()](const boost::system::error_code& ec) { handleTimeout(weak, ec); }));
    ws.async_read(readBuffer, boost::asio::bind_executor(strand,
        [self = shared_from_this()](const boost::system::error_code& ec, size_t bytes) { self->onRead(ec, bytes); }));
}

void Connection::onRead(const boost::system::error_code& ec, size_t bytes)
{
    readTimer.cancel();
    if (ec || !isOpen() || bytes == 0 || bytes > CONNECTION_MAX_MESSAGE || !consumePacketToken()) {
        close(FORCE_CLOSE);
        return;
    }
    const bool first = !receivedFirst;
    const bool text = ws.got_text();
    if (text && !protocol && first) protocol = service_port->make_text_protocol(shared_from_this());
    if (text && (!protocol || !protocol->acceptsTextFrames() || bytes > NetworkMessage::MAX_STRING_BYTES)) {
        close(FORCE_CLOSE);
        return;
    }
    std::vector<uint8_t> payload(bytes);
    boost::asio::buffer_copy(boost::asio::buffer(payload), readBuffer.data());
    readBuffer.consume(bytes);
    if (!protocol) {
        NetworkMessage selector;
        selector.addByte(payload.front());
        selector.setBufferPosition(0);
        protocol = service_port->make_protocol(selector, shared_from_this());
        if (!protocol) { close(FORCE_CLOSE); return; }
        payload.erase(payload.begin()); // protocol discriminator, not a game opcode
    } else if (first && !payload.empty() && payload.front() == 30) {
        payload.erase(payload.begin());
    }
    receivedFirst = true;
    // Exactly one input task per admitted connection. TCP backpressure bounds
    // queued work; all player/protocol state is read only on the dispatcher.
    g_dispatcher.addTask([self = shared_from_this(), payload = std::move(payload), first, text] {
        if (!self->isOpen()) return;
        try {
            NetworkMessage message;
            if (text) message.addString(std::string_view(reinterpret_cast<const char*>(payload.data()), payload.size()));
            else {
                if (!payload.empty()) std::memcpy(message.getBuffer() + NetworkMessage::INITIAL_BUFFER_POSITION, payload.data(), payload.size());
                message.setLength(static_cast<uint16_t>(payload.size()));
            }
            message.setBufferPosition(0);
            if (first) self->protocol->onRecvFirstMessage(message);
            else self->protocol->onRecvMessage(message);
        } catch (const std::exception& e) {
            fmt::print("[Network] packet rejected: {}\n", e.what());
            self->close(FORCE_CLOSE);
        }
        boost::asio::post(self->strand, [self] { self->doRead(); });
    });
}

void Connection::send(const OutputMessage_ptr& message) { enqueue(message); }
void Connection::sendJSON(const boost::json::value& value) { enqueue(boost::json::serialize(value)); }
void Connection::sendBinary(BinaryPayload_ptr payload) { enqueue(payload); }
void Connection::sendBinary(std::vector<uint8_t> payload) { enqueue(std::make_shared<std::vector<uint8_t>>(std::move(payload))); }

void Connection::enqueue(PayloadVariant payload)
{
    std::lock_guard lock(connectionLock);
    if (!isOpen()) return;
    const size_t bytes = std::holds_alternative<OutputMessage_ptr>(payload)
        ? std::get<OutputMessage_ptr>(payload)->getLength()
        : (std::holds_alternative<std::string>(payload)
            ? std::get<std::string>(payload).size()
            : std::get<BinaryPayload_ptr>(payload)->size());
    const size_t memory = sizeof(PendingWrite) + (std::holds_alternative<OutputMessage_ptr>(payload)
        ? sizeof(OutputMessage) : bytes);
    const auto now = std::chrono::steady_clock::now();
    if (messageQueue.size() >= CONNECTION_MAX_QUEUED_FRAMES || queuedBytes + bytes > CONNECTION_MAX_QUEUED_BYTES ||
        (!messageQueue.empty() && now - messageQueue.front().queuedAt >= CONNECTION_QUEUE_MAX_AGE)) {
        close(FORCE_CLOSE);
        return;
    }
    const size_t previous = connectionWriteMemory.fetch_add(memory, std::memory_order_relaxed);
    if (previous + memory > CONNECTION_GLOBAL_WRITE_MEMORY) {
        connectionWriteMemory.fetch_sub(memory, std::memory_order_relaxed);
        close(FORCE_CLOSE);
        return;
    }
    const bool start = messageQueue.empty();
    try { messageQueue.push_back({std::move(payload), now, bytes, memory}); }
    catch (...) { connectionWriteMemory.fetch_sub(memory, std::memory_order_relaxed); throw; }
    queuedBytes += bytes;
    g_netperf.recordEnqueue(messageQueue.size());
    if (start) boost::asio::post(strand, [self = shared_from_this(), postedAt = NetProfiler::nowNanos()] {
        g_netperf.recordPostDelay(postedAt);
        std::lock_guard lock(self->connectionLock);
        self->startWrite();
    });
}

void Connection::clearWrites()
{
    for (const auto& pending : messageQueue) connectionWriteMemory.fetch_sub(pending.memory, std::memory_order_relaxed);
    messageQueue.clear();
    queuedBytes = 0;
}

void Connection::startWrite()
{
    if (socketClosed || messageQueue.empty()) return;
    const auto deadline = messageQueue.front().queuedAt + CONNECTION_QUEUE_MAX_AGE;
    if (std::chrono::steady_clock::now() >= deadline) { closeSocket(); return; }
    writeTimer.expires_at(deadline);
    writeTimer.async_wait(boost::asio::bind_executor(strand,
        [weak = weak_from_this()](const boost::system::error_code& ec) { handleTimeout(weak, ec); }));
    const auto& payload = messageQueue.front().payload;
    if (std::holds_alternative<OutputMessage_ptr>(payload)) internalSend(std::get<OutputMessage_ptr>(payload));
    else if (std::holds_alternative<std::string>(payload)) internalSendJSON(std::get<std::string>(payload));
    else internalSendBinary(std::get<BinaryPayload_ptr>(payload));
}

void Connection::internalSend(const OutputMessage_ptr& message)
{
    protocol->onSendMessage(message);
    writeStartedAt = NetProfiler::nowNanos();
    writeBytes = message->getLength();
    ws.binary(true);
    ws.async_write(boost::asio::buffer(message->getOutputBuffer(), message->getLength()),
        boost::asio::bind_executor(strand, [self = shared_from_this(), message](const boost::system::error_code& ec, size_t) {
            self->onWriteOperation(ec);
        }));
}

void Connection::internalSendJSON(const std::string& json)
{
    auto payload = std::make_shared<std::string>(json);
    writeStartedAt = NetProfiler::nowNanos();
    writeBytes = payload->size();
    ws.binary(false);
    ws.async_write(boost::asio::buffer(*payload), boost::asio::bind_executor(strand,
        [self = shared_from_this(), payload](const boost::system::error_code& ec, size_t) { self->onWriteOperation(ec); }));
}

void Connection::internalSendBinary(const BinaryPayload_ptr& payload)
{
    writeStartedAt = NetProfiler::nowNanos();
    writeBytes = payload->size();
    ws.binary(true);
    ws.async_write(boost::asio::buffer(*payload), boost::asio::bind_executor(strand,
        [self = shared_from_this(), payload](const boost::system::error_code& ec, size_t) { self->onWriteOperation(ec); }));
}

void Connection::onWriteOperation(const boost::system::error_code& ec)
{
    std::lock_guard lock(connectionLock);
    writeTimer.cancel();
    if (writeStartedAt) { g_netperf.recordWrite(writeStartedAt, writeBytes); writeStartedAt = 0; }
    if (socketClosed) return;
    if (!messageQueue.empty()) {
        queuedBytes -= messageQueue.front().bytes;
        connectionWriteMemory.fetch_sub(messageQueue.front().memory, std::memory_order_relaxed);
        messageQueue.pop_front();
    }
    if (ec) { closeSocket(); return; }
    if (!messageQueue.empty()) startWrite();
    else if (!isOpen()) closeSocket();
}

void Connection::handleTimeout(ConnectionWeak_ptr weak, const boost::system::error_code& ec)
{
    if (ec == boost::asio::error::operation_aborted) return;
    if (auto connection = weak.lock()) connection->close(FORCE_CLOSE);
}
