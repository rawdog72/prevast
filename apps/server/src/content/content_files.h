// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include <pugixml.hpp>
#include <filesystem>
#include <set>
#include <stdexcept>
#include <string>

// Index files live in data/XML. An include is one definition, never another
// index. Expansion is ordered so existing agent inheritance stays deterministic.
namespace content_files {
inline pugi::xml_node load(pugi::xml_document& doc, const std::string& file, const char* expected) {
    const auto result = doc.load_file(file.c_str());
    if (!result) throw std::runtime_error(file + ": " + result.description());
    auto root = doc.child(expected);
    if (!root) throw std::runtime_error(file + ": expected <" + expected + ">");
    const std::string name = expected;
    const char* entry = name == "npcs" ? "npc" : name == "agents" ? "agent" : nullptr;
    if (!entry) {
        if (root.child("include")) throw std::runtime_error(file + ": includes are not supported for this table");
        return root;
    }
    const auto directory = std::filesystem::canonical(std::filesystem::path(file).parent_path());
    const auto data = directory.parent_path();
    std::set<std::filesystem::path> loaded;
    uintmax_t bytes = 0;
    for (auto node = root.first_child(); node;) {
        auto next = node.next_sibling();
        if (std::string(node.name()) == "include") {
            const std::filesystem::path relative(node.attribute("file").as_string());
            if (relative.empty() || relative.is_absolute() || relative.has_root_name() || relative.extension() != ".xml")
                throw std::runtime_error(file + ": include requires a relative XML path");
            const auto path = std::filesystem::canonical(directory / relative);
            const auto within = path.lexically_relative(data);
            if (within.empty() || *within.begin() == ".." || !std::filesystem::is_regular_file(path))
                throw std::runtime_error(file + ": include escapes the data directory");
            const auto size = std::filesystem::file_size(path);
            if (!loaded.insert(path).second || loaded.size() > 256 || size > 1024 * 1024 || (bytes += size) > 4 * 1024 * 1024)
                throw std::runtime_error(file + ": duplicate or oversized include");
            pugi::xml_document definition;
            const auto parsed = definition.load_file(path.string().c_str());
            if (!parsed || std::string(definition.document_element().name()) != entry || definition.select_node("//include"))
                throw std::runtime_error(path.string() + ": expected one <" + entry + "> definition without includes");
            size_t roots = 0;
            for (auto child : definition.children()) if (child.type() == pugi::node_element) ++roots;
            if (roots != 1) throw std::runtime_error(path.string() + ": multiple root elements");
            root.insert_copy_before(definition.document_element(), node);
            root.remove_child(node);
        }
        node = next;
    }
    return root;
}
}
