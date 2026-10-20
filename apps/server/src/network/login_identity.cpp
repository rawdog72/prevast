// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "network/login_identity.h"

#include "content/configmanager.h"
#include "gameplay/groups.h"
#include "network/account_ticket.h"
#include "network/serverinfo.h"
#include "core/tools.h"

namespace {

	// UTF-8 of every glyph badges.ts draws and the look-alikes a guest could
	// type instead. U+FE0F (emoji presentation) is dropped too, so "✔️" goes.
	constexpr std::string_view IDENTITY_BADGE_GLYPHS[] = {
		"\xE2\x9C\x94",     // U+2714 heavy check mark (verified)
		"\xE2\x9C\x93",     // U+2713 check mark
		"\xE2\x98\x91",     // U+2611 ballot box with check
		"\xE2\x9C\x85",     // U+2705 white heavy check mark
		"\xF0\x9F\x97\xB8", // U+1F5F8 light check mark
		"\xE2\x9C\x9A",     // U+271A heavy greek cross (tutor)
		"\xE2\x9C\x99",     // U+2719 outlined greek cross
		"\xE2\x9C\x9B",     // U+271B open centre cross
		"\xE2\x9C\x9C",     // U+271C heavy open centre cross
		"\xE2\x9E\x95",     // U+2795 heavy plus sign
		"\xE2\x97\x86",     // U+25C6 black diamond (gamemaster)
		"\xE2\x97\x87",     // U+25C7 white diamond
		"\xE2\x99\xA6",     // U+2666 black diamond suit
		"\xE2\x99\xA2",     // U+2662 white diamond suit
		"\xE2\xAC\xA5",     // U+2B25 black medium diamond
		"\xE2\xAC\xA6",     // U+2B26 white medium diamond
		"\xE2\x99\x9B",     // U+265B black chess queen (admin)
		"\xE2\x99\x9A",     // U+265A black chess king
		"\xE2\x99\x95",     // U+2655 white chess queen
		"\xE2\x99\x94",     // U+2654 white chess king
		"\xF0\x9F\x91\x91", // U+1F451 crown
		"\xEF\xB8\x8F",     // U+FE0F variation selector-16
	};

	bool identityIsSpace(char c) { return c == ' ' || (c >= '\t' && c <= '\r'); }

	// Every byte is looked at whatever the input, so how long a wrong key
	// takes to refuse says nothing about how much of it was right.
	bool identityConstantTimeEquals(std::string_view a, std::string_view b)
	{
		unsigned char difference = a.size() == b.size() ? 0 : 1;
		const size_t length = std::max(a.size(), b.size());
		for (size_t i = 0; i < length; ++i) {
			const unsigned char x = i < a.size() ? static_cast<unsigned char>(a[i]) : 0;
			const unsigned char y = i < b.size() ? static_cast<unsigned char>(b[i]) : 0;
			difference |= static_cast<unsigned char>(x ^ y);
		}
		return difference == 0;
	}

	struct AdminPasswordFailures
	{
		uint32_t count = 0;
		int64_t windowStart = 0;
	};

	// Dispatcher thread only, like every login.
	std::unordered_map<std::string, AdminPasswordFailures> adminPasswordFailures;
	// Bounds the table. Full after pruning, an address with no history yet is
	// refused rather than forgetting another's failures -- forgetting is what
	// would let a guesser reset its own count.
	constexpr size_t ADMIN_PASSWORD_MAX_TRACKED = 4096;

} // namespace

bool checkAdminPassword(std::string_view supplied, std::string_view expected, std::string_view clientAddress,
    int64_t nowSeconds, std::string& notice)
{
	if (supplied.empty() || expected.empty()) {
		return false;
	}

	const std::string key(clientAddress);
	auto it = adminPasswordFailures.find(key);
	if (it != adminPasswordFailures.end() &&
	    nowSeconds - it->second.windowStart >= ADMIN_PASSWORD_FAILURE_WINDOW_SECONDS) {
		adminPasswordFailures.erase(it);
		it = adminPasswordFailures.end();
	}
	if (it != adminPasswordFailures.end() && it->second.count >= ADMIN_PASSWORD_MAX_FAILURES) {
		notice = "Too many wrong admin passwords from your address. Try again later.";
		return false;
	}

	if (identityConstantTimeEquals(supplied, expected)) {
		if (it != adminPasswordFailures.end()) {
			adminPasswordFailures.erase(it);
		}
		return true;
	}

	if (it == adminPasswordFailures.end()) {
		if (adminPasswordFailures.size() >= ADMIN_PASSWORD_MAX_TRACKED) {
			std::erase_if(adminPasswordFailures, [nowSeconds](const auto& entry) {
				return nowSeconds - entry.second.windowStart >= ADMIN_PASSWORD_FAILURE_WINDOW_SECONDS;
			});
		}
		if (adminPasswordFailures.size() >= ADMIN_PASSWORD_MAX_TRACKED) {
			notice = "Too many wrong admin passwords right now. Try again later.";
			return false;
		}
		it = adminPasswordFailures.emplace(key, AdminPasswordFailures{0, nowSeconds}).first;
	}
	if (++it->second.count == ADMIN_PASSWORD_MAX_FAILURES) {
		fmt::print(fg(fmt::color::orange), ">> [Security] {} wrong admin passwords from {}; refusing its admin "
			"logins for {} minutes.\n", ADMIN_PASSWORD_MAX_FAILURES, key, ADMIN_PASSWORD_FAILURE_WINDOW_SECONDS / 60);
	}
	notice = "Wrong admin password. You joined without admin rights.";
	return false;
}

