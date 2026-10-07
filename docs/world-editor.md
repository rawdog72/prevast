# World & Mode Editor

The editor opens from the start screen (**World editor**). It authors a portable project, `*.prevast.json`, that a server can validate and run.

## Authoring

- **Library** (left): every placeable piece from the content tables, plus creatures, NPCs and player spawns. Search, filter by category, star favorites. **Templates** lists the project's reusable templates; *Import game structures* turns `structures.xml` houses and cities into templates.
- **Tools**: Select (V), Paint (B), Line (L), Rectangle (U), Fill (G), Erase (E), Eyedropper (I), Region (K). R rotates the selection or the piece being placed. F1 lists every shortcut.
- **Inspect** (right): with nothing selected it edits the project, the world (size, seed, time of day, opt-in generated content) and the loot tables. With a selection it edits position, facing, names, tags and per-instance overrides (maximum/initial health, destructible, door state), shown as inherited, overridden or mixed.
- **Groups**: Ctrl+G groups the selection; *As house* / *As city* label it. A label adds no gameplay. Moving, rotating or duplicating a group carries its members and attached regions; an invalid move changes nothing and highlights the offenders.
- **Walk** (P): walk the map offline with game visuals and basic collision. E toggles a door in the preview only, C turns collision off. Nothing there changes the project.

Undo and redo work per stroke, drag or edit. Hidden or locked layers affect editing only.

## Regions and effects

Regions are circles, rectangles or simple polygons (no crossing edges). *Add effect area* on a piece makes a circle that follows it; it switches off for good when that piece is destroyed. A region over a group is one source, however many walls the group has.

