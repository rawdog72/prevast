// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_MAPSIZE_H
#define FS_MAPSIZE_H

#include "core/definitions.h"
#include "core/position.h"

// Generated from shared/editor/limits.json before compilation (see the
// PrevastEditorContract target); the browser editor reads the same file.
#include "contract/editor_limits.h"

#include <cstdint>
#include <limits>
#include <string>

// The size of the world, in TILES, and the one place it lives.
//
// Tiles rather than world units because that is the unit everything downstream
// actually reasons in: structures are placed on a tile grid, resources spawn on
// tile centres, the map importer indexes tiles, and the client allocates a
// tile-indexed `matrix`. The old config keys (mapWidth/mapHeight, world units)
// meant nearly every consumer opened with a `/ 100`, and each of those was a
// silent truncation waiting for someone to write a size that was not a whole
// number of tiles.
//
// Deliberately NOT a ConfigManager entry any more. The size is now mutable at
// runtime (!map-size), and ConfigManager is "what the file said" -- a value that
// can drift away from the file after boot does not belong in it. The config
// keys still SEED this at startup; see loadFromConfig.
//
// Threading: written only from the dispatcher thread, inside the regeneration
// job that !map-size queues, and read from the dispatcher thread. No reader runs
// on an io thread -- every packet handler posts its work to the dispatcher.
namespace MapSize {

// --- Limits ------------------------------------------------------------------
//
// The floor is what leaves anywhere to stand: a spawn needs one clear tile with
// its 3x3 neighbourhood inside the map (isSpawnPositionValid), and the edge is
// excluded, so anything under about 8 tiles has no legal spawn at all. 10 gives
// a little room above that.
static constexpr int32_t MIN_TILES = EditorContract::World::minTiles;

// The ceiling is where `Position` runs out, and it is a HARD wall rather than
// a policy: x/y are uint16, so the largest representable coordinate is 65535
// and the last fully addressable tile is 654. Map's tile grid is sized to match
// (GRID_DIM 656). Going above this means 32-bit positions in the entity record
// -- four coordinates per record, so +8 bytes on the hottest write path in the
// server -- plus every clamp and narrowing cast that feeds them.
//
// This used to be 255, for a reason that no longer applies:
// ProtocolGame::sendCitiesLocation packed each city/house tile coordinate into
// ONE BYTE, so a wider map wrapped every minimap marker. That packet carries
// uint16 pairs now (with the usual pad byte -- see sendCitiesLocation).
//
// The other nearby wall is deliberately NOT enforced, because it is not a hard
// failure: a fully built map costs 2 entity ids per tile, so a pool smaller
// than 2*N*N cannot build the whole map out. At 24-bit ids that is no longer
// reachable at any legal size (655x655 needs 858,050 of 16,777,215), and an
// undersized pool is reported at boot and on every resize rather than
// forbidden. See maxStaticObjectsForMap in definitions.h.
static constexpr int32_t MAX_TILES = EditorContract::World::maxTiles;

// CITY_LOCATION_NONE is gone. It was a sentinel filling the single city slot
// CITIES_LOCATION reserved when no city had been built; that packet now leads
// with a CITY COUNT and carries every city, so "no city" is the count 0 and
// there is nothing to reserve a magic value for.

// The size every content count in XML is authored against. A map of exactly
// this size asks for precisely what the files say; anything else scales
// relative to it. Changing this renumbers every world.
static constexpr int32_t REFERENCE_TILES_X = EditorContract::World::referenceTilesX;
static constexpr int32_t REFERENCE_TILES_Y = EditorContract::World::referenceTilesY;

// The contract is data, so prove here that the data fits the engine it
// describes: a limits.json edit that outgrows Position cannot compile.
static_assert(EditorContract::World::tileSize == TILE_SIZE,
	"shared/editor/limits.json world.tileSize must equal TILE_SIZE");
static_assert(EditorContract::World::positionMax ==
	std::numeric_limits<decltype(Position::x)>::max(),
	"shared/editor/limits.json world.positionMax must be the Position coordinate maximum");
static_assert(MIN_TILES >= 10 && MIN_TILES <= MAX_TILES, "map tile limits are inverted");
static_assert(static_cast<int64_t>(MAX_TILES) * TILE_SIZE - 1 <= EditorContract::World::positionMax,
	"maxTiles * tileSize exceeds the largest Position coordinate");
static_assert(REFERENCE_TILES_X >= MIN_TILES && REFERENCE_TILES_X <= MAX_TILES &&
	REFERENCE_TILES_Y >= MIN_TILES && REFERENCE_TILES_Y <= MAX_TILES,
	"reference map size is outside the tile limits");

// --- Live size ---------------------------------------------------------------

int32_t tilesX();
int32_t tilesY();

// Tile count, as the budget arithmetic wants it. int64 because 255*255 fits an
// int32 easily but the callers multiply this by percentages.
int64_t tileCount();

// The same size in world units, which is what Position and every collision test
// speak. Always an exact multiple of TILE_SIZE -- that is the whole point of
// storing tiles.
inline int32_t widthUnits() { return tilesX() * TILE_SIZE; }
inline int32_t heightUnits() { return tilesY() * TILE_SIZE; }

// --- Setup and change --------------------------------------------------------

// Reads mapTilesX / mapTilesY from the already-loaded config and installs them.
// Accepts the retired mapWidth / mapHeight (world units) as a fallback so an
// unmigrated config still boots, loudly. Called once, from Game::start.
void loadFromConfig();

// Is this a legal size? Changes nothing either way. Separate from apply so a
// command can refuse a bad size the moment it is typed without the caller having
// to install it and put it back -- which does not work, because there is nothing
// to put back once it is installed.
bool validate(int32_t newTilesX, int32_t newTilesY, std::string& error);

// Validates a proposed size and, if it is legal, installs it. Returns false and
// fills `error` with something an admin can act on otherwise.
//
// This ONLY moves the numbers. Everything that has to happen around a size
// change -- evicting what is now out of bounds, rebuilding the world, telling
// the clients -- belongs to Game::runNextRegeneration's resize branch.
bool apply(int32_t newTilesX, int32_t newTilesY, std::string& error);

// Parses "<x>:<y>" in tiles. Digits and one colon only: stoi would quietly
// accept "60abc" as 60, and a typo that silently resizes the world to something
// other than what was typed is the failure mode worth spending code on.
bool parse(const std::string& text, int32_t& outTilesX, int32_t& outTilesY, std::string& error);

// --- Content budget ----------------------------------------------------------
//
// The problem this exists to solve: every content count in XML is ABSOLUTE.
// resources.xml asks for ~5,460 units and modes.xml for 12 structures, of which
// city0 alone is 50x53 = 2,650 tiles. Against 150x150 that is ~39% occupancy and
// fine. Against 60x60 (3,600 tiles) the city does not fit and the resources want
// more slots than the map has.
//
// Leaving that to the placement loops does not work. They terminate -- resources
// have a barren-pass bound -- but they terminate by PACKING THE MAP SOLID, and a
// map with no walkable ground is not a small world, it is a broken one. So
// generation gets a tile budget and spends it in priority order.
struct ContentBudget
{
	// Tiles generated content may occupy in total. Player builds are not charged
	// against it -- this is about what the world ARRIVES with.
	int64_t totalTiles = 0;
	int64_t spentTiles = 0;

