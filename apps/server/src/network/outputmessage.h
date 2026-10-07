// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_OUTPUTMESSAGE_H
#define FS_OUTPUTMESSAGE_H

#include "network/connection.h"
#include "network/networkmessage.h"
#include "core/tools.h"

class OutputMessage : public NetworkMessage
{
public:
	// User-PROVIDED on purpose -- do NOT change this back to `= default`.
	// make_output_message() constructs these through std::allocate_shared, which
	// VALUE-initializes: for a class whose default constructor is defaulted on
	// its first declaration, value-init zero-initializes the whole object first.
	// That is a 24,590-byte memset on every outgoing frame (the inherited
	// NetworkMessage::buffer), paid ~5,000 times a second at 255 clients and far
	// more when a crowd generates broadcast frames. A user-provided constructor
	// makes it default-init instead; the buffer is always written before it is
	// read (length is tracked separately in `info`).
	OutputMessage() {}

	// non-copyable
	OutputMessage(const OutputMessage&) = delete;
	OutputMessage& operator=(const OutputMessage&) = delete;

	uint8_t* getOutputBuffer() { return &buffer[outputBufferStart]; }

	void writeMessageLength() { add_header(info.length); }

	// Bounds-checked because these are no longer one-shot: ProtocolGame packs
	// several messages into one buffer, so a caller that mis-sizes its capacity
	// check would run straight off the end of `buffer` here.
	void append(const NetworkMessage& msg) { appendBytes(msg.getBuffer() + INITIAL_BUFFER_POSITION, msg.getLength()); }

	void append(const OutputMessage_ptr& msg)
	{
		appendBytes(msg->getBuffer() + INITIAL_BUFFER_POSITION, msg->getLength());
	}

	void appendBytes(const uint8_t* data, MsgSize_t count)
	{
		if (count == 0 || !canFit(count)) {
			return;
		}
		std::memcpy(buffer.data() + info.position, data, count);
		info.length += count;
		info.position += count;
	}

	// Room left before NetworkMessage::canAdd would start silently dropping.
	bool canFit(size_t count) const
	{
		return static_cast<size_t>(info.position) + count < static_cast<size_t>(MAX_BODY_LENGTH);
	}

	// Drop `count` bytes from the front of the frame. Used to unwrap a batch
	// envelope that ended up carrying one message, so it goes out on the wire
	// exactly as it would have unbatched.
	void skipLeadingBytes(MsgSize_t count)
	{
		assert(count <= info.length);
		outputBufferStart += count;
		info.length -= count;
	}

	void setSequenceId(uint32_t sequence) { sequenceId = sequence; }
	uint32_t getSequenceId() const { return sequenceId; }

private:
	template <typename T>
	void add_header(T add)
	{
		assert(outputBufferStart >= sizeof(T));
		outputBufferStart -= sizeof(T);
		std::memcpy(buffer.data() + outputBufferStart, &add, sizeof(T));
		// added header size to the message size
		info.length += sizeof(T);
	}

	MsgSize_t outputBufferStart = INITIAL_BUFFER_POSITION;
	// Explicit initialiser: with the user-provided constructor above, value-init
	// no longer zeroes this for free. (Nothing reads it today -- the two
	// accessors have no callers -- but an uninitialised member is a trap.)
	uint32_t sequenceId = 0;
};

namespace tfs::net {

	OutputMessage_ptr make_output_message();
	void insert_protocol_to_autosend(const Protocol_ptr& protocol);
	void remove_protocol_from_autosend(const Protocol_ptr& protocol);

} // namespace tfs::net

#endif // FS_OUTPUTMESSAGE_H
