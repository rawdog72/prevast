// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/server/src/network/account_ticket.h
#ifndef PREVAST_ACCOUNT_TICKET_H
#define PREVAST_ACCOUNT_TICKET_H

#include <cstdint>
#include <string>
#include <string_view>

// Game login tickets signed by the web host (apps/web/src/accounts/tickets.ts):
//
//     base64url("1|accountId|name|groupId|serverId|expiresAt|nonce") "." base64url(sig)
//
// sig is ECDSA P-256 over SHA-256 of the payload, raw r||s. Verification needs
// only the web host's public key (config accountPublicKey), so login never
// waits on the web host. Called on the dispatcher thread only.
namespace AccountTicket {

	struct Claims {
		uint32_t accountId = 0;
		std::string name;
		uint8_t groupId = 1;
		std::string serverId;
		int64_t expiresAt = 0; // unix seconds
		std::string nonce;
	};

	enum class Result : uint8_t {
		Ok,
		NoKey,
		Malformed,
		BadSignature,
		WrongServer,
		Expired,
		FarFuture,
		Replayed,
		ReplayCacheFull,
	};

	// base64 of the 65-byte uncompressed point. False (and the old key kept)
	// when it is not one.
	bool setPublicKey(std::string_view base64Raw);
	bool hasPublicKey();

	Result verify(std::string_view ticket, std::string_view serverId, int64_t nowSeconds, Claims& out);

	// "Ok", "Expired", ... -- the fixture file's vocabulary.
	const char* code(Result result);
	// A sentence fragment for the player: "the ticket expired (check your clock)".
	const char* describe(Result result);

	void clearReplayCache();

	// Runs <fixtureDir>/tickets.txt (see tools/accounts/make-ticket-fixtures.ts).
	// 0 when every case gives its expected result.
	int runSelfTest(const std::string& fixtureDir);

} // namespace AccountTicket

#endif
