// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_CONNECTION_H
#define FS_CONNECTION_H

#include "network/networkmessage.h"

#include <chrono>

enum ConnectionState_t
{
	CONNECTION_STATE_DISCONNECTED,
	CONNECTION_STATE_REQUEST_CHARLIST,
	CONNECTION_STATE_GAMEWORLD_AUTH,
	CONNECTION_STATE_PENDING
};

static constexpr int32_t CONNECTION_WRITE_TIMEOUT = 30;
static constexpr int32_t CONNECTION_READ_TIMEOUT = 90;

class Protocol;
using Protocol_ptr = std::shared_ptr<Protocol>;
class OutputMessage;
using OutputMessage_ptr = std::shared_ptr<OutputMessage>;
class Connection;
using Connection_ptr = std::shared_ptr<Connection>;
using ConnectionWeak_ptr = std::weak_ptr<Connection>;
class ServiceBase;
using Service_ptr = std::shared_ptr<ServiceBase>;
class ServicePort;
using ServicePort_ptr = std::shared_ptr<ServicePort>;
using ConstServicePort_ptr = std::shared_ptr<const ServicePort>;

class ConnectionManager
{
public:
	static ConnectionManager& getInstance()
	{
		static ConnectionManager instance;
		return instance;
	}

	Connection_ptr createConnection(boost::asio::io_context& io_context, ConstServicePort_ptr servicePort);
	void releaseConnection(const Connection_ptr& connection);
	bool admit(const Connection_ptr& connection, const boost::asio::ip::address& ip);

private:
	ConnectionManager() = default;

	std::unordered_set<Connection_ptr> connections;
	std::mutex connectionManagerLock;
	std::map<boost::asio::ip::address, size_t> admittedByIp;
	size_t admittedCount = 0;
};

class Connection : public std::enable_shared_from_this<Connection>
{
public:
	using Address = boost::asio::ip::address;
	// non-copyable
	Connection(const Connection&) = delete;
	Connection& operator=(const Connection&) = delete;

	enum
	{
		FORCE_CLOSE = true
	};

	Connection(boost::asio::io_context& io_context, ConstServicePort_ptr service_port);
	~Connection();

	friend class ConnectionManager;

	void close(bool force = false);
	bool isOpen() const { return !closed.load(std::memory_order_acquire); }
	// Used by protocols that require server to send first
	void accept(Protocol_ptr protocol);
	void accept();

	using BinaryPayload_ptr = std::shared_ptr<std::vector<uint8_t>>;
	using PayloadVariant = std::variant<OutputMessage_ptr, std::string, BinaryPayload_ptr>;

	void send(const OutputMessage_ptr& msg);
	void sendJSON(const boost::json::value& val);
	void sendBinary(BinaryPayload_ptr payload);
	void sendBinary(std::vector<uint8_t> payload);

	const Address& getIP() const { return remoteAddress; };

	// Takes this connection out of the packet-per-second budget.
	//
	// Set for authenticated admins only. Pasting a map is the reason: client.js
	// splits an admin chat line on '!' and sends every fragment as its own
	// frame, so a few hundred buildings is a few hundred frames back to back --
	// well past the token bucket's burst allowance, and the admin would be
	// disconnected mid-paste for doing exactly what the command asks. Ordinary
	// players are unaffected; the limiter is what stops a hostile client
	// flooding the dispatcher, and admin already means "trusted with !kick-all".
	void setRateLimitExempt(bool exempt) { rateLimitExempt.store(exempt, std::memory_order_relaxed); }

private:
	void onWebSocketAccept(const boost::system::error_code& error);
	void doRead();
	void onRead(const boost::system::error_code& error, std::size_t bytes_transferred);

	void onWriteOperation(const boost::system::error_code& error);

	static void handleTimeout(ConnectionWeak_ptr connectionWeak, const boost::system::error_code& error);

	void closeSocket();
	void internalSend(const OutputMessage_ptr& msg);
	void internalSendJSON(const std::string& jsonStr);
	void internalSendBinary(const BinaryPayload_ptr& payload);
	void startWrite();
	void clearWrites();
	void enqueue(PayloadVariant payload);

	bool consumePacketToken();

	boost::asio::ip::tcp::socket& getSocket() { return ws.next_layer(); }
	friend class ServicePort;

	boost::beast::flat_buffer readBuffer;

	boost::asio::steady_timer readTimer;
	boost::asio::steady_timer writeTimer;

	std::recursive_mutex connectionLock;

	struct PendingWrite {
		PayloadVariant payload;
		std::chrono::steady_clock::time_point queuedAt;
		size_t bytes;
		size_t memory;
	};
	std::list<PendingWrite> messageQueue;
	size_t queuedBytes = 0;
	bool socketClosed = false;
	bool admitted = false; // ConnectionManager lock
	std::atomic<bool> closed{false};
	std::atomic<bool> forceCloseRequested{false};

	ConstServicePort_ptr service_port;
	Protocol_ptr protocol;

	// websocket::stream is not thread-safe: Beast requires every async operation
	// on one stream to run in the same strand. With io_context.run() on several
	// threads that is no longer automatic, so all of this connection's handlers
	// are bound here. Different connections still run in parallel.
	boost::asio::strand<boost::asio::io_context::executor_type> strand;

	boost::beast::websocket::stream<boost::asio::ip::tcp::socket> ws;
	Address remoteAddress;

	// Packet rate limiting, see Connection::consumePacketToken.
	std::chrono::steady_clock::time_point lastPacketRefill;
	double packetTokens;

	// Only one write is ever in flight per connection (messageQueue serialises
	// them), so one timestamp/size pair is enough to measure it.
	uint64_t writeStartedAt = 0;
	uint64_t writeBytes = 0;

	ConnectionState_t connectionState = CONNECTION_STATE_PENDING;
	bool receivedFirst = false;
	std::atomic<bool> rateLimitExempt{false};
};

#endif // FS_CONNECTION_H
