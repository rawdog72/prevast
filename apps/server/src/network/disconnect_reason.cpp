// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "network/disconnect_reason.h"

#include "network/networkmessage.h"

void writeDisconnectReason(NetworkMessage& msg, DisconnectReason reason, std::string_view detail)
{
	msg.addByte(static_cast<uint8_t>(ServerOpcode::DISCONNECT_REASON));
	msg.addByte(static_cast<uint8_t>(reason));
	msg.addString(detail);
}

int runDisconnectReasonSelfTest()
{
	int failed = 0;
	const auto check = [&](bool ok, std::string_view what) {
		if (!ok) {
			++failed;
			fmt::print(">> disconnect reason self-test FAILED: {}\n", what);
		}
	};

	NetworkMessage msg;
	writeDisconnectReason(msg, DisconnectReason::IP_BANNED, "ab");
	const uint8_t* body = msg.getBuffer() + NetworkMessage::INITIAL_BUFFER_POSITION;
	check(msg.getLength() == 6, "length is opcode + reason + u16 + 2 detail bytes");
	check(body[0] == 99, "opcode byte is 99");
	check(body[1] == 7, "reason byte is IP_BANNED (7)");
	check(body[2] == 2 && body[3] == 0, "detail length is a little-endian u16");
	check(body[4] == 'a' && body[5] == 'b', "detail bytes follow the length");

	NetworkMessage empty;
	writeDisconnectReason(empty, DisconnectReason::SERVER_FULL, {});
	check(empty.getLength() == 4, "an empty detail is a zero-length string");

	fmt::print(">> disconnect reason self-test: {}\n", failed == 0 ? "passed" : "FAILED");
	return failed == 0 ? 0 : 1;
}
