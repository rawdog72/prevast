// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "network/protocol.h"

#include "network/outputmessage.h"

void Protocol::onSendMessage(const OutputMessage_ptr& msg)
{
	if (!rawMessages) {
		msg->writeMessageLength();

	}
}

void Protocol::onRecvMessage(NetworkMessage& msg)
{
	parsePacket(msg);
}

OutputMessage_ptr Protocol::getOutputBuffer(int32_t size)
{
	// dispatcher thread
	if (!outputBuffer) {
		outputBuffer = tfs::net::make_output_message();
	}
	else if ((outputBuffer->getLength() + size) > NetworkMessage::MAX_PROTOCOL_BODY_LENGTH) {
		send(outputBuffer);
		outputBuffer = tfs::net::make_output_message();
	}
	return outputBuffer;
}

Connection::Address Protocol::getIP() const
{
	if (auto connection = getConnection()) {
		return connection->getIP();
	}

	return {};
}
