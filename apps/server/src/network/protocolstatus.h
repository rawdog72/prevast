// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_PROTOCOLSTATUS_H
#define FS_PROTOCOLSTATUS_H

#include "network/protocol.h"

class NetworkMessage;

class ProtocolStatus final : public Protocol
{
public:
	// static protocol information
	enum
	{
		server_sends_first = false
	};
	enum
	{
		protocol_identifier = 0xFF
	};
	enum
	{
		use_checksum = false
	};
	static const char* protocol_name() { return "status protocol"; }

	explicit ProtocolStatus(Connection_ptr connection) : Protocol(connection) {}

	void onRecvFirstMessage(NetworkMessage& msg) override;

	// The one protocol that still speaks JSON, deliberately. This is a
	// monitoring endpoint on its own port, read by external tooling and by
	// people; a binary status blob would be a downgrade, not a modernisation.
	// The GAME protocol is binary in both directions and refuses text frames.
	bool acceptsTextFrames() const override { return true; }


private:
	static const uint64_t start;

	void sendStatusJSON();

	static std::map<Connection::Address, int64_t> ipConnectMap;
};

#endif // FS_PROTOCOLSTATUS_H