void clearAdminPasswordFailures() { adminPasswordFailures.clear(); }

std::string ticketServerId(std::string_view listingId, std::string_view host, uint16_t port)
{
	// registry.ts brackets a host for which net.isIP() is 6; every other host
	// it accepts (IPv4, DNS name, already-bracketed IPv6) has no bare ':'.
	const bool bareIpv6 = host.find(':') != std::string_view::npos && !host.starts_with('[');
	std::string id;
	id.reserve(listingId.size() + host.size() + 9);
	id.append(listingId).append("@");
	if (bareIpv6) id.append("[").append(host).append("]");
	else id.append(host);
	id.append(":").append(std::to_string(port));
	return id;
}

std::string stripBadgeGlyphs(std::string_view nickname)
{
	// Byte by byte, dropping a glyph as soon as the output ends in one: the
	// glyphs are whole UTF-8 sequences, so this never splits a character, and
	// a glyph that only forms once another is removed goes too.
	std::string out;
	out.reserve(nickname.size());
	for (const char c : nickname) {
		out.push_back(c);
		for (const std::string_view glyph : IDENTITY_BADGE_GLYPHS) {
			if (out.ends_with(glyph)) {
				out.resize(out.size() - glyph.size());
				break;
			}
		}
	}
	const auto first = std::find_if_not(out.begin(), out.end(), identityIsSpace);
	const auto last = std::find_if_not(out.rbegin(), out.rend(), identityIsSpace).base();
	return first < last ? std::string(first, last) : std::string();
}

LoginIdentity resolveLoginIdentity(const std::string& nickname, const std::string& password,
    const std::string& accountTicket, int64_t nowSeconds, std::string_view clientAddress)
{
	LoginIdentity identity;
	identity.name = nickname;
	identity.groupId = g_groups.defaultGroup().id;

	// ProtocolGame refuses a failed account login before character creation.
	if (!accountTicket.empty()) {
		if (!ConfigManager::getBoolean(ConfigManager::USE_DATABASE)) {
			identity.notice = "Accounts are not enabled on this server.";
		} else {
			AccountTicket::Claims claims;
			const AccountTicket::Result result = AccountTicket::verify(accountTicket,
			    ticketServerId(ServerInfo::getListingId(), ServerInfo::getPublicHost(), ServerInfo::getPublicPort()),
			    nowSeconds, claims);
			if (result == AccountTicket::Result::Ok) {
				identity.accountId = claims.accountId;
				identity.name = claims.name;
				if (ConfigManager::getBoolean(ConfigManager::TRUST_ACCOUNT_GROUPS) && g_groups.get(claims.groupId)) {
					identity.groupId = claims.groupId;
				}
			} else {
				identity.notice = fmt::format("Account not accepted on this server: {}.",
				    AccountTicket::describe(result));
			}
		}
	}

	// Every name the server keeps is printable: it is broadcast to every client
	// and written to the console. A guest's also loses the badge glyphs, which
	// sanitizing first keeps a zero-width character from hiding.
	identity.name = sanitizeDisplayText(identity.name, true);
	if (identity.accountId == 0) {
		identity.name = stripBadgeGlyphs(identity.name);
	}

	// The emergency key, in both modes.
	std::string passwordNotice;
	if (checkAdminPassword(password, ConfigManager::getString(ConfigManager::ADMIN_PASSWORD), clientAddress,
	        nowSeconds, passwordNotice)) {
		identity.groupId = g_groups.highest().id;
		identity.passwordAdmin = true;
	} else if (!passwordNotice.empty()) {
		identity.notice = identity.notice.empty() ? passwordNotice : identity.notice + " " + passwordNotice;
	}
	return identity;
}

