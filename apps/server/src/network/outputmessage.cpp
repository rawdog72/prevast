// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "network/outputmessage.h"

#include "core/lockfree.h"
#include "network/protocol.h"
#include "core/scheduler.h"

extern Scheduler g_scheduler;

namespace {

	const uint16_t OUTPUTMESSAGE_FREE_LIST_CAPACITY = 2048;
	const std::chrono::milliseconds OUTPUTMESSAGE_AUTOSEND_DELAY{ 10 };

	// NOTE: A vector is used here because this container is mostly read and relatively rarely modified (only when a
	// client connects/disconnects)
	std::vector<Protocol_ptr> bufferedProtocols;

	// Is a sendAll link already in flight?
	//
	// Without this the chain could FORK. sendAll only stops the chain when the
	// list is empty at the moment it fires, while insert_protocol_to_autosend
	// started a fresh one whenever the list was empty at insert time -- so a
	// list that drained to zero and refilled inside the same 10 ms window left
	// the pending link alive AND started another. Every later drain/refill
	// doubled the count again, permanently, and each surviving chain walks every
	// buffered protocol every 10 ms. Emptying and refilling the server is
	// exactly what a bot fleet does between stress runs, so this compounded
	// across a testing session with no way to see it.
	//
	// Everything here runs on the dispatcher thread (sendAll arrives as a
	// scheduler task, insert/remove are called from login and release), so a
	// plain bool is the whole synchronisation story.
	bool sendAllScheduled = false;

	void sendAll();

	void scheduleSendAll()
	{
		sendAllScheduled = true;
		g_scheduler.addEvent(createSchedulerTask(OUTPUTMESSAGE_AUTOSEND_DELAY.count(), []() { sendAll(); }));
	}

	void sendAll()
	{
		// dispatcher thread
		sendAllScheduled = false;

		for (auto& protocol : bufferedProtocols) {
			// Bounds how long a batched message can sit unsent. The tick already
			// flushes what it produced; this covers messages generated between
			// ticks by packet handlers, which would otherwise wait for the next
			// one. See ProtocolGame::flushOutputBatch.
			protocol->flushOutputBatch();

			if (auto& msg = protocol->getCurrentBuffer()) {
				protocol->send(std::move(msg));
			}
		}

		if (!bufferedProtocols.empty()) {
			scheduleSendAll();
		}
	}

} // namespace

OutputMessage_ptr tfs::net::make_output_message()
{
	// LockfreePoolingAllocator<void,...> will leave (void* allocate) ill-formed because of sizeof(T), so this
	// guarantees that only one list will be initialized
	return std::allocate_shared<OutputMessage>(LockfreePoolingAllocator<void, OUTPUTMESSAGE_FREE_LIST_CAPACITY>());
}

void tfs::net::insert_protocol_to_autosend(const Protocol_ptr& protocol)
{
	// dispatcher thread
	//
	// Keyed on "is a chain already running", NOT on "is the list empty" -- see
	// sendAllScheduled. The old test forked the chain whenever the list drained
	// and refilled inside one 10 ms window.
	if (!sendAllScheduled) {
		scheduleSendAll();
	}
	bufferedProtocols.emplace_back(protocol);
}

void tfs::net::remove_protocol_from_autosend(const Protocol_ptr& protocol)
{
	// dispatcher thread
	auto it = std::find(bufferedProtocols.begin(), bufferedProtocols.end(), protocol);
	if (it != bufferedProtocols.end()) {
		std::swap(*it, bufferedProtocols.back());
		bufferedProtocols.pop_back();
	}
}