	int64_t remaining() const { return totalTiles > spentTiles ? totalTiles - spentTiles : 0; }
	void spend(int64_t tiles) { spentTiles += tiles; }

	// The most one phase may take, as a percentage of the WHOLE budget.
	//
	// Exists because "first phase spends freely, second takes the remainder" is
	// only fair when the first one scales with the map. Structure footprints do
	// not -- modes.xml asks for one of each template at every size -- so on a
	// small map the structures would eat the entire allowance and leave a world
	// with houses and almost no resources in it. A ceiling on the phase that
	// runs first is what guarantees the phase that runs second a share.
	int64_t shareFor(int percent) const { return (totalTiles * percent) / 100; }
};

// How much of the content budget structures may take before resources get their
// look. 50 never binds at the reference size -- the shipped structures are 4,798
// tiles against a 5,625 allowance there -- and only starts refusing templates on
// a map small enough that placing all of them would crowd out the resources.
static constexpr int STRUCTURE_BUDGET_SHARE_PERCENT = 50;

// The budget for the current map size and worldFillPercent.
ContentBudget makeContentBudget();

// One scale factor, held as a rational so that every content type scales by
// EXACTLY the same amount. Rounding each type independently through a float
// drifts the mix -- a small map would end up with proportionally more of
// whatever happened to round up, which is the one thing scaling must not do.
//
// num == den is the identity and is guaranteed to return the authored count
// unchanged, so a reference-sized map generates precisely what the XML says.
struct ContentScale
{
	int64_t num = 1;
	int64_t den = 1;

	uint32_t apply(uint32_t authored) const;
	bool isIdentity() const { return num == den; }
};

// The DENSITY factor on its own: tileCount / referenceTileCount, or the
// identity when scaleWorldContentToMapSize is off. Stage 1 of contentScaleFor
// with no budget clamp.
//
// For content that is a live POPULATION rather than a placement. Agents occupy
// no permanent ground, so there is no tile budget to charge them against and
// the clamp would be meaningless -- but how many of them are alive should still
// track the area a player has to cross to meet one, or a big map is empty of
// threat in exactly the way it would be empty of trees without scaling.
ContentScale densityScale();

// How much of `authoredTotal` this map should actually get, expressed as a
// scale to apply to each individual count.
//
// Two stages, combined into one rational:
//   1. DENSITY. Scaled by tileCount / referenceTileCount when
//      scaleWorldContentToMapSize is on, so a small map is a small version of
//      the same world rather than the same world compressed, and a large one is
//      not unfarmably sparse. Off = XML counts are absolute (the old behaviour).
//   2. BUDGET. Clamped to `budgetTiles`, whatever stage 1 asked for.
//
// `growthPercent` DAMPS stage 1 -- how much of the map's area growth this
// content type follows:
//
//     factor = 1 + (tileCount / referenceTiles - 1) * growthPercent/100
//
//   100 = follow it exactly. Right for scenery: nineteen times the ground
//         should hold nineteen times the trees, or the map is unfarmable.
//     0 = do not grow at all; the XML count is absolute at every size.
//
// Anything between is for content that should get MORE numerous on a bigger
// map without keeping its density -- buildings, which are landmarks. At full
// scaling a 655x655 map came out with 209 houses, which is more town than
// wilderness; the point of a big map is that you can walk for a while.
//
// Note the shape: the damping multiplies the DISTANCE from the reference size,
// not the count. So the factor is exactly 1 at the reference size for ANY
// growthPercent, and a reference-sized world stays byte-identical whatever this
// is set to. That is a property of the formula, not a special case in it.
ContentScale contentScaleFor(uint32_t authoredTotal, int64_t budgetTiles,
                             int growthPercent = 100);

} // namespace MapSize

#endif // FS_MAPSIZE_H
