// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_CONTENTEXPORT_H
#define FS_CONTENTEXPORT_H

#include <map>
#include <mutex>
#include <string>
#include <vector>

#include <boost/json.hpp>

// Generic XML -> JSON for the content tables.
// The rules here are MIRRORED in shared/typescript/content-format.ts and
// tools/content/xml-to-json.ts; `npm run content:parity` there fails if the two exporters
// disagree. Change ARRAY_PAIRS, NON_INHERITED or a table's id attribute in both places.
namespace contentexport {

struct TableSpec {
	const char* name;        // JSON table name, also the output file stem
	const char* file;        // XML file under contentPath
	const char* root;        // root element
	const char* entry;       // entry element
	const char* idAttribute; // copied to entry.id; nullptr when the table has no numeric id
};

// The twelve tables in content.xml order.
const std::vector<TableSpec>& tables();

// One table -> { name, version, hash, attributes, entries }. Throws std::runtime_error naming
// the file and the reason (unknown repeated pair, missing id, duplicate key, bad base=).
boost::json::object exportTable(const TableSpec& spec, const std::string& fileName);

// Writes <outDir>/<name>.json for every table under xmlDir. Returns false if any failed;
// every failure is printed.
bool exportAll(const std::string& xmlDir, const std::string& outDir);

// RFC 7386 JSON merge patch diff
boost::json::value diffMergePatch(const boost::json::value& from, const boost::json::value& to);

struct ContentPatch {
	std::string name;
	uint32_t fromVersion = 0;
	uint32_t toVersion = 0;
	std::string hash;
	boost::json::value patch;
};

class ContentManager {
public:
	static ContentManager& getInstance()
	{
		static ContentManager instance;
		return instance;
	}

	void init(const std::string& xmlDir, const std::string& configLuaPath);

	std::string getManifestJson() const;
	std::string getTableJson(const std::string& name) const;
	std::string getCombinedHash() const;

	std::vector<ContentPatch> reloadTable(const std::string& name, const std::string& xmlDir = "");
	std::vector<ContentPatch> reloadAll(const std::string& xmlDir = "");

	boost::json::object exportConfigTable(const std::string& configLuaPath, const boost::json::object& modesTable);

private:
	ContentManager() = default;

	struct StoredTable {
		std::string name;
		uint32_t version = 1;
		std::string hash;
		boost::json::object table;
	};

	mutable std::mutex contentMutex;
	std::map<std::string, StoredTable> storedTables;
	std::string xmlDirectory;
	std::string configPath;
};

} // namespace contentexport

#endif

