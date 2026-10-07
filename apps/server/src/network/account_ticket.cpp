// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/server/src/network/account_ticket.cpp
#include "core/otpch.h"

#include "network/account_ticket.h"

#include "core/definitions.h"

#include <bcrypt.h>
#pragma comment(lib, "bcrypt.lib")

#include <array>
#include <charconv>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <unordered_map>
#include <vector>

namespace {

	// Clocks drift; a ticket is good for 30 s past its expiry. And a ticket
	// that claims to live longer than the web host ever issues is refused, so
	// a leaked signing key cannot mint long-lived tickets without it showing.
	constexpr int64_t CLOCK_SKEW_SECONDS = 30;
	constexpr int64_t MAX_LIFETIME_SECONDS = 120;
	// Over the cap new tickets are refused rather than old nonces forgotten:
	// forgetting is what would let a captured ticket replay.
	constexpr size_t MAX_NONCES = 65536;

	BCRYPT_ALG_HANDLE ecdsaAlgorithm = nullptr;
	BCRYPT_ALG_HANDLE sha256Algorithm = nullptr;
	BCRYPT_KEY_HANDLE publicKey = nullptr;
	std::unordered_map<std::string, int64_t> seenNonces; // nonce -> forget after

	// Accepts both alphabets (+/ and -_), with or without '=' padding.
	bool decodeBase64(std::string_view in, std::string& out)
	{
		out.clear();
		while (!in.empty() && in.back() == '=') in.remove_suffix(1);
		uint32_t buffer = 0;
		int bits = 0;
		for (const char c : in) {
			uint32_t value;
			if (c >= 'A' && c <= 'Z') value = static_cast<uint32_t>(c - 'A');
			else if (c >= 'a' && c <= 'z') value = static_cast<uint32_t>(c - 'a' + 26);
			else if (c >= '0' && c <= '9') value = static_cast<uint32_t>(c - '0' + 52);
			else if (c == '+' || c == '-') value = 62;
			else if (c == '/' || c == '_') value = 63;
			else return false;
			buffer = (buffer << 6) | value;
			bits += 6;
			if (bits >= 8) {
				bits -= 8;
				out.push_back(static_cast<char>((buffer >> bits) & 0xFF));
			}
		}
		return bits < 6; // one dangling sextet is not base64
	}

	bool parseUnsigned(std::string_view text, uint64_t max, uint64_t& out)
	{
		if (text.empty() || text.size() > 20) return false;
		const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), out);
		return error == std::errc() && end == text.data() + text.size() && out <= max;
	}

	bool parsePayload(std::string_view payload, AccountTicket::Claims& claims)
	{
		std::array<std::string_view, 7> field;
		size_t start = 0;
		for (size_t i = 0; i < field.size(); ++i) {
			const size_t bar = payload.find('|', start);
			const bool last = i + 1 == field.size();
			if (last != (bar == std::string_view::npos)) return false;
			field[i] = payload.substr(start, last ? std::string_view::npos : bar - start);
			start = bar + 1;
		}
		uint64_t accountId = 0, groupId = 0, expiresAt = 0;
		if (field[0] != "1") return false;
		if (!parseUnsigned(field[1], UINT32_MAX, accountId) || accountId == 0) return false;
		if (field[2].empty() || field[2].size() > 16) return false;
		if (!parseUnsigned(field[3], 255, groupId) || groupId == 0) return false;
		if (field[4].empty() || field[6].empty()) return false;
		if (!parseUnsigned(field[5], static_cast<uint64_t>(INT64_MAX), expiresAt)) return false;
		claims.accountId = static_cast<uint32_t>(accountId);
		claims.name = std::string(field[2]);
		claims.groupId = static_cast<uint8_t>(groupId);
		claims.serverId = std::string(field[4]);
		claims.expiresAt = static_cast<int64_t>(expiresAt);
		claims.nonce = std::string(field[6]);
		return true;
	}

	bool signatureValid(std::string_view payload, const std::string& signature)
	{
		// core/definitions.h pins _WIN32_WINNT to 0x0602, which hides the
		// Windows 10 BCRYPT_SHA256_ALG_HANDLE pseudo-handle and the one-shot
		// BCryptHash helper (the SDK has both), so a real provider is opened
		// once and the classic create/hash/finish/destroy sequence is used.
		if (!sha256Algorithm &&
		    !BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&sha256Algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0))) {
			sha256Algorithm = nullptr;
			return false;
		}
		BCRYPT_HASH_HANDLE hash = nullptr;
		if (!BCRYPT_SUCCESS(BCryptCreateHash(sha256Algorithm, &hash, nullptr, 0, nullptr, 0, 0))) return false;
		std::array<UCHAR, 32> digest{};
		const bool hashed = BCRYPT_SUCCESS(BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(payload.data())),
		                        static_cast<ULONG>(payload.size()), 0)) &&
		    BCRYPT_SUCCESS(BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0));
		BCryptDestroyHash(hash);
		if (!hashed) return false;
		return BCRYPT_SUCCESS(BCryptVerifySignature(publicKey, nullptr, digest.data(), static_cast<ULONG>(digest.size()),
		    reinterpret_cast<PUCHAR>(const_cast<char*>(signature.data())), static_cast<ULONG>(signature.size()), 0));
	}

	void forgetExpiredNonces(int64_t now)
	{
		for (auto it = seenNonces.begin(); it != seenNonces.end();) {
			if (it->second < now) it = seenNonces.erase(it);
			else ++it;
		}
	}

} // namespace

namespace AccountTicket {

