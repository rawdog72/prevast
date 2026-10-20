// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef PREVAST_LOGIN_IDENTITY_H
#define PREVAST_LOGIN_IDENTITY_H

#include <cstdint>
#include <string>
#include <string_view>

// Who a login is: the name it plays under, the account it proved (0 = guest)
// and its group. Resolved once, before any gate that depends on the group
// (a closed or full server lets alwaysLogin groups through).
struct LoginIdentity {
	uint32_t accountId = 0;
	std::string name;
	uint8_t groupId = 1;
	bool passwordAdmin = false;
	// Refusal detail when an account ticket or the admin password was not
	// accepted.
	std::string notice;
};

// `clientAddress` keys the admin password's failure throttle (see
// checkAdminPassword): the connection's canonical IPv4 address, or its IPv6 /64.
LoginIdentity resolveLoginIdentity(const std::string& nickname, const std::string& password,
    const std::string& accountTicket, int64_t nowSeconds, std::string_view clientAddress);

// Whether `supplied` is the emergency admin key `expected` (adminPassword).
//
// A wrong key costs the address one of ADMIN_PASSWORD_MAX_FAILURES tries per
// ADMIN_PASSWORD_FAILURE_WINDOW_SECONDS; once they are spent, keys from that
// address are not compared at all until the window passes, so the key cannot
// be guessed at the speed logins arrive. The comparison does not stop at the
// first differing byte. `notice` is set when the key is refused.
inline constexpr uint32_t ADMIN_PASSWORD_MAX_FAILURES = 5;
inline constexpr int64_t ADMIN_PASSWORD_FAILURE_WINDOW_SECONDS = 15 * 60;
bool checkAdminPassword(std::string_view supplied, std::string_view expected, std::string_view clientAddress,
    int64_t nowSeconds, std::string& notice);
void clearAdminPasswordFailures();

// The server id a login ticket must carry to be accepted here:
// "<listingId>@<host>:<port>", with host and port exactly as the listing
// heartbeat reports them and a bare IPv6 literal bracketed the way the web
// host's registry stores it. The web host signs the address its registry holds
// for the id, so a server that heartbeats someone else's listing id from its
// own address only ever receives tickets the real server refuses.
std::string ticketServerId(std::string_view listingId, std::string_view host, uint16_t port);

// A guest's nickname without the glyphs the client draws as badges (and their
// look-alikes, plus U+FE0F), trimmed; empty if nothing is left (a nameless guest). Only
// verified accounts may look verified or staff.
std::string stripBadgeGlyphs(std::string_view nickname);

// Checks ticketServerId, stripBadgeGlyphs and checkAdminPassword; part of
// prevast_server --selftest.
// 0 when every case passes.
int runLoginIdentitySelfTest();

#endif
