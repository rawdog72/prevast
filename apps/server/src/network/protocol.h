// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_PROTOCOL_H
#define FS_PROTOCOL_H

#include "network/connection.h"

class Protocol : public std::enable_shared_from_this<Protocol>
{
public:
	explicit Protocol(Connection_ptr connection) : connection(connection) {}
	virtual ~Protocol() = default;

	// non-copyable
	Protocol(const Protocol&) = delete;
	Protocol& operator=(const Protocol&) = delete;

	virtual void parsePacket(NetworkMessage&) {}

	// May this protocol receive WebSocket TEXT frames?
	//
	// No, for anything on the game port: that wire is binary in both directions
	// and a text frame there is a stale client or a probe, so Connection::onRead
	// drops the socket rather than trying to interpret it. ProtocolStatus
	// overrides this -- it answers monitoring queries in JSON, which is the
	// right format for something external tooling reads, and it is on its own
	// port where no game traffic can reach it.
	virtual bool acceptsTextFrames() const { return false; }

	virtual void onSendMessage(const OutputMessage_ptr& msg);
	void onRecvMessage(NetworkMessage& msg);
	virtual void onRecvFirstMessage(NetworkMessage& msg) = 0;
	virtual void onConnect() {}

	Connection_ptr getConnection() const { return connection.lock(); }

	Connection::Address getIP() const;

	// Use this function for autosend messages only
	OutputMessage_ptr getOutputBuffer(int32_t size);

	OutputMessage_ptr& getCurrentBuffer() { return outputBuffer; }

	void send(OutputMessage_ptr msg) const
	{
		if (auto connection = getConnection()) {
			sentSinceKeepAlive = true;
			connection->send(msg);
		}
	}

	// Push out any messages held back for coalescing. No-op unless a subclass
	// batches; see ProtocolGame::flushBatch.
	//
	// There used to be a sendJSON() here as well, and it had to call this first:
	// text and binary shared one ordered stream and the login handshake depended
	// on that order (the JSON roster had to land before the binary HANDSHAKE
	// that consumed it). The game protocol is binary in both directions now, so
	// there is no second stream to keep in step -- everything goes through the
	// batch, in order, by construction. ProtocolStatus still answers in JSON,
	// but it does not batch and talks to its Connection directly.
	virtual void flushOutputBatch() const {}

	// Reads and clears "anything reached this client since the last check".
	// Any frame resets the client's own disconnect watchdog, so this is what
	// decides whether a keepalive is needed at all.
	bool consumeSentFlag() const
	{
		const bool sent = sentSinceKeepAlive;
		sentSinceKeepAlive = false;
		return sent;
	}

	// "Something is on its way to this client." Set by send(), and
	// also by a batch append -- a message sitting in the batch is still traffic,
	// and without this every client would collect a redundant keepalive per tick.
	void markSent() const { sentSinceKeepAlive = true; }

protected:
	void disconnect() const
	{
		if (auto connection = getConnection()) {
			connection->close();
		}
	}
	void setRawMessages(bool value) { rawMessages = value; }

	virtual void release() {}

private:
	friend class Connection;

	OutputMessage_ptr outputBuffer;

	const ConnectionWeak_ptr connection;
	bool rawMessages = false;
	mutable bool sentSinceKeepAlive = false;
};

#endif // FS_PROTOCOL_H
