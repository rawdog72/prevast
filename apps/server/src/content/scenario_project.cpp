// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "content/scenario_project.h"

#include "contract/editor_limits.h"
#include "core/definitions.h"

#include <bcrypt.h>
#pragma comment(lib, "bcrypt.lib")

#include <algorithm>
#include <array>
#include <filesystem>
#include <fmt/color.h>
#include <fmt/format.h>
#include <fstream>
#include <functional>
#include <map>
#include <set>
#include <sstream>
#include <unordered_map>
#include <unordered_set>

namespace scenario {
namespace {

namespace json = boost::json;
namespace L = EditorContract::Project;
namespace W = EditorContract::World;

constexpr std::string_view FORMAT = "prevast-scenario";
// Projects saved before the project was renamed; read as FORMAT.
constexpr std::string_view LEGACY_FORMAT = "devast-scenario";
constexpr int32_t OFFSET_MAX = W::positionMax;

// --- diagnostics -------------------------------------------------------------

class Report
{
public:
	std::vector<Diagnostic> items;

	void error(std::string code, std::string path, std::string message, std::string target = {})
	{
		items.push_back({ Severity::Error, std::move(code), std::move(path), std::move(message), std::move(target) });
	}
	void warning(std::string code, std::string path, std::string message, std::string target = {})
	{
		items.push_back({ Severity::Warning, std::move(code), std::move(path), std::move(message), std::move(target) });
	}
	bool hasErrors() const
	{
		return std::any_of(items.begin(), items.end(), [](const Diagnostic& d) { return d.severity == Severity::Error; });
	}
};

std::string join(const std::string& path, std::string_view key)
{
	return path.empty() ? std::string(key) : fmt::format("{}.{}", path, key);
}

std::string index(const std::string& path, size_t i)
{
	return fmt::format("{}[{}]", path, i);
}

// JavaScript string length (UTF-16 code units) of a UTF-8 string, so name and
// tag limits count exactly what the browser counts.
size_t utf16Length(std::string_view s)
{
	size_t n = 0;
	for (size_t i = 0; i < s.size();) {
		const unsigned char c = static_cast<unsigned char>(s[i]);
		const size_t len = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : 4;
		n += len == 4 ? 2 : 1;
		i += len;
	}
	return n;
}

// --- strict readers ----------------------------------------------------------
//
// Every reader reports `schema.invalid` with the exact path, like the zod
// schema does, and returns nullopt so parsing continues and collects more.

class Reader
{
public:
	explicit Reader(Report& report) : report(report) {}

	// The object at `v`, with only `allowed` keys. Unknown keys are errors:
	// a misspelled override must never be silently ignored.
	const json::object* object(const json::value* v, const std::string& path,
	                           std::initializer_list<std::string_view> allowed)
	{
		if (!v || !v->is_object()) {
			invalid(path, "expected an object");
			return nullptr;
		}
		const json::object& o = v->get_object();
		for (const auto& kv : o) {
			const std::string_view key(kv.key().data(), kv.key().size());
			if (std::find(allowed.begin(), allowed.end(), key) == allowed.end())
				invalid(join(path, key), fmt::format("unrecognized key \"{}\"", key));
		}
		return &o;
	}

	const json::array* array(const json::value* v, const std::string& path, size_t minSize, size_t maxSize)
	{
		if (!v || !v->is_array()) {
			invalid(path, "expected an array");
			return nullptr;
		}
		const json::array& a = v->get_array();
		if (a.size() < minSize || a.size() > maxSize) {
			invalid(path, fmt::format("expected {}..{} items, got {}", minSize, maxSize, a.size()));
			return nullptr;
		}
		return &a;
	}

	// Integers only. A double is accepted when it is integral (JSON "150.0"
	// parses to 150 in the browser too), never when it has a fraction.
	std::optional<int64_t> integer(const json::value* v, const std::string& path, int64_t lo, int64_t hi)
	{
		std::optional<int64_t> n;
		if (v && v->is_int64()) n = v->get_int64();
		else if (v && v->is_uint64() && v->get_uint64() <= static_cast<uint64_t>(INT64_MAX)) n = static_cast<int64_t>(v->get_uint64());
		else if (v && v->is_double()) {
			const double d = v->get_double();
			if (std::isfinite(d) && std::floor(d) == d && std::fabs(d) < 9007199254740992.0) n = static_cast<int64_t>(d);
		}
		if (!n) {
			invalid(path, "expected an integer");
			return std::nullopt;
		}
		if (*n < lo || *n > hi) {
			invalid(path, fmt::format("expected {}..{}, got {}", lo, hi, *n));
			return std::nullopt;
		}
		return n;
	}

	std::optional<bool> boolean(const json::value* v, const std::string& path)
	{
		if (!v || !v->is_bool()) {
			invalid(path, "expected true or false");
			return std::nullopt;
		}
		return v->get_bool();
	}

	std::optional<std::string> string(const json::value* v, const std::string& path, size_t minLen, size_t maxLen)
	{
		if (!v || !v->is_string()) {
			invalid(path, "expected a string");
			return std::nullopt;
		}
		const json::string& s = v->get_string();
		const size_t len = utf16Length(std::string_view(s.data(), s.size()));
		if (len < minLen || len > maxLen) {
			invalid(path, fmt::format("expected {}..{} characters", minLen, maxLen));
			return std::nullopt;
		}
		return std::string(s.data(), s.size());
	}

	std::optional<std::string> id(const json::value* v, const std::string& path)
	{
		auto s = string(v, path, 1, L::maxIdLength);
		if (!s) return std::nullopt;
		const bool ok = std::all_of(s->begin(), s->end(), [](char c) {
			return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
		});
		if (!ok) {
			invalid(path, "IDs use letters, digits, _ and - only");
			return std::nullopt;
		}
		return s;
	}

	template <size_t N>
	std::optional<size_t> choice(const json::value* v, const std::string& path, const std::array<std::string_view, N>& options)
	{
		if (v && v->is_string()) {
			const std::string_view s(v->get_string().data(), v->get_string().size());
			for (size_t i = 0; i < N; ++i)
				if (options[i] == s) return i;
		}
		invalid(path, "not one of the allowed values");
		return std::nullopt;
	}

	std::vector<std::string> tags(const json::value* v, const std::string& path)
	{
		std::vector<std::string> out;
		const json::array* a = array(v, path, 0, L::maxTagsPerEntity);
		if (!a) return out;
		for (size_t i = 0; i < a->size(); ++i)
			if (auto t = string(&(*a)[i], index(path, i), 1, L::maxTagLength)) out.push_back(*t);
		return out;
	}

