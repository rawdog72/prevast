// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/npc.h"
#include "gameplay/game.h"
#include "content/configmanager.h"
#include <fstream>
#include <charconv>
#include <windows.h>

extern Game g_game;
namespace {
uint64_t secondsNow() {
    return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}
std::filesystem::path stockDirectory() {
    return std::filesystem::path(getString(ConfigManager::STORAGE_PATH));
}
uint64_t stockNumber(pugi::xml_node node, const char* name, uint64_t max) {
    const std::string text = node.attribute(name).as_string();
    uint64_t value = 0;
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), value);
    if (text.empty() || error != std::errc() || end != text.data() + text.size() || value > max)
        throw std::runtime_error(std::string("invalid persisted stock field: ") + name);
    return value;
}
void checkStockKey(const std::string& key) {
    if (key.empty() || key.size() > 48 || key.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_-") != std::string::npos)
        throw std::runtime_error("invalid persisted stock key");
}
}

// One compact, versioned snapshot holds every shop's persistent spawn state.
// Durability precedes the inventory commit; a failed write cannot charge a player.
bool NpcSystem::saveStock(const std::string& key) {
    try {
        checkStockKey(key);
        const auto directory = stockDirectory();
        std::filesystem::create_directories(directory);
        const auto path = directory / "npc-stock.xml";
        const auto temporary = directory / "npc-stock.xml.tmp";
        pugi::xml_document doc;
        auto root = doc.append_child("npcStocks");
        root.append_attribute("version") = 1;
        for (const auto& [spawn, stock] : stocks) {
            if (stock.remaining.empty()) continue;
            auto npc = root.append_child("npc");
            npc.append_attribute("spawn") = spawn.c_str();
            npc.append_attribute("epoch") = static_cast<unsigned long long>(stock.epoch);
            npc.append_attribute("intervalSeconds") = stock.interval;
            for (const auto& [offer, count] : stock.remaining) {
                auto n = npc.append_child("offer");
                n.append_attribute("key") = offer.c_str();
                n.append_attribute("remaining") = count;
            }
        }
        std::ostringstream output;
        doc.save(output, "  ", pugi::format_default, pugi::encoding_utf8);
        const auto bytes = output.str();
        HANDLE file = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_FLAG_WRITE_THROUGH, nullptr);
        if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("cannot create stock snapshot");
        DWORD written = 0;
        const bool ok = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) &&
                        written == bytes.size() && FlushFileBuffers(file);
        CloseHandle(file);
        if (!ok || !MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("cannot commit stock snapshot");
        return true;
    } catch (const std::exception& e) {
        fmt::print(">> NPC stock {}: {}\n", key, e.what());
        stockHealthy = false; // Fail closed; do not hammer a failing disk every tick.
        return false;
    }
}

