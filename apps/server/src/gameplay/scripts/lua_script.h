// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include <boost/json.hpp>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

struct lua_State;

// One Lua script, compiled once and kept loaded (quest scripts, trigger
// scripts, NPC dialogue scripts). The file must `return { ... }`: a table of
// hook functions and an optional `on` list of event subscriptions.
//
// The sandbox: no os/io/package/debug/load*/coroutine/pcall/jit, JIT off, 1 MiB
// of memory for the whole state, and 10,000 instructions per call. Globals are
// frozen once the file has run, so nothing a hook does outlives the call
// except through what it returns. Values cross the boundary as JSON-like
// trees (objects become tables, arrays 1-based tables), which is all a hook
// can read and all it can hand back.
class LuaScript {
public:
    static constexpr size_t MEMORY_LIMIT = 1024 * 1024;
    static constexpr int INSTRUCTION_LIMIT = 10000;

    explicit LuaScript(std::string name);
    ~LuaScript();
    LuaScript(const LuaScript&) = delete;
    LuaScript& operator=(const LuaScript&) = delete;

    // Compiles and runs the file. Throws std::runtime_error naming the script.
    void load(const std::string& source);
    bool has(const char* hook) const;
    // The `on` list, as written ("destroy:car", "kill").
    const std::vector<std::string>& subscriptions() const { return on; }
    // hook(args...). Returns what it returned (null for nothing). Throws
    // std::runtime_error on a Lua error, the instruction limit, memory, or a
    // result that cannot be read back (functions, cycles, too deep or big).
    boost::json::value call(const char* hook, const std::vector<boost::json::value>& args);
    const std::string& name() const { return scriptName; }

private:
    struct Memory { size_t used = 0; };
    std::string scriptName;
    std::unique_ptr<Memory> memory;
    lua_State* L = nullptr;
    int module = -1; // registry reference to the returned table
    std::vector<std::string> on;
};

int runLuaScriptSelfTest();