int runLoginIdentitySelfTest()
{
	int passed = 0, failed = 0;
	const auto expect = [&](const std::string& got, std::string_view want, std::string_view what) {
		if (got == want) {
			++passed;
		} else {
			++failed;
			fmt::print(">> login identity self-test FAILED: {} gave '{}', expected '{}'\n", what, got, want);
		}
	};
	expect(ticketServerId("srv", "127.0.0.1", 7172), "srv@127.0.0.1:7172", "ticketServerId(IPv4)");
	expect(ticketServerId("srv", "play.example.com", 443), "srv@play.example.com:443", "ticketServerId(name)");
	expect(ticketServerId("srv", "2001:db8::1", 7172), "srv@[2001:db8::1]:7172", "ticketServerId(IPv6)");
	expect(ticketServerId("srv", "[::1]", 7172), "srv@[::1]:7172", "ticketServerId([IPv6])");

	expect(stripBadgeGlyphs("Bob"), "Bob", "stripBadgeGlyphs(plain)");
	expect(stripBadgeGlyphs("Bob \xE2\x9C\x94"), "Bob", "stripBadgeGlyphs(check)");
	expect(stripBadgeGlyphs("\xE2\x99\x9B Adm\xE2\x97\x86in \xE2\x9C\x94\xEF\xB8\x8F"), "Admin", "stripBadgeGlyphs(mixed)");
	expect(stripBadgeGlyphs("\xE2\x9C\xEF\xB8\x8F\x94x"), "x", "stripBadgeGlyphs(split by FE0F)");
	expect(stripBadgeGlyphs("J\xC3\xBCrgen\xF0\x9F\x91\x91"), "J\xC3\xBCrgen", "stripBadgeGlyphs(keeps other UTF-8)");
	expect(stripBadgeGlyphs(" \xE2\x9C\x85 "), "", "stripBadgeGlyphs(only badges)");

	// Names and chat: escapes, controls, bidi and broken UTF-8 go; text stays.
	expect(sanitizeDisplayText("Bob\x1B[2J\r\n\x7F", true), "Bob[2J", "sanitizeDisplayText(controls)");
	expect(sanitizeDisplayText("J\xC3\xBCrgen \xE6\x97\xA5\xF0\x9F\x98\x80", true), "J\xC3\xBCrgen \xE6\x97\xA5\xF0\x9F\x98\x80",
	    "sanitizeDisplayText(keeps UTF-8)");
	expect(sanitizeDisplayText("ab\xE2\x80\xAE" "cd\xC2\x85", true), "abcd", "sanitizeDisplayText(bidi, C1)");
	expect(sanitizeDisplayText("a\xC0\xAF" "b\xED\xA0\x80" "c\xF4\x90\x80\x80" "d\xE2\x82", true), "abcd",
	    "sanitizeDisplayText(overlong, surrogate, >U+10FFFF, truncated)");
	expect(sanitizeDisplayText("Ad\xE2\x80\x8Bmin", true), "Admin", "sanitizeDisplayText(zero-width in a name)");
	expect(sanitizeDisplayText("\xF0\x9F\x91\xA8\xE2\x80\x8D\xF0\x9F\x91\xA9", false), "\xF0\x9F\x91\xA8\xE2\x80\x8D\xF0\x9F\x91\xA9",
	    "sanitizeDisplayText(ZWJ kept in chat)");
	expect(stripBadgeGlyphs(sanitizeDisplayText("Bob\xE2\x80\x8B\xE2\x9C\x94\xE2\x80\x8B", true)), "Bob",
	    "stripBadgeGlyphs after sanitize (no zero-width left beside a badge)");

	// The admin key: right, wrong, throttled, and per address.
	const auto check = [](std::string_view supplied, std::string_view address, int64_t now) {
		std::string notice;
		const bool accepted = checkAdminPassword(supplied, "s3cret-key", address, now, notice);
		return std::string(accepted ? "ok" : "refused") + (notice.empty() ? "" : " (notice)");
	};
	clearAdminPasswordFailures();
	expect(check("s3cret-key", "10.0.0.1", 1000), "ok", "checkAdminPassword(right)");
	expect(check("", "10.0.0.1", 1000), "refused", "checkAdminPassword(none supplied)");
	{
		std::string notice;
		expect(checkAdminPassword("anything", "", "10.0.0.1", 1000, notice) ? "ok" : "refused", "refused",
		    "checkAdminPassword(no key configured)");
	}
	expect(check("s3cret-ke", "10.0.0.1", 1000), "refused (notice)", "checkAdminPassword(prefix)");
	expect(check("s3cret-key!", "10.0.0.1", 1000), "refused (notice)", "checkAdminPassword(longer)");
	for (uint32_t i = 2; i < ADMIN_PASSWORD_MAX_FAILURES; ++i) check("wrong", "10.0.0.1", 1000);
	expect(check("s3cret-key", "10.0.0.1", 1001), "refused (notice)", "checkAdminPassword(throttled even when right)");
	expect(check("s3cret-key", "10.0.0.2", 1001), "ok", "checkAdminPassword(another address unaffected)");
	expect(check("s3cret-key", "10.0.0.1", 1000 + ADMIN_PASSWORD_FAILURE_WINDOW_SECONDS), "ok",
	    "checkAdminPassword(window passed)");
	clearAdminPasswordFailures();

	fmt::print(">> login identity self-test: {} passed, {} failed\n", passed, failed);
	return failed == 0 ? 0 : 1;
}
