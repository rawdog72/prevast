// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include "gameplay/item.h"
#include <pugixml.hpp>
#include <charconv>
#include <algorithm>
#include <stdexcept>
#include <string>
namespace content_validation {
inline uint32_t number(pugi::xml_node node, const char* name, uint32_t fallback, uint32_t maximum) {
    auto a = node.attribute(name);
    if (!a) return fallback;
    const std::string value = a.value();
    uint32_t out = 0;
    auto [end, ec] = std::from_chars(value.data(), value.data() + value.size(), out);
    if (ec != std::errc() || end != value.data() + value.size() || out > maximum)
        throw std::runtime_error(std::string("invalid NPC number: ") + name);
    return out;
}
inline bool flag(pugi::xml_node n, const char* key, bool fallback) {
    auto a = n.attribute(key);
    if (!a) return fallback;
    std::string v = a.value();
    if (v != "true" && v != "false") throw std::runtime_error(std::string("invalid NPC boolean: ") + key);
    return v == "true";
}
inline std::string key(pugi::xml_node n, const char* attr = "key") {
    std::string value = n.attribute(attr).as_string();
    if (value.empty() || value.size() > 48 || value.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_-") != std::string::npos)
        throw std::runtime_error(std::string("invalid NPC key: ") + attr);
    return value;
}
inline std::string text(pugi::xml_node n, const char* attr, const char* fallback = "") {
    std::string value = n.attribute(attr).as_string(fallback);
    if (value.size() > 512 || std::any_of(value.begin(), value.end(), [](unsigned char c) { return c < 32 && c != 9 && c != 10 && c != 13; })) throw std::runtime_error("NPC text exceeds 512 bytes");
    return value;
}
inline uint16_t item(pugi::xml_node n, const char* attr = "item") {
    const auto k = key(n, attr);
    const auto* data = ItemManager::getInstance().getItemData(k);
    const auto id = data ? data->id : 0;
    if (!id) throw std::runtime_error("unknown NPC item: " + k);
    return id;
}
}
