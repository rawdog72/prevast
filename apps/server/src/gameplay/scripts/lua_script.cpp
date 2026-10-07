// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/scripts/lua_script.h"
#if __has_include("luajit/lua.hpp")
#include <luajit/lua.hpp>
#include <luajit/luajit.h>
#else
#include <lua.hpp>
#endif

namespace lsjson = boost::json;

namespace {
constexpr int LS_MAX_DEPTH = 8;
constexpr size_t LS_MAX_ITEMS = 256;

void* lsAllocate(void* context, void* ptr, size_t oldSize, size_t size)
{
    auto& used = *static_cast<size_t*>(context);
    if (!ptr) oldSize = 0;
    if (!size) {
        used -= oldSize;
        std::free(ptr);
        return nullptr;
    }
    if (size > LuaScript::MEMORY_LIMIT || used - oldSize > LuaScript::MEMORY_LIMIT - size) return nullptr;
    void* next = std::realloc(ptr, size);
    if (next) used = used - oldSize + size;
    return next;
}

void lsInstructionLimit(lua_State* L, lua_Debug*) { luaL_error(L, "instruction limit reached"); }

int lsFrozen(lua_State* L)
{
    return luaL_error(L, "globals are read-only after load; keep state in quest variables");
}

void lsPush(lua_State* L, const lsjson::value& v, int depth)
{
    if (depth > LS_MAX_DEPTH) throw std::runtime_error("argument nested too deeply");
    switch (v.kind()) {
    case lsjson::kind::null: lua_pushnil(L); break;
    case lsjson::kind::bool_: lua_pushboolean(L, v.get_bool()); break;
    case lsjson::kind::int64: lua_pushnumber(L, static_cast<lua_Number>(v.get_int64())); break;
    case lsjson::kind::uint64: lua_pushnumber(L, static_cast<lua_Number>(v.get_uint64())); break;
    case lsjson::kind::double_: lua_pushnumber(L, v.get_double()); break;
    case lsjson::kind::string: lua_pushlstring(L, v.get_string().data(), v.get_string().size()); break;
    case lsjson::kind::array: {
        const auto& a = v.get_array();
        lua_createtable(L, static_cast<int>(a.size()), 0);
        for (size_t i = 0; i < a.size(); ++i) {
            lsPush(L, a[i], depth + 1);
            lua_rawseti(L, -2, static_cast<int>(i + 1));
        }
        break;
    }
    case lsjson::kind::object: {
        const auto& o = v.get_object();
        lua_createtable(L, 0, static_cast<int>(o.size()));
        for (const auto& [key, value] : o) {
            lua_pushlstring(L, key.data(), key.size());
            lsPush(L, value, depth + 1);
            lua_rawset(L, -3);
        }
        break;
    }
    }
}

// Reads the value at `index` back into a tree. A table whose keys are exactly
// 1..n becomes an array, any other table an object with string keys.
lsjson::value lsRead(lua_State* L, int index, int depth, size_t& items)
{
    if (depth > LS_MAX_DEPTH) throw std::runtime_error("result nested too deeply");
    if (++items > LS_MAX_ITEMS * 4) throw std::runtime_error("result too large");
    index = index < 0 ? lua_gettop(L) + index + 1 : index;
    switch (lua_type(L, index)) {
    case LUA_TNIL: return nullptr;
    case LUA_TBOOLEAN: return lua_toboolean(L, index) != 0;
    case LUA_TNUMBER: return static_cast<double>(lua_tonumber(L, index));
    case LUA_TSTRING: {
        size_t size = 0;
        const char* text = lua_tolstring(L, index, &size);
        if (size > 1024) throw std::runtime_error("result string longer than 1024 bytes");
        return lsjson::string(text, size);
    }
    case LUA_TTABLE: {
        const size_t length = lua_objlen(L, index);
        size_t count = 0;
        bool arrayLike = true;
        lua_pushnil(L);
        while (lua_next(L, index)) {
            ++count;
            if (lua_type(L, -2) != LUA_TNUMBER) arrayLike = false;
            lua_pop(L, 1);
        }
        if (count > LS_MAX_ITEMS) throw std::runtime_error("result table has more than 256 entries");
        if (arrayLike && count == length) {
            lsjson::array a;
            for (size_t i = 1; i <= length; ++i) {
                lua_rawgeti(L, index, static_cast<int>(i));
                a.push_back(lsRead(L, -1, depth + 1, items));
                lua_pop(L, 1);
            }
            return a;
        }
        lsjson::object o;
        lua_pushnil(L);
        while (lua_next(L, index)) {
            if (lua_type(L, -2) != LUA_TSTRING) throw std::runtime_error("result table mixes string and number keys");
            size_t size = 0;
            const char* key = lua_tolstring(L, -2, &size);
            o[lsjson::string_view(key, size)] = lsRead(L, -1, depth + 1, items);
            lua_pop(L, 1);
        }
        return o;
    }
    default: throw std::runtime_error(std::string("a hook returned a ") + lua_typename(L, lua_type(L, index)));
    }
}
}