	bool setPublicKey(std::string_view base64Raw)
	{
		std::string raw;
		if (!decodeBase64(base64Raw, raw) || raw.size() != 65 || static_cast<uint8_t>(raw[0]) != 0x04) {
			return false;
		}
		if (!ecdsaAlgorithm &&
		    !BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&ecdsaAlgorithm, BCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0))) {
			ecdsaAlgorithm = nullptr;
			return false;
		}
		std::vector<UCHAR> blob(sizeof(BCRYPT_ECCKEY_BLOB) + 64);
		auto* header = reinterpret_cast<BCRYPT_ECCKEY_BLOB*>(blob.data());
		header->dwMagic = BCRYPT_ECDSA_PUBLIC_P256_MAGIC;
		header->cbKey = 32;
		std::memcpy(blob.data() + sizeof(BCRYPT_ECCKEY_BLOB), raw.data() + 1, 64);
		BCRYPT_KEY_HANDLE key = nullptr;
		if (!BCRYPT_SUCCESS(BCryptImportKeyPair(ecdsaAlgorithm, nullptr, BCRYPT_ECCPUBLIC_BLOB, &key, blob.data(),
		        static_cast<ULONG>(blob.size()), 0))) {
			return false;
		}
		if (publicKey) BCryptDestroyKey(publicKey);
		publicKey = key;
		return true;
	}

	bool hasPublicKey() { return publicKey != nullptr; }

	Result verify(std::string_view ticket, std::string_view serverId, int64_t now, Claims& out)
	{
		if (!publicKey) return Result::NoKey;
		if (ticket.empty() || ticket.size() > MAX_ACCOUNT_TICKET_LENGTH) return Result::Malformed;
		const size_t dot = ticket.find('.');
		if (dot == std::string_view::npos || ticket.find('.', dot + 1) != std::string_view::npos) return Result::Malformed;

		std::string payload, signature;
		if (!decodeBase64(ticket.substr(0, dot), payload) || !decodeBase64(ticket.substr(dot + 1), signature) ||
		    payload.empty() || signature.size() != 64) {
			return Result::Malformed;
		}
		// Signature first: nothing in an unsigned payload is worth parsing.
		if (!signatureValid(payload, signature)) return Result::BadSignature;

		Claims claims;
		if (!parsePayload(payload, claims)) return Result::Malformed;
		if (claims.serverId != serverId) return Result::WrongServer;
		if (now > claims.expiresAt + CLOCK_SKEW_SECONDS) return Result::Expired;
		if (claims.expiresAt > now + MAX_LIFETIME_SECONDS) return Result::FarFuture;

		if (seenNonces.contains(claims.nonce)) return Result::Replayed;
		if (seenNonces.size() >= MAX_NONCES) {
			forgetExpiredNonces(now);
			if (seenNonces.size() >= MAX_NONCES) return Result::ReplayCacheFull;
		}
		seenNonces.emplace(claims.nonce, claims.expiresAt + CLOCK_SKEW_SECONDS);
		out = std::move(claims);
		return Result::Ok;
	}

	const char* code(Result result)
	{
		switch (result) {
			case Result::Ok: return "Ok";
			case Result::NoKey: return "NoKey";
			case Result::Malformed: return "Malformed";
			case Result::BadSignature: return "BadSignature";
			case Result::WrongServer: return "WrongServer";
			case Result::Expired: return "Expired";
			case Result::FarFuture: return "FarFuture";
			case Result::Replayed: return "Replayed";
			case Result::ReplayCacheFull: return "ReplayCacheFull";
		}
		return "Unknown";
	}

	const char* describe(Result result)
	{
		switch (result) {
			case Result::Ok: return "ok";
			case Result::NoKey: return "this server has no account key configured";
			case Result::Malformed: return "the login ticket is damaged";
			case Result::BadSignature: return "the login ticket was not issued by this server's account service";
			case Result::WrongServer: return "the login ticket is for another server";
			case Result::Expired: return "the login ticket expired (check your clock)";
			case Result::FarFuture: return "the login ticket is dated in the future (check the server clock)";
			case Result::Replayed: return "the login ticket was already used";
			case Result::ReplayCacheFull: return "too many logins right now, try again shortly";
		}
		return "unknown ticket problem";
	}

	void clearReplayCache() { seenNonces.clear(); }

	int runSelfTest(const std::string& fixtureDir)
	{
		const std::filesystem::path file = std::filesystem::path(fixtureDir) / "tickets.txt";
		std::ifstream in(file);
		if (!in) {
			fmt::print(">> ticket self-test: cannot open {}\n", file.string());
			return 1;
		}
		int passed = 0, failed = 0;
		if (setPublicKey("AAAA")) {
			fmt::print(">> ticket self-test FAILED: accepted a malformed public key\n");
			++failed;
		}
		clearReplayCache();
		std::string line;
		while (std::getline(in, line)) {
			if (!line.empty() && line.back() == '\r') line.pop_back();
			if (line.empty() || line[0] == '#') continue;
			std::istringstream fields(line);
			std::string expected, serverId, now, ticket;
			fields >> expected >> serverId;
			if (expected == "key") {
				if (!setPublicKey(serverId)) {
					fmt::print(">> ticket self-test FAILED: fixture public key rejected\n");
					return 1;
				}
				continue;
			}
			fields >> now >> ticket;
			Claims claims;
			const Result result = verify(ticket, serverId, std::stoll(now), claims);
			if (expected == code(result)) {
				++passed;
			} else {
				++failed;
				fmt::print(">> ticket self-test FAILED: expected {} got {} for {}...\n", expected, code(result),
				    ticket.substr(0, 32));
			}
		}
		fmt::print(">> ticket self-test: {} passed, {} failed\n", passed, failed);
		return failed == 0 && passed > 0 ? 0 : 1;
	}

} // namespace AccountTicket