	void invalid(const std::string& path, const std::string& message)
	{
		if (++invalidCount <= 200) report.error("schema.invalid", path, message);
	}

private:
	Report& report;
	size_t invalidCount = 0;
};

const json::value* field(const json::object* o, std::string_view key)
{
	return o ? o->if_contains(key) : nullptr;
}

const std::array<std::string_view, 5> ENTITY_KINDS = { "object", "resource", "agent", "npc", "spawn" };
const std::array<std::string_view, 3> GROUP_KINDS = { "group", "house", "city" };
const std::array<std::string_view, 5> EFFECT_STATS = { "health", "warmth", "stamina", "radiation", "food" };
const std::array<std::string_view, 2> PERMISSIONS = { "allow", "deny" };

bool isGridKind(EntityKind kind)
{
	return kind == EntityKind::Object || kind == EntityKind::Resource;
}

// --- section parsers ---------------------------------------------------------

std::optional<std::vector<ItemStack>> readStacks(Reader& r, const json::value* v, const std::string& path, size_t maxSize)
{
	const json::array* a = r.array(v, path, 0, maxSize);
	if (!a) return std::nullopt;
	std::vector<ItemStack> out;
	bool ok = true;
	for (size_t i = 0; i < a->size(); ++i) {
		const std::string ipath = index(path, i);
		const json::object* o = r.object(&(*a)[i], ipath, { "item", "count" });
		auto item = o ? r.string(field(o, "item"), join(ipath, "item"), 1, L::maxIdLength) : std::nullopt;
		auto count = o ? r.integer(field(o, "count"), join(ipath, "count"), 1, 255) : std::nullopt;
		if (item && count) out.push_back({ *item, static_cast<uint8_t>(*count) });
		else ok = false;
	}
	return ok ? std::optional<std::vector<ItemStack>>(std::move(out)) : std::nullopt;
}

std::optional<Entity> readEntity(Reader& r, const json::value& v, const std::string& path)
{
	const json::object* o = r.object(&v, path, { "id", "kind", "ref", "variant", "x", "y", "rotation", "angle", "parent", "name", "tags", "overrides", "team", "weight", "wander", "loadout", "container" });
	if (!o) return std::nullopt;
	Entity e;
	bool ok = true;
	auto need = [&](auto opt, auto& out) {
		if (opt) out = static_cast<std::remove_reference_t<decltype(out)>>(*opt);
		else ok = false;
	};
	need(r.id(field(o, "id"), join(path, "id")), e.id);
	if (auto k = r.choice(field(o, "kind"), join(path, "kind"), ENTITY_KINDS)) e.kind = static_cast<EntityKind>(*k);
	else ok = false;
	need(r.string(field(o, "ref"), join(path, "ref"), 1, L::maxIdLength), e.ref);
	need(r.integer(field(o, "x"), join(path, "x"), 0, W::positionMax), e.x);
	need(r.integer(field(o, "y"), join(path, "y"), 0, W::positionMax), e.y);
	if (field(o, "variant")) {
		if (auto n = r.integer(field(o, "variant"), join(path, "variant"), 0, 63)) e.variant = static_cast<uint8_t>(*n);
		else ok = false;
	}
	if (field(o, "rotation")) {
		if (auto n = r.integer(field(o, "rotation"), join(path, "rotation"), 0, 3)) e.rotation = static_cast<uint8_t>(*n);
		else ok = false;
	}
	if (field(o, "angle")) {
		if (auto n = r.integer(field(o, "angle"), join(path, "angle"), 0, 255)) e.angle = static_cast<uint8_t>(*n);
		else ok = false;
	}
	if (field(o, "parent")) need(r.id(field(o, "parent"), join(path, "parent")), e.parent);
	if (field(o, "name")) need(r.string(field(o, "name"), join(path, "name"), 0, L::maxNameLength), e.name);
	if (field(o, "tags")) e.tags = r.tags(field(o, "tags"), join(path, "tags"));
	if (field(o, "team")) need(r.string(field(o, "team"), join(path, "team"), 1, L::maxTagLength), e.team);
	if (field(o, "weight")) {
		if (auto n = r.integer(field(o, "weight"), join(path, "weight"), 1, 1000)) e.weight = static_cast<uint16_t>(*n);
		else ok = false;
	}
	if (field(o, "wander")) {
		if (auto n = r.integer(field(o, "wander"), join(path, "wander"), 0, 20)) e.wander = static_cast<uint8_t>(*n);
		else ok = false;
	}
	if (field(o, "loadout")) {
		if (auto items = readStacks(r, field(o, "loadout"), join(path, "loadout"), L::maxLoadoutItems)) e.loadout = std::move(*items);
		else ok = false;
	}
	if (const json::value* cv = field(o, "container")) {
		const std::string cpath = join(path, "container");
		if (const json::object* co = r.object(cv, cpath, { "fixed", "loot", "refillSeconds" })) {
			ContainerContents c;
			if (field(co, "fixed")) {
				if (auto items = readStacks(r, field(co, "fixed"), join(cpath, "fixed"), L::maxLootEntries)) c.fixed = std::move(*items);
				else ok = false;
			}
			if (field(co, "loot")) { if (auto s = r.id(field(co, "loot"), join(cpath, "loot"))) c.loot = *s; else ok = false; }
			if (field(co, "refillSeconds")) {
				if (auto n = r.integer(field(co, "refillSeconds"), join(cpath, "refillSeconds"), 10, 86400)) c.refillSeconds = static_cast<uint32_t>(*n);
				else ok = false;
			}
			e.container = std::move(c);
		} else ok = false;
	}
	if (const json::value* ov = field(o, "overrides")) {
		const std::string opath = join(path, "overrides");
		if (const json::object* oo = r.object(ov, opath, { "healthMax", "health", "destructible", "doorOpen" })) {
			const int64_t hmax = EditorContract::Overrides::healthMax;
			if (field(oo, "healthMax")) {
				if (auto n = r.integer(field(oo, "healthMax"), join(opath, "healthMax"), 1, hmax)) e.overrides.healthMax = static_cast<uint16_t>(*n);
				else ok = false;
			}
			if (field(oo, "health")) {
				if (auto n = r.integer(field(oo, "health"), join(opath, "health"), 1, hmax)) e.overrides.health = static_cast<uint16_t>(*n);
				else ok = false;
			}
			if (field(oo, "destructible")) {
				if (auto b = r.boolean(field(oo, "destructible"), join(opath, "destructible"))) e.overrides.destructible = *b;
				else ok = false;
			}
			if (field(oo, "doorOpen")) {
				if (auto b = r.boolean(field(oo, "doorOpen"), join(opath, "doorOpen"))) e.overrides.doorOpen = *b;
				else ok = false;
			}
		} else ok = false;
	}
	return ok ? std::optional<Entity>(std::move(e)) : std::nullopt;
}

std::optional<Group> readGroup(Reader& r, const json::value& v, const std::string& path)
{
	const json::object* o = r.object(&v, path, { "id", "name", "kind", "parent", "pivot", "marker", "tags", "template" });
	if (!o) return std::nullopt;
	Group g;
	bool ok = true;
	if (auto s = r.id(field(o, "id"), join(path, "id"))) g.id = *s; else ok = false;
	if (auto s = r.string(field(o, "name"), join(path, "name"), 0, L::maxNameLength)) g.name = *s; else ok = false;
	if (auto k = r.choice(field(o, "kind"), join(path, "kind"), GROUP_KINDS)) g.kind = static_cast<GroupKind>(*k); else ok = false;
	if (field(o, "parent")) { if (auto s = r.id(field(o, "parent"), join(path, "parent"))) g.parent = *s; else ok = false; }
	const std::string ppath = join(path, "pivot");
	if (const json::object* p = r.object(field(o, "pivot"), ppath, { "x", "y" })) {
		auto x = r.integer(field(p, "x"), join(ppath, "x"), 0, W::positionMax);
		auto y = r.integer(field(p, "y"), join(ppath, "y"), 0, W::positionMax);
		if (x && y) { g.pivotX = static_cast<int32_t>(*x); g.pivotY = static_cast<int32_t>(*y); } else ok = false;
	} else ok = false;
	if (field(o, "marker")) { if (auto b = r.boolean(field(o, "marker"), join(path, "marker"))) g.marker = *b; else ok = false; }
	if (field(o, "tags")) g.tags = r.tags(field(o, "tags"), join(path, "tags"));
	if (const json::value* tv = field(o, "template")) {
		const std::string tpath = join(path, "template");
		if (const json::object* t = r.object(tv, tpath, { "id", "revision", "linked" })) {
			TemplateLink link;
			auto tid = r.id(field(t, "id"), join(tpath, "id"));
			auto rev = r.integer(field(t, "revision"), join(tpath, "revision"), 1, UINT32_MAX);
			auto linked = r.boolean(field(t, "linked"), join(tpath, "linked"));
			if (tid && rev && linked) {
				link.id = *tid;
				link.revision = static_cast<uint32_t>(*rev);
				link.linked = *linked;
				g.templateLink = link;
			} else ok = false;
		} else ok = false;
	}
	return ok ? std::optional<Group>(std::move(g)) : std::nullopt;
}

std::optional<Shape> readShape(Reader& r, const json::value* v, const std::string& path)
{
	const json::object* probe = v && v->is_object() ? &v->get_object() : nullptr;
	const json::value* type = field(probe, "type");
	const std::string_view t = type && type->is_string() ? std::string_view(type->get_string().data(), type->get_string().size()) : "";
	Shape s;
	auto coord = [&](const json::object* o, std::string_view key, int32_t lo, int32_t hi, int32_t& out) {
		auto n = r.integer(field(o, key), join(path, key), lo, hi);
		if (n) out = static_cast<int32_t>(*n);
		return n.has_value();
	};
	if (t == "circle") {
		const json::object* o = r.object(v, path, { "type", "x", "y", "r" });
		s.type = ShapeType::Circle;
		const bool ok = o && coord(o, "x", -OFFSET_MAX, OFFSET_MAX, s.x) & coord(o, "y", -OFFSET_MAX, OFFSET_MAX, s.y) & coord(o, "r", 1, OFFSET_MAX, s.r);
		return ok ? std::optional<Shape>(s) : std::nullopt;
	}
	if (t == "rect") {
		const json::object* o = r.object(v, path, { "type", "x", "y", "w", "h" });
		s.type = ShapeType::Rect;
		const bool ok = o && coord(o, "x", -OFFSET_MAX, OFFSET_MAX, s.x) & coord(o, "y", -OFFSET_MAX, OFFSET_MAX, s.y) &
			coord(o, "w", 1, OFFSET_MAX, s.w) & coord(o, "h", 1, OFFSET_MAX, s.h);
		return ok ? std::optional<Shape>(s) : std::nullopt;
	}
	if (t == "polygon") {
		const json::object* o = r.object(v, path, { "type", "points" });
		s.type = ShapeType::Polygon;
		const std::string ppath = join(path, "points");
		const json::array* pts = o ? r.array(field(o, "points"), ppath, 3, 64) : nullptr;
		if (!pts) return std::nullopt;
		bool ok = true;
		for (size_t i = 0; i < pts->size(); ++i) {
			const json::array* pair = r.array(&(*pts)[i], index(ppath, i), 2, 2);
			if (!pair) { ok = false; continue; }
			auto x = r.integer(&(*pair)[0], index(index(ppath, i), 0), -OFFSET_MAX, OFFSET_MAX);
			auto y = r.integer(&(*pair)[1], index(index(ppath, i), 1), -OFFSET_MAX, OFFSET_MAX);
			if (x && y) s.points.emplace_back(static_cast<int32_t>(*x), static_cast<int32_t>(*y));
			else ok = false;
		}
		return ok ? std::optional<Shape>(std::move(s)) : std::nullopt;
	}
	r.invalid(join(path, "type"), "expected circle, rect or polygon");
	return std::nullopt;
}

std::optional<Region> readRegion(Reader& r, const json::value& v, const std::string& path)
{
	const json::object* o = r.object(&v, path, { "id", "name", "shape", "parent", "attach", "priority", "permissions", "effects", "spawner" });
	if (!o) return std::nullopt;
	Region g;
	bool ok = true;
	if (auto s = r.id(field(o, "id"), join(path, "id"))) g.id = *s; else ok = false;
	if (auto s = r.string(field(o, "name"), join(path, "name"), 0, L::maxNameLength)) g.name = *s; else ok = false;
	if (auto s = readShape(r, field(o, "shape"), join(path, "shape"))) g.shape = std::move(*s); else ok = false;
	if (field(o, "parent")) { if (auto s = r.id(field(o, "parent"), join(path, "parent"))) g.parent = *s; else ok = false; }
	if (field(o, "attach")) { if (auto s = r.id(field(o, "attach"), join(path, "attach"))) g.attach = *s; else ok = false; }
	if (auto n = r.integer(field(o, "priority"), join(path, "priority"), -1000, 1000)) g.priority = static_cast<int32_t>(*n); else ok = false;
	if (const json::value* pv = field(o, "permissions")) {
		const std::string ppath = join(path, "permissions");
		if (const json::object* p = r.object(pv, ppath, { "build", "pvp", "spawn" })) {
			auto perm = [&](std::string_view key, Permission& out) {
				if (!field(p, key)) return;
				if (auto c = r.choice(field(p, key), join(ppath, key), PERMISSIONS)) out = *c == 0 ? Permission::Allow : Permission::Deny;
				else ok = false;
			};
			perm("build", g.build);
			perm("pvp", g.pvp);
			perm("spawn", g.spawn);
		} else ok = false;
	}
	if (const json::value* ev = field(o, "effects")) {
		const std::string epath = join(path, "effects");
		if (const json::array* a = r.array(ev, epath, 0, 16)) {
			for (size_t i = 0; i < a->size(); ++i) {
				const std::string fpath = index(epath, i);
				const json::object* f = r.object(&(*a)[i], fpath, { "stat", "perMinute", "falloff", "channel", "stacking" });
				if (!f) { ok = false; continue; }
				Effect e;
				auto stat = r.choice(field(f, "stat"), join(fpath, "stat"), EFFECT_STATS);
				auto rate = r.integer(field(f, "perMinute"), join(fpath, "perMinute"), -6000, 6000);
				auto falloff = r.choice(field(f, "falloff"), join(fpath, "falloff"), std::array<std::string_view, 2>{ "none", "linear" });
				if (!stat || !rate || !falloff) { ok = false; continue; }
				e.stat = static_cast<EffectStat>(*stat);
				e.perMinute = static_cast<int32_t>(*rate);
				e.linearFalloff = *falloff == 1;
				if (field(f, "channel")) { if (auto c = r.string(field(f, "channel"), join(fpath, "channel"), 1, L::maxTagLength)) e.channel = *c; else ok = false; }
				if (field(f, "stacking")) {
					if (auto c = r.choice(field(f, "stacking"), join(fpath, "stacking"), std::array<std::string_view, 2>{ "strongest", "additive" })) e.additive = *c == 1;
					else ok = false;
				}
				g.effects.push_back(std::move(e));
			}
		} else ok = false;
	}
	if (const json::value* sv = field(o, "spawner")) {
		const std::string spath = join(path, "spawner");
		if (const json::object* so = r.object(sv, spath, { "agent", "maxAlive", "batch", "everySeconds", "total", "startDelay" })) {
			Spawner s;
			auto agent = r.string(field(so, "agent"), join(spath, "agent"), 1, L::maxIdLength);
			auto maxAlive = r.integer(field(so, "maxAlive"), join(spath, "maxAlive"), 1, L::maxSpawnerAlive);
			auto batch = r.integer(field(so, "batch"), join(spath, "batch"), 1, 16);
			auto every = r.integer(field(so, "everySeconds"), join(spath, "everySeconds"), 1, 3600);
			if (agent && maxAlive && batch && every) {
				s.agent = *agent;
				s.maxAlive = static_cast<uint16_t>(*maxAlive);
				s.batch = static_cast<uint16_t>(*batch);
				s.everySeconds = static_cast<uint32_t>(*every);
			} else ok = false;
			if (field(so, "total")) { if (auto n = r.integer(field(so, "total"), join(spath, "total"), 1, 100000)) s.total = static_cast<uint32_t>(*n); else ok = false; }
			if (field(so, "startDelay")) { if (auto n = r.integer(field(so, "startDelay"), join(spath, "startDelay"), 0, 3600)) s.startDelay = static_cast<uint32_t>(*n); else ok = false; }
			g.spawner = std::move(s);
		} else ok = false;
	}
	return ok ? std::optional<Region>(std::move(g)) : std::nullopt;
}

std::optional<LootTable> readLootTable(Reader& r, const json::value& v, const std::string& path)
{
	const json::object* probe = v.is_object() ? &v.get_object() : nullptr;
	const json::value* modeValue = field(probe, "mode");
	const bool weighted = modeValue && modeValue->is_string() && modeValue->get_string() == "weighted";
	const json::object* o = weighted ? r.object(&v, path, { "id", "name", "mode", "rolls", "empty", "entries" })
	                                 : r.object(&v, path, { "id", "name", "mode", "entries" });
	if (!o) return std::nullopt;
	LootTable t;
	bool ok = true;
	if (auto s = r.id(field(o, "id"), join(path, "id"))) t.id = *s; else ok = false;
	if (auto s = r.string(field(o, "name"), join(path, "name"), 0, L::maxNameLength)) t.name = *s; else ok = false;
	if (auto m = r.choice(field(o, "mode"), join(path, "mode"), std::array<std::string_view, 2>{ "weighted", "independent" })) t.weighted = *m == 0;
	else ok = false;
	if (weighted) {
		if (auto n = r.integer(field(o, "rolls"), join(path, "rolls"), 1, 16)) t.rolls = static_cast<uint8_t>(*n); else ok = false;
		if (auto n = r.integer(field(o, "empty"), join(path, "empty"), 0, 10000)) t.empty = static_cast<uint16_t>(*n); else ok = false;
	}
	const std::string epath = join(path, "entries");
	if (const json::array* a = r.array(field(o, "entries"), epath, 1, L::maxLootEntries)) {
		for (size_t i = 0; i < a->size(); ++i) {
			const std::string ipath = index(epath, i);
			const json::object* eo = r.object(&(*a)[i], ipath, { "item", "min", "max", "weight" });
			auto item = eo ? r.string(field(eo, "item"), join(ipath, "item"), 1, L::maxIdLength) : std::nullopt;
			auto min = eo ? r.integer(field(eo, "min"), join(ipath, "min"), 1, 255) : std::nullopt;
			auto max = eo ? r.integer(field(eo, "max"), join(ipath, "max"), 1, 255) : std::nullopt;
			auto weight = eo ? r.integer(field(eo, "weight"), join(ipath, "weight"), 1, 10000) : std::nullopt;
			if (item && min && max && weight)
				t.entries.push_back({ *item, static_cast<uint8_t>(*min), static_cast<uint8_t>(*max), static_cast<uint16_t>(*weight) });
			else ok = false;
		}
	} else ok = false;
	return ok ? std::optional<LootTable>(std::move(t)) : std::nullopt;
}

template <typename T, typename F>
std::vector<T> readList(Reader& r, const json::value* v, const std::string& path, size_t maxSize, F&& readOne, bool& ok)
{
	std::vector<T> out;
	const json::array* a = r.array(v, path, 0, maxSize);
	if (!a) {
		ok = false;
		return out;
	}
	out.reserve(a->size());
	for (size_t i = 0; i < a->size(); ++i) {
		if (auto item = readOne(r, (*a)[i], index(path, i))) out.push_back(std::move(*item));
		else ok = false;
	}
	return out;
}

// --- graph rules (scenario-schema.ts checkScope/checkGraph) -------------------

bool pivotOk(int32_t x, int32_t y)
{
	const int32_t cx = x % TILE_SIZE;
	const int32_t cy = y % TILE_SIZE;
	return (cx == 0 && cy == 0) || (cx == TILE_SIZE / 2 && cy == TILE_SIZE / 2);
}

int orient(std::pair<int32_t, int32_t> p, std::pair<int32_t, int32_t> q, std::pair<int32_t, int32_t> s)
{
	const int64_t v = static_cast<int64_t>(q.first - p.first) * (s.second - p.second) -
		static_cast<int64_t>(q.second - p.second) * (s.first - p.first);
	return (v > 0) - (v < 0);
}

bool polygonSelfIntersects(const std::vector<std::pair<int32_t, int32_t>>& pts)
{
	const size_t n = pts.size();
	for (size_t i = 0; i < n; ++i) {
		for (size_t j = i + 2; j < n; ++j) {
			if (i == 0 && j == n - 1) continue;
			const auto a = pts[i], b = pts[(i + 1) % n], c = pts[j], d = pts[(j + 1) % n];
			const int o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
			if (o1 != o2 && o3 != o4 && o1 && o2 && o3 && o4) return true;
		}
	}
	return false;
}

void checkScope(Report& report, const std::vector<Entity>& entities, const std::vector<Group>& groups,
                const std::vector<Region>& regions, int64_t widthUnits, int64_t heightUnits, const std::string& prefix,
                const std::unordered_set<std::string>& lootIds, bool inTemplate)
{
	std::unordered_map<std::string, std::string> ids;
	auto claim = [&](const std::string& value, const std::string& path) {
		auto [it, inserted] = ids.emplace(value, path);
		if (!inserted) report.error("id.duplicate", path, fmt::format("ID \"{}\" is also used at {}.", value, it->second), value);
	};
	for (size_t i = 0; i < entities.size(); ++i) claim(entities[i].id, fmt::format("{}entities[{}].id", prefix, i));
	for (size_t i = 0; i < groups.size(); ++i) claim(groups[i].id, fmt::format("{}groups[{}].id", prefix, i));
	for (size_t i = 0; i < regions.size(); ++i) claim(regions[i].id, fmt::format("{}regions[{}].id", prefix, i));

	std::unordered_map<std::string, const Group*> byId;
	for (const Group& g : groups) byId.emplace(g.id, &g);
	std::unordered_set<std::string> entityIds;
	for (const Entity& e : entities) entityIds.insert(e.id);
	auto parentOk = [&](const std::string& parent, const std::string& path, const std::string& owner) {
		if (parent.empty() || byId.count(parent)) return;
		report.error(entityIds.count(parent) ? "ref.parent-not-group" : "ref.dangling-parent", path,
			fmt::format("Parent \"{}\" is not a group in this project.", parent), owner);
	};

	bool cyclic = false;
	std::unordered_map<std::string, int64_t> depth;
	for (size_t i = 0; i < groups.size(); ++i) {
		const Group& g = groups[i];
		parentOk(g.parent, fmt::format("{}groups[{}].parent", prefix, i), g.id);
		std::vector<std::string> chain;
		std::unordered_set<std::string> seen;
		int64_t base = 0;
		for (const Group* cursor = &g; cursor;) {
			if (auto it = depth.find(cursor->id); it != depth.end()) {
				base = it->second;
				break;
			}
			if (!seen.insert(cursor->id).second) {
				report.error("graph.cycle", fmt::format("{}groups[{}].parent", prefix, i), fmt::format("Group \"{}\" is its own ancestor.", g.id), g.id);
				cyclic = true;
				base = INT32_MAX;
				break;
			}
			chain.push_back(cursor->id);
			auto next = cursor->parent.empty() ? byId.end() : byId.find(cursor->parent);
			cursor = next == byId.end() ? nullptr : next->second;
		}
		for (size_t k = chain.size(); k-- > 0;) depth[chain[k]] = base >= INT32_MAX ? INT32_MAX : base + static_cast<int64_t>(chain.size() - k);
		const int64_t d = depth[g.id];
		if (d < INT32_MAX && d > L::maxGroupDepth)
			report.error("graph.too-deep", fmt::format("{}groups[{}]", prefix, i),
				fmt::format("Group \"{}\" is nested {} deep; the limit is {}.", g.id, d, L::maxGroupDepth), g.id);
		if (!pivotOk(g.pivotX, g.pivotY))
			report.error("group.pivot", fmt::format("{}groups[{}].pivot", prefix, i), "A pivot must sit on tile centres or tile corners on both axes.", g.id);
	}
	if (cyclic) return;

	for (size_t i = 0; i < entities.size(); ++i) {
		const Entity& e = entities[i];
		const std::string path = fmt::format("{}entities[{}]", prefix, i);
		parentOk(e.parent, path + ".parent", e.id);
		if (e.x >= widthUnits || e.y >= heightUnits)
			report.error("entity.out-of-bounds", path, fmt::format("\"{}\" at ({}, {}) is outside the map.", e.id, e.x, e.y), e.id);
		if (isGridKind(e.kind)) {
			if (e.x % TILE_SIZE != TILE_SIZE / 2 || e.y % TILE_SIZE != TILE_SIZE / 2)
				report.error("entity.off-grid", path, fmt::format("\"{}\" must sit on a tile centre.", e.id), e.id);
		} else if (e.rotation) {
			report.error("entity.rotation", path + ".rotation", "Only grid pieces take quarter-turn rotation; use angle.", e.id);
		}
		if (e.kind != EntityKind::Spawn && (!e.team.empty() || e.weight))
			report.error("entity.spawn-fields", path, "team and weight belong to spawn points.", e.id);
		if ((e.wander && e.kind != EntityKind::Npc) || (e.loadout && e.kind != EntityKind::Spawn) || (e.container && e.kind != EntityKind::Object))
			report.error("entity.kind-fields", path, fmt::format("\"{}\": wander is for NPCs, loadout for spawns, container for objects.", e.id), e.id);
		if (e.container && !e.container->loot.empty() && !lootIds.count(e.container->loot)) {
			const std::string message = fmt::format("\"{}\" uses missing loot table \"{}\".", e.id, e.container->loot);
			if (inTemplate) report.warning("ref.dangling-loot", path + ".container.loot", message, e.id);
			else report.error("ref.dangling-loot", path + ".container.loot", message, e.id);
		}
		if (e.overrides.any()) {
			if (e.kind != EntityKind::Object)
				report.error("override.unsupported", path + ".overrides", "Only object placements take property overrides yet.", e.id);
			if (e.overrides.health && e.overrides.healthMax && *e.overrides.health > *e.overrides.healthMax)
				report.error("override.range", path + ".overrides.health", "Initial health exceeds the maximum.", e.id);
		}
	}

	for (size_t i = 0; i < regions.size(); ++i) {
		const Region& r = regions[i];
		const std::string path = fmt::format("{}regions[{}]", prefix, i);
		parentOk(r.parent, path + ".parent", r.id);
		if (!r.attach.empty() && !entityIds.count(r.attach))
			report.error("ref.dangling-attach", path + ".attach", fmt::format("Region \"{}\" is attached to missing entity \"{}\".", r.id, r.attach), r.id);
		const bool hasPermissions = r.build != Permission::Inherit || r.pvp != Permission::Inherit || r.spawn != Permission::Inherit;
		if (r.effects.empty() && !hasPermissions && !r.spawner)
			report.warning("region.empty", path, fmt::format("Region \"{}\" has no effects or permissions.", r.id), r.id);
		if (r.shape.type == ShapeType::Polygon && polygonSelfIntersects(r.shape.points))
			report.error("region.polygon", path + ".shape", fmt::format("Region \"{}\" polygon crosses itself.", r.id), r.id);
		if (r.shape.type == ShapeType::Polygon && std::any_of(r.effects.begin(), r.effects.end(), [](const Effect& f) { return f.linearFalloff; }))
			report.error("effect.falloff-shape", path + ".effects", fmt::format("Region \"{}\": a fading effect needs a circle or rectangle.", r.id), r.id);
	}
}

// --- canonical form and hash (scenario-canonical.ts) --------------------------

void writeString(std::string& out, std::string_view s)
{
	// JSON.stringify escaping: quote, backslash, and control characters.
	out += '"';
	for (const char ch : s) {
		const unsigned char c = static_cast<unsigned char>(ch);
		switch (c) {
		case '"': out += "\\\""; break;
		case '\\': out += "\\\\"; break;
		case '\b': out += "\\b"; break;
		case '\f': out += "\\f"; break;
		case '\n': out += "\\n"; break;
		case '\r': out += "\\r"; break;
		case '\t': out += "\\t"; break;
		default:
			if (c < 0x20) out += fmt::format("\\u{:04x}", c);
			else out += ch;
		}
	}
	out += '"';
}

const std::set<std::string_view> ID_SORTED = { "entities", "groups", "regions", "templates", "lootTables" };

void writeCanonical(std::string& out, const json::value& v, std::string_view key)
{
	switch (v.kind()) {
	case json::kind::null: out += "null"; return;
	case json::kind::bool_: out += v.get_bool() ? "true" : "false"; return;
	case json::kind::int64: out += std::to_string(v.get_int64()); return;
	case json::kind::uint64: out += std::to_string(v.get_uint64()); return;
	case json::kind::double_: {
		const double d = v.get_double();
		if (std::floor(d) == d && std::fabs(d) < 9007199254740992.0) out += std::to_string(static_cast<int64_t>(d));
		else out += json::serialize(v); // never in a valid project: every number is an integer
		return;
	}
	case json::kind::string: writeString(out, std::string_view(v.get_string().data(), v.get_string().size())); return;
	case json::kind::array: {
		const json::array& a = v.get_array();
		std::vector<const json::value*> items;
		items.reserve(a.size());
		for (const auto& item : a) items.push_back(&item);
		if (ID_SORTED.count(key)) {
			auto idOf = [](const json::value* x) -> std::string_view {
				const json::value* id = x->is_object() ? x->get_object().if_contains("id") : nullptr;
				return id && id->is_string() ? std::string_view(id->get_string().data(), id->get_string().size()) : std::string_view();
			};
			std::stable_sort(items.begin(), items.end(), [&](auto* a2, auto* b2) { return idOf(a2) < idOf(b2); });
		}
		out += '[';
		for (size_t i = 0; i < items.size(); ++i) {
			if (i) out += ',';
			writeCanonical(out, *items[i], {});
		}
		out += ']';
		return;
	}
	case json::kind::object: {
		const json::object& o = v.get_object();
		// Keys are ASCII in every section that reaches the gameplay view, so byte
		// order is the UTF-16 code-unit order the browser sorts by.
		std::vector<std::pair<std::string_view, const json::value*>> entries;
		for (const auto& kv : o) entries.emplace_back(std::string_view(kv.key().data(), kv.key().size()), &kv.value());
		std::sort(entries.begin(), entries.end(), [](const auto& a2, const auto& b2) { return a2.first < b2.first; });
		out += '{';
		for (size_t i = 0; i < entries.size(); ++i) {
			if (i) out += ',';
			writeString(out, entries[i].first);
			out += ':';
			writeCanonical(out, *entries[i].second, entries[i].first);
		}
		out += '}';
		return;
	}
	}
}

std::string gameplayCanonical(const json::object& doc)
{
	json::object view;
	for (std::string_view key : { "format", "schemaVersion", "id", "world", "entities", "groups", "regions", "templates", "lootTables" })
		if (const json::value* v = doc.if_contains(key)) view[key] = *v;
	json::array features;
	if (const json::value* f = doc.if_contains("requiredFeatures"); f && f->is_array()) {
		std::vector<std::string> sorted;
		for (const auto& x : f->get_array())
			if (x.is_string()) sorted.emplace_back(x.get_string().c_str());
		std::sort(sorted.begin(), sorted.end());
		for (const auto& s : sorted) features.emplace_back(s);
	}
	view["requiredFeatures"] = std::move(features);
	std::string out;
	writeCanonical(out, view, {});
	return out;
}

std::string sha256Hex(std::string_view text)
{
	BCRYPT_ALG_HANDLE alg = nullptr;
	BCRYPT_HASH_HANDLE hash = nullptr;
	std::array<unsigned char, 32> digest{};
	bool ok = BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0));
	ok = ok && BCRYPT_SUCCESS(BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0));
	ok = ok && BCRYPT_SUCCESS(BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(text.data())), static_cast<ULONG>(text.size()), 0));
	ok = ok && BCRYPT_SUCCESS(BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0));
	if (hash) BCryptDestroyHash(hash);
	if (alg) BCryptCloseAlgorithmProvider(alg, 0);
	if (!ok) return {};
	std::string hex;
	for (unsigned char b : digest) hex += fmt::format("{:02x}", b);
	return hex;
}

} // namespace

