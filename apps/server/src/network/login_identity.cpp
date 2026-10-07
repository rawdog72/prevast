// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "network/login_identity.h"

#include "content/configmanager.h"
#include "gameplay/groups.h"
#include "network/account_ticket.h"
#include "network/serverinfo.h"

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

} // namespace

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
    const std::string& accountTicket, int64_t nowSeconds)
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

	if (identity.accountId == 0) {
		identity.name = stripBadgeGlyphs(identity.name);
	}

	// The emergency key, in both modes.
	if (!password.empty() && password == ConfigManager::getString(ConfigManager::ADMIN_PASSWORD)) {
		identity.groupId = g_groups.highest().id;
		identity.passwordAdmin = true;
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
	fmt::print(">> login identity self-test: {} passed, {} failed\n", passed, failed);
	return failed == 0 ? 0 : 1;
}
