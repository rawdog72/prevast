// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_NETWORKMESSAGE_H
#define FS_NETWORKMESSAGE_H

#include "core/const.h"

class NetworkMessage
{
public:
	using MsgSize_t = uint16_t;
	// Headers:
	// 2 bytes for unencrypted message size
	// 4 bytes for checksum
	// 2 bytes for encrypted message size
	static constexpr MsgSize_t INITIAL_BUFFER_POSITION = 8;
	enum
	{
		HEADER_LENGTH = 2
	};
	enum
	{
		CHECKSUM_LENGTH = 4
	};
	enum
	{
		XTEA_MULTIPLE = 8
	};
	enum
	{
		MAX_BODY_LENGTH = NETWORKMESSAGE_MAXSIZE - HEADER_LENGTH - CHECKSUM_LENGTH - XTEA_MULTIPLE
	};
	enum
	{
		MAX_PROTOCOL_BODY_LENGTH = MAX_BODY_LENGTH - 10
	};

	NetworkMessage() = default;

	void reset() { info = {}; }

	// The largest string this protocol will carry in either direction. Well
	// above any real nickname, chat line or clan name, and far below the frame
	// budget, so it bounds an attacker without ever bounding a player.
	static constexpr uint16_t MAX_STRING_BYTES = 8192;

	// --- Reading ------------------------------------------------------------
	//
	// A read past the end of the frame returns 0 AND latches `readError`. The
	// zero on its own is not a usable signal: 0 is a legal value for every field
	// on this wire (slot 0, pid 0, count 0), so a truncated packet used to
	// decode into a perfectly plausible command. Callers must gate their side
	// effects on `hasReadError()` -- or, better, size-check the whole payload up
	// front (see ProtocolGame::parsePacket, which does exactly that).
	uint8_t getByte()
	{
		if (!canRead(1)) {
			info.readError = true;
			return 0;
		}

		return buffer[info.position++];
	}

	uint8_t peekByte() const
	{
		if (!canRead(1)) {
			return 0;
		}
		return buffer[info.position];
	}

	template <typename T>
	std::enable_if_t<std::is_trivially_copyable_v<T>, T> get() noexcept
	{
		static_assert(std::is_trivially_constructible_v<T>, "Destination type must be trivially constructible");

		if (!canRead(sizeof(T))) {
			info.readError = true;
			return {};
		}

		T value;
		std::memcpy(&value, buffer.data() + info.position, sizeof(T));
		info.position += sizeof(T);
		return value;
	}

	// UTF-8, length-prefixed: [u16 byteLength][bytes]. No transcoding -- the
	// client is a browser and both ends speak UTF-8 (TextEncoder/TextDecoder).
	// This used to round-trip through ISO-8859-1, which silently mangled any
	// nickname or chat line outside latin1.
	//
	// `maxBytes` is a hard cap, not a hint: a string longer than it is a
	// protocol violation and latches `readError` rather than being truncated,
	// because a truncated nickname is still a nickname and would be stored.
	std::string getString(uint16_t maxBytes = 8192);

	// Did any read run off the end (or violate a declared limit)?
	bool hasReadError() const { return info.readError; }

	// Bytes not yet consumed. Zero after a well-formed packet is fully decoded;
	// anything left over means the sender's layout disagrees with ours.
	MsgSize_t getRemainingLength() const
	{
		const MsgSize_t end = INITIAL_BUFFER_POSITION + info.length;
		return info.position >= end ? 0 : static_cast<MsgSize_t>(end - info.position);
	}

	// simply write functions for outgoing message
	void addByte(uint8_t value)
	{
		if (!canAdd(1)) {
			return;
		}

		buffer[info.position++] = value;
		info.length++;
	}

	template <typename T>
	void add(T value)
	{
		if (!canAdd(sizeof(T))) {
			return;
		}

		std::memcpy(buffer.data() + info.position, &value, sizeof(T));
		info.position += sizeof(T);
		info.length += sizeof(T);
	}


	// [u16 byteLength][UTF-8 bytes]. Silently writes nothing if the string does
	// not fit -- same contract as add()/addByte() above, and the senders are all
	// server-controlled content whose sizes are bounded at their source.
	void addString(std::string_view value);

	MsgSize_t getLength() const { return info.length; }

	bool isEmpty() const { return info.length == 0; }

	void setLength(MsgSize_t newLength) { info.length = newLength; }

	bool setBufferPosition(MsgSize_t pos)
	{
		if (pos < NETWORKMESSAGE_MAXSIZE - INITIAL_BUFFER_POSITION) {
			info.position = pos + INITIAL_BUFFER_POSITION;
			return true;
		}
		return false;
	}

	uint8_t* getBuffer() { return &buffer[0]; }

	const uint8_t* getBuffer() const { return &buffer[0]; }

protected:
	struct NetworkMessageInfo
	{
		MsgSize_t length = 0;
		MsgSize_t position = INITIAL_BUFFER_POSITION;
		// Latched, never cleared by a subsequent successful read: once a frame
		// has been mis-parsed, everything decoded after that point is suspect
		// too, so the flag has to survive to the end of the packet.
		bool readError = false;
	};

	NetworkMessageInfo info;
	std::array<uint8_t, NETWORKMESSAGE_MAXSIZE> buffer;

private:
	// `<=`, not `<`: writing exactly up to the capacity is legal. The old `<`
	// dropped the final byte of a maximum-size message rather than the first
	// byte past it, which is the kind of off-by-one that only shows up on the
	// one packet a year that happens to be exactly full.
	bool canAdd(size_t size) const
	{
		return size + static_cast<size_t>(info.position) <= static_cast<size_t>(MAX_BODY_LENGTH);
	}

	// The readable window is [INITIAL_BUFFER_POSITION, INITIAL_BUFFER_POSITION +
	// length). Spelled with the constant rather than the literal 8 it replaces,
	// and in size_t so a large `size` cannot wrap the comparison.
	bool canRead(size_t size) const
	{
		return static_cast<size_t>(info.position) + size <=
		       static_cast<size_t>(INITIAL_BUFFER_POSITION) + static_cast<size_t>(info.length);
	}
};

#endif // FS_NETWORKMESSAGE_H