LuaScript::LuaScript(std::string name) : scriptName(std::move(name)), memory(std::make_unique<Memory>()) {}

LuaScript::~LuaScript()
{
    if (L) lua_close(L);
}

void LuaScript::load(const std::string& source)
{
    if (L) throw std::runtime_error(scriptName + ": already loaded");
    if (!source.empty() && source.front() == '\x1b') throw std::runtime_error(scriptName + ": must be Lua source, not bytecode");
    L = lua_newstate(lsAllocate, &memory->used);
    if (!L) throw std::runtime_error(scriptName + ": cannot create a Lua state");
    luaL_openlibs(L);
#ifdef LUAJIT_VERSION
    luaJIT_setmode(L, 0, LUAJIT_MODE_ENGINE | LUAJIT_MODE_OFF);
#endif
    for (const char* global : {"os", "io", "package", "debug", "require", "dofile", "loadfile", "load", "loadstring",
                               "collectgarbage", "getfenv", "setfenv", "coroutine", "jit", "pcall", "xpcall", "module",
                               "newproxy", "gcinfo", "rawset"}) {
        lua_pushnil(L);
        lua_setglobal(L, global);
    }
    const std::string chunk = "@" + scriptName;
    lua_sethook(L, lsInstructionLimit, LUA_MASKCOUNT, INSTRUCTION_LIMIT * 10);
    if (luaL_loadbuffer(L, source.data(), source.size(), chunk.c_str()) != 0 || lua_pcall(L, 0, 1, 0) != 0) {
        const std::string error = lua_isstring(L, -1) ? lua_tostring(L, -1) : "unknown error";
        throw std::runtime_error(scriptName + ": " + error);
    }
    lua_sethook(L, nullptr, 0, 0);
    // A file that returns nothing defines its hooks as global functions (the
    // older NPC script style, `function onTalk(context) ... end`).
    if (lua_isnil(L, -1)) {
        lua_pop(L, 1);
        lua_pushvalue(L, LUA_GLOBALSINDEX);
    }
    if (!lua_istable(L, -1)) throw std::runtime_error(scriptName + ": the file must return a table of hooks");

    lua_getfield(L, -1, "on");
    if (lua_istable(L, -1)) {
        const size_t n = lua_objlen(L, -1);
        for (size_t i = 1; i <= n; ++i) {
            lua_rawgeti(L, -1, static_cast<int>(i));
            if (!lua_isstring(L, -1)) throw std::runtime_error(scriptName + ": `on` must list strings");
            on.emplace_back(lua_tostring(L, -1));
            lua_pop(L, 1);
        }
    } else if (!lua_isnil(L, -1)) {
        throw std::runtime_error(scriptName + ": `on` must be a list");
    }
    lua_pop(L, 1);
    module = luaL_ref(L, LUA_REGISTRYINDEX);

    // Freeze the globals.
    lua_pushvalue(L, LUA_GLOBALSINDEX);
    lua_newtable(L);
    lua_pushcfunction(L, lsFrozen);
    lua_setfield(L, -2, "__newindex");
    lua_pushboolean(L, 0); // setmetatable(_G, nil) may not undo it
    lua_setfield(L, -2, "__metatable");
    lua_setmetatable(L, -2);
    lua_pop(L, 1);
}

bool LuaScript::has(const char* hook) const
{
    if (!L) return false;
    lua_rawgeti(L, LUA_REGISTRYINDEX, module);
    lua_getfield(L, -1, hook);
    const bool found = lua_isfunction(L, -1);
    lua_pop(L, 2);
    return found;
}

lsjson::value LuaScript::call(const char* hook, const std::vector<lsjson::value>& args)
{
    if (!L) throw std::runtime_error(scriptName + ": not loaded");
    const int top = lua_gettop(L);
    try {
        lua_rawgeti(L, LUA_REGISTRYINDEX, module);
        lua_getfield(L, -1, hook);
        if (!lua_isfunction(L, -1)) {
            lua_settop(L, top);
            return nullptr;
        }
        for (const auto& arg : args) lsPush(L, arg, 0);
        lua_sethook(L, lsInstructionLimit, LUA_MASKCOUNT, INSTRUCTION_LIMIT);
        const int status = lua_pcall(L, static_cast<int>(args.size()), 1, 0);
        lua_sethook(L, nullptr, 0, 0);
        if (status != 0) {
            const std::string error = lua_isstring(L, -1) ? lua_tostring(L, -1) : "unknown error";
            throw std::runtime_error(scriptName + " " + hook + ": " + error);
        }
        size_t items = 0;
        lsjson::value result = lsRead(L, -1, 0, items);
        lua_settop(L, top);
        return result;
    } catch (...) {
        lua_sethook(L, nullptr, 0, 0);
        lua_settop(L, top);
        throw;
    }
}