bool ParseResult::hasErrors() const
{
	return std::any_of(diagnostics.begin(), diagnostics.end(), [](const Diagnostic& d) { return d.severity == Severity::Error; });
}

std::string_view severityName(Severity severity)
{
	switch (severity) {
	case Severity::Error: return "error";
	case Severity::Warning: return "warning";
	default: return "info";
	}
}

ParseResult parseProject(std::string_view text)
{
	ParseResult result;
	Report report;
	auto finish = [&]() {
		result.diagnostics = std::move(report.items);
		return std::move(result);
	};

	if (text.size() > static_cast<size_t>(L::maxBytes)) {
		report.error("budget.bytes", "", fmt::format("Project is {} bytes; the limit is {}.", text.size(), L::maxBytes));
		return finish();
	}

	json::value root;
	{
		boost::system::error_code ec;
		json::parse_options options;
		options.max_depth = 32;
		root = json::parse(json::string_view(text.data(), text.size()), ec, {}, options);
		if (ec) {
			report.error("json.syntax", "", fmt::format("Not valid JSON: {}", ec.message()));
			return finish();
		}
	}
	if (!root.is_object()) {
		report.error("schema.not-object", "", "A project must be a JSON object.");
		return finish();
	}
	json::object& doc = root.get_object();

	// Format and version before anything else: a newer document is never
	// partially read.
	const json::value* format = doc.if_contains("format");
	if (!format || !format->is_string() || (format->get_string() != FORMAT && format->get_string() != LEGACY_FORMAT)) {
		report.error("schema.format", "format", fmt::format("Not a Prevast scenario project (format must be \"{}\").", FORMAT));
		return finish();
	}
	// The canonical form carries the format: an old project hashes as a current one.
	doc["format"] = FORMAT;
	const json::value* version = doc.if_contains("schemaVersion");
	if (!version || !version->is_int64() || version->get_int64() < 1) {
		report.error("schema.version", "schemaVersion", "schemaVersion must be a positive integer.");
		return finish();
	}
	if (version->get_int64() > L::schemaVersion) {
		report.error("schema.version-newer", "schemaVersion",
			fmt::format("This project uses schema {}; this server supports up to {}.", version->get_int64(), L::schemaVersion));
		return finish();
	}
	// Migrations, one step per version, on the document itself: the canonical
	// form and hash are those of the migrated project, exactly as in the browser
	// (scenario-schema.ts MIGRATIONS).
	const int64_t migratedFrom = version->get_int64();
	for (int64_t v = migratedFrom; v < L::schemaVersion; ++v) {
		switch (v) {
		case 1: doc["lootTables"] = json::array(); break; // v2: loot tables and population fields
		default:
			report.error("schema.migration-missing", "schemaVersion", fmt::format("No migration from schema {}.", v));
			return finish();
		}
		doc["schemaVersion"] = v + 1;
	}
	if (migratedFrom != L::schemaVersion)
		report.items.push_back({ Severity::Info, "schema.migrated", "schemaVersion", fmt::format("Migrated from schema {}.", migratedFrom), {} });

	// Preflight: dimensions and element budgets before the full parse.
	if (const json::value* world = doc.if_contains("world"); world && world->is_object()) {
		for (std::string_view axis : { "tilesX", "tilesY" }) {
			const json::value* v = world->get_object().if_contains(axis);
			const bool ok = v && v->is_int64() && v->get_int64() >= W::minTiles && v->get_int64() <= W::maxTiles;
			if (!ok)
				report.error("world.size", fmt::format("world.{}", axis),
					fmt::format("{} must be {}..{} tiles, got {}.", axis, W::minTiles, W::maxTiles, v ? json::serialize(*v) : "undefined"));
		}
	}
	const std::array<std::tuple<std::string_view, int32_t, std::string_view>, 5> budgets = { {
		{ "entities", L::maxEntities, "budget.entities" },
		{ "groups", L::maxGroups, "budget.groups" },
		{ "regions", L::maxRegions, "budget.regions" },
		{ "templates", L::maxTemplates, "budget.templates" },
		{ "lootTables", L::maxLootTables, "budget.loot-tables" },
	} };
	for (const auto& [key, max, code] : budgets) {
		const json::value* list = doc.if_contains(key);
		if (list && list->is_array() && list->get_array().size() > static_cast<size_t>(max))
			report.error(std::string(code), std::string(key), fmt::format("{} {}; the limit is {}.", list->get_array().size(), key, max));
	}
	if (report.hasErrors()) return finish();

	// Full strict parse.
	Reader r(report);
	const json::object* top = r.object(&root, "", { "format", "schemaVersion", "id", "title", "revision", "nextId", "requiredFeatures", "content", "world", "entities", "groups", "regions", "templates", "lootTables", "editor" });
	Project project;
	bool ok = top != nullptr;
	if (auto s = r.id(field(top, "id"), "id")) project.id = *s; else ok = false;
	if (auto s = r.string(field(top, "title"), "title", 0, L::maxNameLength)) project.title = *s; else ok = false;
	if (auto n = r.integer(field(top, "revision"), "revision", 0, UINT32_MAX)) project.revision = static_cast<uint32_t>(*n); else ok = false;
	if (!r.integer(field(top, "nextId"), "nextId", 1, INT64_MAX / 2)) ok = false;
	if (const json::array* f = r.array(field(top, "requiredFeatures"), "requiredFeatures", 0, 64)) {
		for (size_t i = 0; i < f->size(); ++i)
			if (auto s = r.string(&(*f)[i], index("requiredFeatures", i), 0, 64)) project.requiredFeatures.push_back(*s);
			else ok = false;
	} else ok = false;
	if (const json::value* c = field(top, "content")) {
		if (const json::object* co = c->is_object() ? &c->get_object() : nullptr) {
			for (const auto& kv : *co) {
				const std::string key(kv.key().data(), kv.key().size());
				if (!r.string(&kv.value(), join("content", key), 0, 128)) ok = false;
			}
		} else {
			r.invalid("content", "expected an object");
			ok = false;
		}
	}
	// Editor metadata never affects a run; the server only requires its shape to be an object.
	if (const json::value* e = field(top, "editor"); e && !e->is_object()) {
		r.invalid("editor", "expected an object");
		ok = false;
	}
	if (const json::object* w = r.object(field(top, "world"), "world", { "tilesX", "tilesY", "seed", "time", "population" })) {
		project.world.tilesX = static_cast<int32_t>(field(w, "tilesX")->get_int64());
		project.world.tilesY = static_cast<int32_t>(field(w, "tilesY")->get_int64());
		if (auto n = r.integer(field(w, "seed"), "world.seed", 0, UINT32_MAX)) project.world.seed = static_cast<uint32_t>(*n); else ok = false;
		if (auto t = r.choice(field(w, "time"), "world.time", std::array<std::string_view, 3>{ "cycle", "day", "night" })) project.world.time = static_cast<TimeOfDay>(*t);
		else ok = false;
		if (const json::object* p = r.object(field(w, "population"), "world.population", { "resources", "structures", "agents" })) {
			auto res = r.boolean(field(p, "resources"), "world.population.resources");
			auto str = r.boolean(field(p, "structures"), "world.population.structures");
			auto agt = r.boolean(field(p, "agents"), "world.population.agents");
			if (res && str && agt) {
				project.world.generateResources = *res;
				project.world.generateStructures = *str;
				project.world.generateAgents = *agt;
			} else ok = false;
		} else ok = false;
	} else ok = false;
	project.entities = readList<Entity>(r, field(top, "entities"), "entities", L::maxEntities, readEntity, ok);
	project.groups = readList<Group>(r, field(top, "groups"), "groups", L::maxGroups, readGroup, ok);
	project.regions = readList<Region>(r, field(top, "regions"), "regions", L::maxRegions, readRegion, ok);
	project.templates = readList<Template>(r, field(top, "templates"), "templates", L::maxTemplates,
		[](Reader& rr, const json::value& v, const std::string& path) -> std::optional<Template> {
			const json::object* o = rr.object(&v, path, { "id", "name", "revision", "size", "source", "entities", "groups", "regions" });
			if (!o) return std::nullopt;
			Template t;
			bool tok = true;
			if (auto s = rr.id(field(o, "id"), join(path, "id"))) t.id = *s; else tok = false;
			if (auto s = rr.string(field(o, "name"), join(path, "name"), 0, L::maxNameLength)) t.name = *s; else tok = false;
			if (auto n = rr.integer(field(o, "revision"), join(path, "revision"), 1, UINT32_MAX)) t.revision = static_cast<uint32_t>(*n); else tok = false;
			if (const json::object* size = rr.object(field(o, "size"), join(path, "size"), { "w", "h" })) {
				auto w = rr.integer(field(size, "w"), join(path, "size.w"), 1, W::maxTiles);
				auto h = rr.integer(field(size, "h"), join(path, "size.h"), 1, W::maxTiles);
				if (w && h) { t.tilesW = static_cast<int32_t>(*w); t.tilesH = static_cast<int32_t>(*h); } else tok = false;
			} else tok = false;
			if (field(o, "source") && !rr.choice(field(o, "source"), join(path, "source"), std::array<std::string_view, 2>{ "authored", "legacy-structure" })) tok = false;
			t.entities = readList<Entity>(rr, field(o, "entities"), join(path, "entities"), L::maxTemplateEntities, readEntity, tok);
			t.groups = readList<Group>(rr, field(o, "groups"), join(path, "groups"), L::maxGroups, readGroup, tok);
			t.regions = readList<Region>(rr, field(o, "regions"), join(path, "regions"), L::maxRegions, readRegion, tok);
			return tok ? std::optional<Template>(std::move(t)) : std::nullopt;
		}, ok);
	project.lootTables = readList<LootTable>(r, field(top, "lootTables"), "lootTables", L::maxLootTables, readLootTable, ok);
	if (!ok || report.hasErrors()) return finish();

	// Loot tables first: containers everywhere refer to them.
	std::unordered_set<std::string> lootIds;
	for (size_t i = 0; i < project.lootTables.size(); ++i) {
		const LootTable& t = project.lootTables[i];
		if (!lootIds.insert(t.id).second)
			report.error("id.duplicate", fmt::format("lootTables[{}].id", i), fmt::format("Loot table ID \"{}\" is used twice.", t.id));
		for (size_t k = 0; k < t.entries.size(); ++k)
			if (t.entries[k].min > t.entries[k].max)
				report.error("loot.range", fmt::format("lootTables[{}].entries[{}]", i, k),
					fmt::format("\"{}\": minimum {} exceeds maximum {}.", t.entries[k].item, t.entries[k].min, t.entries[k].max));
	}

	// Graph rules, for the project and each template in its own local space.
	checkScope(report, project.entities, project.groups, project.regions,
		static_cast<int64_t>(project.world.tilesX) * TILE_SIZE, static_cast<int64_t>(project.world.tilesY) * TILE_SIZE, "", lootIds, false);
	std::unordered_set<std::string> templateIds;
	for (size_t i = 0; i < project.templates.size(); ++i) {
		const Template& t = project.templates[i];
		if (!templateIds.insert(t.id).second)
			report.error("id.duplicate", fmt::format("templates[{}].id", i), fmt::format("Template ID \"{}\" is used twice.", t.id));
		checkScope(report, t.entities, t.groups, t.regions, static_cast<int64_t>(t.tilesW) * TILE_SIZE,
			static_cast<int64_t>(t.tilesH) * TILE_SIZE, fmt::format("templates[{}].", i), lootIds, true);
	}
	for (size_t i = 0; i < project.groups.size(); ++i) {
		const Group& g = project.groups[i];
		if (g.templateLink && !templateIds.count(g.templateLink->id)) {
			const std::string message = fmt::format("Group \"{}\" refers to missing template \"{}\".", g.id, g.templateLink->id);
			if (g.templateLink->linked) report.error("ref.dangling-template", fmt::format("groups[{}].template", i), message, g.id);
			else report.warning("ref.dangling-template", fmt::format("groups[{}].template", i), message, g.id);
		}
	}
	const auto count = [&](EntityKind kind) {
		return std::count_if(project.entities.begin(), project.entities.end(), [&](const Entity& e) { return e.kind == kind; });
	};
	if (count(EntityKind::Npc) > L::maxNpcs)
		report.error("budget.npcs", "entities", fmt::format("{} NPCs; the limit is {}.", count(EntityKind::Npc), L::maxNpcs));
	if (count(EntityKind::Spawn) > L::maxSpawns)
		report.error("budget.spawns", "entities", fmt::format("{} spawns; the limit is {}.", count(EntityKind::Spawn), L::maxSpawns));
	size_t effects = 0;
	for (const Region& reg : project.regions) effects += reg.effects.size();
	if (effects > static_cast<size_t>(L::maxEffects))
		report.error("budget.effects", "regions", fmt::format("{} effects; the limit is {}.", effects, L::maxEffects));
	int64_t agents = count(EntityKind::Agent);
	for (const Region& reg : project.regions)
		if (reg.spawner) agents += reg.spawner->maxAlive;
	if (agents > L::maxScenarioAgents)
		report.error("budget.agents", "entities",
			fmt::format("Placed creatures plus spawner populations reach {}; the limit is {}.", agents, L::maxScenarioAgents));

	if (report.hasErrors()) return finish();
	result.gameplayCanonical = gameplayCanonical(doc);
	result.gameplayHash = sha256Hex(result.gameplayCanonical);
	result.project = std::move(project);
	return finish();
}