void NpcSystem::loadStock() {
    if (stockLoaded) return;
    stockLoaded = true;
    try {
        std::map<std::string, NpcStock> restored;
        const auto directory = stockDirectory();
        // Upgrade the interrupted implementation once, retaining a backup.
        const std::filesystem::path legacy("npc-stock.json");
        const auto snapshot = directory / "npc-stock.xml";
        const bool migrate = std::filesystem::exists(legacy) && !std::filesystem::exists(snapshot);
        if (migrate) {
            if (std::filesystem::file_size(legacy) > 1024 * 1024) throw std::runtime_error("oversize legacy stock file");
            std::ifstream file(legacy); std::stringstream data; data << file.rdbuf();
            const auto parsed = boost::json::parse(data.str());
            for (const auto& entry : parsed.as_object()) {
                const std::string key(entry.key()); checkStockKey(key);
                const auto& object = entry.value().as_object();
                NpcStock stock;
                stock.epoch = boost::json::value_to<uint64_t>(object.at("epoch"));
                stock.interval = boost::json::value_to<uint32_t>(object.at("interval"));
                if (!stock.interval || stock.interval > 604800 || stock.epoch > UINT32_MAX) throw std::runtime_error("invalid legacy stock clock");
                for (const auto& offer : object.at("remaining").as_object()) {
                    const std::string offerKey(offer.key()); checkStockKey(offerKey);
                    const auto count = boost::json::value_to<uint32_t>(offer.value());
                    if (count > economy::MAX_QUANTITY) throw std::runtime_error("invalid legacy stock quantity");
                    stock.remaining[offerKey] = count;
                }
                restored[key] = std::move(stock);
            }
        }
        if (std::filesystem::exists(snapshot)) {
            if (std::filesystem::file_size(snapshot) > 1024 * 1024) throw std::runtime_error("oversize stock snapshot");
            pugi::xml_document doc;
            if (!doc.load_file(snapshot.string().c_str())) throw std::runtime_error("malformed stock snapshot");
            const auto document = doc.child("npcStocks");
            if (!document || stockNumber(document, "version", 1) != 1) throw std::runtime_error("unsupported stock snapshot version");
            for (auto root : document.children("npc")) {
            const std::string key = root.attribute("spawn").as_string(); checkStockKey(key);
            if (restored.count(key)) throw std::runtime_error("duplicate stock spawn");
            NpcStock stock;
            stock.epoch = stockNumber(root, "epoch", UINT32_MAX);
            stock.interval = static_cast<uint32_t>(stockNumber(root, "intervalSeconds", 604800));
            if (!stock.interval) throw std::runtime_error("zero stock interval");
            for (auto offer : root.children("offer")) {
                const std::string offerKey = offer.attribute("key").as_string(); checkStockKey(offerKey);
                if (!stock.remaining.emplace(offerKey, static_cast<uint32_t>(stockNumber(offer, "remaining", economy::MAX_QUANTITY))).second)
                    throw std::runtime_error("duplicate stock offer");
            }
            restored[key] = std::move(stock);
            }
        }
        stocks.swap(restored);
        if (migrate) {
            if (!saveStock("migration")) throw std::runtime_error("legacy stock migration failed");
            const auto backup = directory / "legacy-stock.json.bak";
            if (std::filesystem::exists(backup)) throw std::runtime_error("legacy stock backup already exists; inspect both files before retrying migration");
            std::filesystem::rename(legacy, backup);
        }
    } catch (const std::exception& e) {
        stockHealthy = false;
        fmt::print(">> NPC shops disabled: cannot restore shared stock: {}\n", e.what());
    }
}

bool NpcSystem::restock(const std::string& key, const NpcDefinition& d) {
    if (!stockHealthy) return false;
    auto old = stocks.find(key);
    const auto now = secondsNow();
    if (old != stocks.end() && now < (old->second.epoch + 1) * old->second.interval) return true;
    NpcStock next; next.interval = d.restock; next.epoch = now / d.restock;
    static std::mt19937 random(std::random_device{}());
    for (const auto& offer : d.offers) {
        if (offer.unlimited || !offer.buy) continue;
        next.remaining[offer.key] = std::uniform_int_distribution<uint32_t>(1, 10000)(random) <= offer.chance
            ? std::uniform_int_distribution<uint32_t>(offer.minStock, offer.maxStock)(random) : 0;
    }
    const std::optional<NpcStock> previous = old == stocks.end() ? std::nullopt : std::optional<NpcStock>(old->second);
    stocks[key] = next;
    if (!d.offers.empty() && !saveStock(key)) {
        if (previous) stocks[key] = *previous; else stocks.erase(key);
        return false;
    }
    for (auto& [id, s] : sessions) if (s.spawn == key) { ++s.revision; s.text = "New stock has arrived."; }
    return true;
}

void NpcSystem::useScenarioSpawns(std::vector<NpcSpawn> placed) {
    scenarioSpawns = placed;
    spawns = std::move(placed);
}

void NpcSystem::start() {
    loadStock();
    for (const auto& spawn : spawns) {
        if (npcs.count(spawn.key)) continue;
        auto npc = std::make_unique<Npc>();
        npc->spawn = spawn; npc->definition = &definitions.at(spawn.npc);
        npc->position = npc->previous = npc->goal = spawn.home;
        npc->rotation = spawn.rotation;
        const auto id = g_game.map.acquireEntityId(EntityClass::Npc);
        if (!id) continue;
        npc->setID(id);
        g_game.map.placeThing(spawn.home, npc.get());
        restock(spawn.key, *npc->definition);
        npcs.emplace(spawn.key, std::move(npc));
    }
}