- **Permissions** (building, PvP, spawning) inherit the world's rule unless a region sets them. Where regions overlap, the higher priority wins and at equal priority deny wins. PvP needs both fighters' positions to allow it, so shooting out of a safe zone is as harmless as shooting into one. Spawn deny covers players, creatures and spawners.
- **Effects** change a gauge by signed points per minute: health, food, warmth, stamina and radiation (positive contaminates, negative cleanses). Rates run in steps of 6 a minute; the inspector shows when a value is rounded. Inside an effect the gauge's ordinary drift against it pauses and drift the same way adds: a +90 radiation zone contaminates although radiation normally fades, and a warm shelter warms at night.
- **Stacking**: within one stack channel (default: the stat's name) the strongest effect per direction applies, or effects marked *Adds up* sum; channels add. *Fades to edge* runs from full strength at the centre to nothing at the edge, on circles and rectangles.

## Population

- **Player spawns** are chosen by weight. A blocked point tries the tiles around it, then another point; if none is clear the player stands on the heaviest point and the server logs `spawn.none-safe`. Authored spawns may sit on floors; only solid pieces block them. A spawn point's **loadout**, when set, replaces the starting kit (an empty loadout means nothing).
- **NPCs** replace the game's usual NPC spawns. *Wander* overrides how far one strolls. Shop stock belongs to the placement: moving an NPC keeps its stock, duplicating one starts fresh, and raising `scenarioStateGeneration` in the profile's `config.lua` restocks every shop.
- **Containers** keep the type's default contents unless given authored ones: fixed items fill slots in order, then a loot table fills the empty slots after them. A refill fills empty slots only, so what players put in stays.
- **Loot tables** (project inspector): *weighted* makes a number of picks, each one entry by weight or nothing by the empty weight; *independent* rolls each entry's own chance out of 10000. Counts are uniform between min and max. Rolls depend only on the world seed and the container, so editing anything else never rerolls a chest.
- **Creatures** placed on the map appear once when the world opens. A region's **spawner** keeps up to *Alive at most* of one creature inside the region, spawning *Per wave* every *Every (s)* after *First after (s)*, until *Total* if set. Spawn points must be free ground the region allows spawning on.

The Issues tab reports what the server will: missing content, items that do not fit a stack, blocked or denied spawns, creatures standing on solid pieces (the server will not open), spawners with no free tile and equal-priority regions with opposite permissions. These are static checks; a clear tile does not prove a level plays.

## Saving and files

Projects live in the browser (IndexedDB). **Save** writes a new revision and keeps the previous one. If another tab saved first, the editor offers a copy instead of overwriting. Autosave keeps a draft every few seconds, and reopening a project offers to recover it. **Export** downloads the `.prevast.json` file; **Import** opens one, or a `.template.json`. **Legacy map…** converts old `!b=` map code or `.map` files into placements. Nothing else is inferred. Schema 1 projects open as schema 2 with an empty loot table list.

## Project format

There are three representations, kept apart:

- **Project**: the versioned JSON document the editor saves, with stable IDs, authoring metadata and embedded template revisions.
- **Validated scenario**: what the server builds from one project revision. The server validates the project itself and never trusts the browser's result; both sides compute the same canonical form and gameplay hash (cross-language fixtures in `tests/fixtures/scenarios/canonical`).
- **Runtime state**: entities, damage, inventories, timers and stock created by a server run. It is never written back into the project.

| Section | Contents |
| --- | --- |
| Header | `format`, `schemaVersion`, project ID, title, revision, required features. |
| World | Size in tiles, seed, time of day and opt-in generated population. |
| Entities | Stable ID, typed content reference, position, facing, variant, supported overrides, tags. |
| Groups | Stable ID, name, ordinary/house/city label, parent, pivot. |
| Templates | Embedded, versioned definitions; each placed copy records the template and revision it came from. |
| Regions | Shapes, attachment, priority, permissions, effects and spawners. |
| Loot tables | Weighted or independent entries used by containers. |
| Editor | Camera and other non-gameplay settings, ignored at runtime. |

Rules:

- Content is referenced by stable typed keys, never by runtime entity IDs or inventory item IDs. Variants are explicit.
- IDs survive edits, moves, rotations and reopening. Duplicating remaps internal references and creates new identities.
- Sizes are in tiles, positions and distances in integer world units, rotations in quarter turns. Tile-centred placement matches the server exactly.
- Duplicate IDs, cycles, dangling references, invalid transforms, non-finite or overflowing numbers and excessive nesting are rejected; sizes are checked before anything large is allocated.
- Schema migrations are explicit and deterministic. A newer project is refused, never partly read.
- Only supported overrides are stored; an absent field inherits.
- Missing content is reported, never silently substituted.
- Projects saved under the earlier `devast-scenario` format id (`*.devast.json`) still load and are treated as `prevast-scenario`.

## Running a project on a server

The server validates independently of the browser, with the same rules and diagnostic codes, and computes the same gameplay hash:

```powershell
cd runtime/development
../../dist/server/Release/prevast_server.exe --validate-scenario path/to/project.prevast.json
```

To run a project as the world, use the isolated `scenario` profile, which `npm run setup` creates: own ports (8272/8271/8280), no database, no listing, no account progress. Put the exported project at `runtime/scenario/scenario.prevast.json` (or set `scenarioFile` in its `config.lua`), then:

```powershell
npm run server:scenario
```

A project that cannot run in full is refused before the server opens: invalid, missing content, a creature that cannot stand where it was placed, or a feature this build does not implement. Everything the editor authors today runs; rules, objectives and rounds do not exist yet. Population is explicit: generated structures, resources and roaming creatures appear only if the project opts in.

`npm run test:scenario` boots a server on `tests/fixtures/scenarios/boot/population-live.prevast.json` and checks the spawn and loadout, a regional gauge rate, an NPC and a spawner's population cap.

## Limits

`shared/editor/limits.json` is the single source for map size and project budgets (NPCs, spawners, loot tables, loadouts). TypeScript imports it; the C++ build generates `build/generated/contract/editor_limits.h` from it, and `MapSize` refuses to compile limits that do not fit a `Position`.
