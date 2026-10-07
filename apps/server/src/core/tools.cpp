// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "core/tools.h"
#include "content/configmanager.h"

#include <chrono>
#ifdef _WIN32
#include <windows.h>
#include <bcrypt.h>
#pragma comment(lib, "bcrypt.lib")
#else
#include <fstream>
#endif

std::string makeGuestSessionToken()
{
	std::array<unsigned char, 16> bytes{};
#ifdef _WIN32
	if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
		throw std::runtime_error("Guest credential entropy unavailable");
#else
	std::ifstream random("/dev/urandom", std::ios::binary);
	if (!random.read(reinterpret_cast<char*>(bytes.data()), bytes.size()))
		throw std::runtime_error("Guest credential entropy unavailable");
#endif
	constexpr char hex[] = "0123456789abcdef";
	std::string token;
	token.reserve(bytes.size() * 2);
	for (auto byte : bytes) { token += hex[byte >> 4]; token += hex[byte & 15]; }
	return token;
}

namespace {

// tolower is UB on a negative int, which signed char gives for any UTF-8 byte.
char asciiLower(char c) { return static_cast<char>(std::tolower(static_cast<unsigned char>(c))); }

} // namespace

std::vector<std::string_view> explodeString(std::string_view inString, const std::string& separator,
	int32_t limit /* = -1*/)
{
	std::vector<std::string_view> returnVector;
	std::string_view::size_type start = 0, end = 0;

	while (--limit != -1 && (end = inString.find(separator, start)) != std::string_view::npos) {
		returnVector.push_back(inString.substr(start, end - start));
		start = end + separator.size();
	}

	returnVector.push_back(inString.substr(start));
	return returnVector;
}

std::mt19937& getRandomGenerator()
{
	static std::random_device rd;
	static std::mt19937 generator(rd());
	return generator;
}

namespace {
	// The seed both RNGs in the process are currently running from. World
	// generation is entirely rand()/mt19937 driven, so this one number is what
	// makes a world reproducible -- and what !seed reports and !seed=<n> sets.
	uint32_t worldSeed = 0;
}

uint32_t getWorldSeed() { return worldSeed; }

bool isWorldSeedPinned()
{
	return ConfigManager::getNumber(ConfigManager::WORLD_SEED) != 0;
}

uint32_t rollWorldSeed()
{
	const int32_t configured = ConfigManager::getNumber(ConfigManager::WORLD_SEED);
	if (configured != 0) {
		return static_cast<uint32_t>(configured);
	}

	// The clock. Not getRandomGenerator(), deliberately: that generator is
	// itself seeded from the value being chosen here, so drawing the next seed
	// from it would make a chain of worlds a deterministic sequence off the
	// first one -- which is the opposite of what an unpinned seed promises.
	uint32_t seed = static_cast<uint32_t>(OTSYS_TIME());
	if (seed == 0) {
		seed = 1; // 0 is the "unset" sentinel in config.lua
	}
	return seed;
}

void seedRandomGenerator(uint32_t seed)
{
	// Called right after config load when `seed` is set, so that both RNGs
	// in the process (this one and the C rand() used by resource spawning) are
	// reproducible. Deliberately a reseed of the existing generator rather than
	// seeding at construction: the static above is initialised on first use,
	// which can happen before the config has been read.
	//
	// srand comes along too. The two used to be seeded separately by the caller,
	// which meant a !seed regeneration could pin one and forget the other and
	// produce a world that was only half reproducible.
	worldSeed = seed;
	std::srand(seed);
	getRandomGenerator().seed(seed);
}

int32_t uniform_random(int32_t minNumber, int32_t maxNumber)
{
	static std::uniform_int_distribution<int32_t> uniformRand;
	if (minNumber == maxNumber) {
		return minNumber;
	}
	else if (minNumber > maxNumber) {
		std::swap(minNumber, maxNumber);
	}
	return uniformRand(getRandomGenerator(), std::uniform_int_distribution<int32_t>::param_type(minNumber, maxNumber));
}

std::string formatDateShort(time_t time)
{
	return std::format("{:%d %b %Y}", std::chrono::system_clock::from_time_t(time));
}


bool booleanString(std::string_view str)
{
	if (str.empty()) {
		return false;
	}

	char ch = asciiLower(str.front());
	return ch != 'f' && ch != 'n' && ch != '0';
}


std::string truncateUtf8(std::string str, size_t maxLength)
{
	if (str.size() <= maxLength) {
		return str;
	}

	size_t cut = maxLength;
	// Back up over UTF-8 continuation bytes so the cut lands on a boundary.
	while (cut > 0 && (static_cast<unsigned char>(str[cut]) & 0xC0) == 0x80) {
		--cut;
	}
	str.resize(cut);
	return str;
}

int64_t OTSYS_TIME()
{
	return duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string contentFile(std::string_view name)
{
	static const std::string root = [] {
		std::string dir = getString(ConfigManager::CONTENT_PATH);
		while (!dir.empty() && (dir.back() == '/' || dir.back() == '\\')) {
			dir.pop_back();
		}
		return dir.empty() ? std::string(".") : dir;
	}();

	std::string path = root;
	path += '/';
	path.append(name);
	return path;
}

namespace {

uint32_t startupWarnings = 0;

// Loaders are handed a "<contentPath>/..." path; the directory is noise once
// every line repeats it.
std::string_view shortDataName(std::string_view fileName)
{
	const size_t slash = fileName.find_last_of("/\\");
	return slash == std::string_view::npos ? fileName : fileName.substr(slash + 1);
}

} // namespace

void reportDataFile(std::string_view fileName, std::string_view summary)
{
	fmt::print("   {:<21} {}\n", shortDataName(fileName), summary);
}

void reportDataWarning(std::string_view fileName, std::string_view message)
{
	++startupWarnings;
	fmt::print(fg(fmt::color::yellow), "   {:<21} warning: {}\n", shortDataName(fileName), message);
}

void reportStartupWarning(std::string_view message)
{
	++startupWarnings;
	fmt::print(fg(fmt::color::yellow), ">> warning: {}\n", message);
}

uint32_t startupWarningCount() { return startupWarnings; }