// --- self-test ---------------------------------------------------------------

namespace {

std::optional<std::string> readFile(const std::filesystem::path& path)
{
	std::ifstream in(path, std::ios::binary);
	if (!in) return std::nullopt;
	std::ostringstream ss;
	ss << in.rdbuf();
	return ss.str();
}

std::string trimEnd(std::string s)
{
	while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ')) s.pop_back();
	return s;
}

} // namespace

int runScenarioSelfTest(const std::string& corpusDir)
{
	namespace fs = std::filesystem;
	int failures = 0;
	auto fail = [&](const std::string& what) {
		++failures;
		fmt::print(fg(fmt::color::crimson), ">> [scenario selftest] FAIL {}\n", what);
	};
	const fs::path dir(corpusDir);
	const auto manifestText = readFile(dir / "corpus.json");
	if (!manifestText) {
		fail(fmt::format("cannot read {}", (dir / "corpus.json").string()));
		return failures;
	}
	boost::system::error_code ec;
	const json::value manifest = json::parse(*manifestText, ec);
	if (ec || !manifest.is_array()) {
		fail("corpus.json is not a JSON array");
		return failures;
	}
	size_t cases = 0;
	for (const json::value& entry : manifest.get_array()) {
		const json::object& c = entry.as_object();
		const std::string file(c.at("file").as_string().c_str());
		const bool valid = c.at("valid").as_bool();
		const auto text = readFile(dir / file);
		if (!text) {
			fail(fmt::format("{}: cannot read", file));
			continue;
		}
		++cases;
		const ParseResult result = parseProject(*text);
		if (valid && result.hasErrors()) {
			fail(fmt::format("{}: expected valid, got {} ({})", file, result.diagnostics.front().code, result.diagnostics.front().message));
			continue;
		}
		if (!valid) {
			if (!result.hasErrors()) {
				fail(fmt::format("{}: expected errors, got none", file));
				continue;
			}
			for (const json::value& code : c.at("codes").as_array()) {
				const std::string_view expected(code.as_string().data(), code.as_string().size());
				const bool found = std::any_of(result.diagnostics.begin(), result.diagnostics.end(),
					[&](const Diagnostic& d) { return d.code == expected; });
				if (!found) fail(fmt::format("{}: missing diagnostic {} (first was {})", file, expected, result.diagnostics.front().code));
			}
		}
	}
	// The canonical form and hash must be byte-identical to the browser's: a
	// schema 1 project (migrated) and a schema 2 one with every population field.
	for (const std::string name : { "valid-house", "valid-population" }) {
		const auto project = readFile(dir / (name + ".prevast.json"));
		if (!project) {
			fail(fmt::format("cannot read {}.prevast.json", name));
			continue;
		}
		const ParseResult result = parseProject(*project);
		const auto expected = readFile(dir / "canonical" / (name + ".canonical.json"));
		const auto hash = readFile(dir / "canonical" / (name + ".sha256"));
		if (!expected || trimEnd(*expected) != result.gameplayCanonical) fail(fmt::format("canonical form differs from canonical/{}.canonical.json", name));
		if (!hash || trimEnd(*hash) != result.gameplayHash) fail(fmt::format("gameplay hash {} differs from canonical/{}.sha256", result.gameplayHash, name));
	}
	if (failures == 0) fmt::print(fg(fmt::color::green), ">> [scenario selftest] {} corpus cases and the canonical hash agree with the browser.\n", cases);
	return failures;
}

} // namespace scenario
