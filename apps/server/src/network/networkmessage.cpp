// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "network/networkmessage.h"

std::string NetworkMessage::getString(uint16_t maxBytes /* = MAX_STRING_BYTES */)
{
	const uint16_t stringLen = get<uint16_t>();
	if (info.readError) {
		return {};
	}

	// A declared length the frame cannot back is a malformed packet, not a short
	// string: refuse it outright rather than returning what happens to be there.
	if (stringLen > maxBytes || !canRead(stringLen)) {
		info.readError = true;
		return {};
	}

	auto it = reinterpret_cast<const char*>(buffer.data()) + info.position;
	info.position += stringLen;

	// Bytes straight through. Both ends speak UTF-8 (the client encodes with
	// TextEncoder), so there is nothing to convert -- and the ISO-8859-1
	// round-trip this replaced destroyed every codepoint above U+00FF, which is
	// most of the alphabets players actually type their nicknames in.
	return std::string{it, stringLen};
}

void NetworkMessage::addString(std::string_view value)
{
	const size_t stringLen = value.size();
	if (stringLen > MAX_STRING_BYTES || !canAdd(stringLen + sizeof(uint16_t))) {
		return;
	}

	add<uint16_t>(static_cast<uint16_t>(stringLen));
	std::memcpy(buffer.data() + info.position, value.data(), stringLen);
	info.position += static_cast<MsgSize_t>(stringLen);
	info.length += static_cast<MsgSize_t>(stringLen);
}