// ---------------------------------------------------------------------------

int runLuaScriptSelfTest()
{
    int failed = 0;
    const auto check = [&](bool ok, std::string_view what) {
        if (!ok) {
            ++failed;
            fmt::print(">> lua script self-test FAILED: {}\n", what);
        }
    };
    const auto throws = [&](auto&& f, std::string_view fragment, std::string_view what) {
        try {
            f();
            check(false, fmt::format("{}: no error", what));
        } catch (const std::exception& e) {
            const bool ok = std::string_view(e.what()).find(fragment) != std::string_view::npos;
            if (!ok) fmt::print(">> lua script self-test: {} threw '{}'\n", what, e.what());
            check(ok, what);
        }
    };

    try {
        LuaScript s("ok.lua");
        s.load(R"(
            return {
              on = { "destroy:car", "kill" },
              onEvent = function(ctx, ev)
                if ev.subject == "car" then return { { start = "scrapyard" }, { say = ctx.player.name } } end
                return { { setVar = "cars", add = ev.count } }
              end,
            })");
        check(s.subscriptions().size() == 2 && s.subscriptions()[0] == "destroy:car", "`on` is read");
        check(s.has("onEvent") && !s.has("onStart"), "hooks are found");
        const lsjson::value ctx = lsjson::object{{"player", lsjson::object{{"name", "Ann"}}}};
        const lsjson::value car = s.call("onEvent", {ctx, lsjson::object{{"subject", "car"}, {"count", 1}}});
        check(car.is_array() && car.as_array().size() == 2 && car.as_array()[1].as_object().at("say").as_string() == "Ann",
              "a result list comes back as an array of objects");
        const lsjson::value other = s.call("onEvent", {ctx, lsjson::object{{"subject", "tree"}, {"count", 3}}});
        check(other.as_array()[0].as_object().at("add").as_double() == 3, "numbers survive the round trip");
        check(s.call("onStart", {}).is_null(), "a missing hook returns null");
    } catch (const std::exception& e) {
        check(false, fmt::format("a valid script loads and runs: {}", e.what()));
    }

    throws([] { LuaScript s("syntax.lua"); s.load("return {"); }, "syntax.lua", "syntax errors name the script");
    throws([] { LuaScript s("notable.lua"); s.load("return 5"); }, "return a table", "the file must return a table");
    try {
        LuaScript g("globals.lua");
        g.load("function onTalk(context) return { reply = 'hi ' .. context.message } end");
        check(g.has("onTalk") && g.call("onTalk", {lsjson::object{{"message", "you"}}}).as_object().at("reply").as_string() == "hi you",
              "global-function scripts (the older NPC style) still work");
    } catch (const std::exception& e) {
        check(false, fmt::format("global-function scripts load: {}", e.what()));
    }
    throws([] { LuaScript s("io.lua"); s.load("return { f = io.open('x') }"); }, "io.lua", "io is not available");
    throws([] { LuaScript s("bytecode.lua"); s.load(std::string("\x1bLua", 4)); }, "bytecode", "bytecode is refused");

    LuaScript loop("loop.lua");
    loop.load("return { spin = function() while true do end end, count = 0, bump = function() x = 1 end }");
    throws([&] { loop.call("spin", {}); }, "instruction limit", "an endless loop is stopped");
    throws([&] { loop.call("bump", {}); }, "read-only", "globals are frozen after load");
    LuaScript unfreeze("unfreeze.lua");
    unfreeze.load("return { f = function() setmetatable(_G, nil) end }");
    throws([&] { unfreeze.call("f", {}); }, "protected metatable", "the freeze cannot be removed");

    LuaScript greedy("memory.lua");
    greedy.load("return { eat = function() local t = {} for i = 1, 1e6 do t[i] = string.rep('x', 64) .. i end return 1 end }");
    throws([&] { greedy.call("eat", {}); }, "memory.lua", "memory is capped");

    LuaScript badResult("result.lua");
    badResult.load("return { f = function() return { print } end }");
    throws([&] { badResult.call("f", {}); }, "returned a function", "functions cannot be returned");

    fmt::print(">> lua script self-test: {}\n", failed == 0 ? "passed" : "FAILED");
    return failed == 0 ? 0 : 1;
}
