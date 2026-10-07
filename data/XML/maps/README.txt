Editor maps
===========

One map is ONE FILE in this directory, named <key>.map. Every *.map here is
loaded at startup, in sorted file-name order. There is no manifest and nothing
to keep in sync: drop a file in, restart (or !map-reload), and it is there.

(Only *.map is read. This file is ignored, as is anything else.)


THE FORMAT
----------

A small `key = value` header, then the string the client's map editor produces
when you press its copy button:

    # anything after a # is a comment
    key      = trader_outpost
    auto     = true
    origin   = 0,0
    respawn  = 60000
    bulldoze = false

    !b=28:40:40:0!b=28:41:40:0!b=62:40:40:0...

The record parser ignores every line that has no '!' in it, which is what lets
the header sit above the records in the same file. It also means a file that is
NOTHING but a raw editor paste is a valid map: the header is optional, and the
file name becomes the key.

Records are the editor's own:

    !b=<itemId>[:<subtype>]:<tileX>:<tileY>:<rotation>

Whitespace and line breaks between records mean nothing, so wrap them however
reads best.


HEADER KEYS
-----------

  key       the name every !map-* command uses. Defaults to the file name, so
            renaming the file renames the map. Letters, digits, . _ - only.

  auto      true  (default): this map is part of what the WORLD is made of.
                  World generation stamps it, and a !seed rebuild replays it.
            false: loaded and placeable with !map-place, but a rebuild will
                  not put it back.

            This is the difference between the LIBRARY (what maps exist) and
            the MANIFEST (what this world is built from). A map pasted live
            with !map= is auto=false, because it was placed once because an
            admin asked once. It is why a pasted map does not reappear after
            !clean and !seed=random.

  enabled   false parses the map and reports it, but never places it.

  origin    tile offset added to every record, so the same drawing can be
            stamped somewhere else. 0,0 places it exactly where it was drawn.

  mode      only load under this game mode (config.lua gameMode). Omit for
            "every mode".

  respawn   0 (default): stamp once and leave it alone. Above 0, the map is
            re-stamped on that cycle in milliseconds: anything of its own that
            has been destroyed comes back, the way cities do. A respawn NEVER
            destroys anything. A tile now holding a player's build, a creature,
            loot or a regrown resource is skipped until it is free again.

  bulldoze  true (default): the first stamp flattens whatever is on the tile,
            including objects players built. false: those tiles are skipped and
            reported instead. Only affects the initial stamp; a respawn always
            skips.


ADMIN COMMANDS
--------------

All require the admin password from config.lua.

  !map=                 open a paste session, then paste the editor string. The
                        client splits the line into one message per record, so
                        the session collects them and commits about a second
                        after the last one arrives.
  !map=<name>           same, but names the map instead of pasteN.
  !map-end              commit the paste now instead of waiting.
  !map-at=<x>:<y>       tile offset applied to the NEXT paste.
  !map-here             set that offset to the tile you are standing on.
  !map-place=<id>       stamp a map where it was drawn.
  !map-place=<id>@<x>:<y>   stamp it with its corner at that tile instead.
  !map-place=<id>@here      stamp it with its corner where you stand.
                        The records keep the coordinates they were drawn at and
                        the difference is applied as it is placed, so the same
                        drawing can be put down in several places. A map whose
                        footprint would not fit is refused whole and told where
                        it WOULD fit, never clipped.
  !map-preview=<id>     what stamping it would do, without doing any of it:
  !map-preview=<id>@<x>:<y>   size, entity id cost, and exactly what it would
                        destroy (player builds, city tiles, resources). There
                        is no undo for what a stamp bulldozes, so this is how
                        you find out it lands on somebody's base beforehand.
  !map-undo             take the most recent stamp back off. Only a STAMP can
                        be undone: what it bulldozed is gone, and a !clean
                        cannot be undone at all.
  !map-list             what is loaded, how many objects each has, how many are
                        still STANDING, and whether it is part of the world.
  !map-save=<id>        write a map to this directory as <id>.map, header and
                        all, ready to load. Defaults to the map you pasted
                        last. The previous version is kept as .map.bak.
  !map-clear=<id>       remove what a map has standing. The map STAYS loaded,
                        so !map-place puts it back.
  !map-forget=<id>      clear it and drop it from the library. One loaded from
                        a file returns on !map-reload; a paste is gone.
  !map-keep=<id>        make it part of the world (auto = true above), so a
                        !seed rebuild replays it.
  !map-drop=<id>        the reverse: leave it standing, stop replaying it.
  !map-reload           re-read this directory.
  !map-respawn=<ms|off>          set the cycle for every map.
  !map-respawn=<id>:<ms|off>     set it for one map.

  !clean                remove EVERY object, resource and loot item on the map.
                        Players and bots are never touched. Must be issued twice
                        within 10s to confirm. Cities, maps and resources COME
                        BACK on their respawn timers: this empties the world, it
                        does not stop it refilling.
  !clean-hard           the same sweep, plus every placement is retired and
                        resource and structure respawn are switched off, so
                        nothing comes back until you place it. Also spelled
                        !blank. Confirmed separately from !clean.
  !respawn-resources=<ms|off>    resource regrowth. off also stops the periodic
                        relocation, which would otherwise thin the map out with
                        nothing putting anything back.
  !respawn-structures=<ms|off>   city/house respawn cadence, for all of them.


CITIES AND HOUSES
-----------------

Buildings come from structures.xml templates, and worldgen scatters them by the
counts in modes.xml. These commands address the ones that are STANDING.

  !structure-list           the templates that exist, with their sizes.
  !structure-list-placed    what is standing: id, template, tile, size,
                            city/house, and how much of it is left. Everything
                            below names a building by the id this prints, or
                            by "here" for the one you are standing in.
  !structure-place=<key>            put one down where you stand.
  !structure-place=<key>:<x>:<y>    ...or at a tile. Add :city to file it under
                            the minimap's city icons instead of houses.
  !structure-remove=<n>     take one down. Its ground and its minimap marker
                            are free immediately; the objects come off over the
                            next few seconds.
                            <n> may also be a template key ("house0") or "here".
                            When several of that template are standing it says
                            so and lists them nearest-first, rather than
                            guessing which one you meant.
  !structure-move=<n>:<x>:<y>       remove and re-place in one step, through
                            every check a placement makes. Refused without
                            taking anything down if the destination is no good.
  !structure-respawn=<n>:<on|off>   stop THIS building rebuilding itself, which
                            is what you want when one city keeps growing back
                            through your map. The cadence itself stays global
                            (!respawn-structures).

Before 2026-08-13 there was no way to take a building down: the tracking list
only ever grew, so a misplaced city held its ground for the life of the process
and !clean could not touch it.

A !seed or !map-size rebuild turns resource and structure respawn back ON,
whatever they were set to. Asking for a new world is asking for a world that
behaves like one; say !respawn-*=off again after the rebuild to hold it still.

To hand-place a map over an empty world and keep it that way:

    !clean-hard
    !clean-hard
    !map-place=example_small

Large maps belong in a file, not in chat. A paste is capped by the WebSocket
frame the client can send, at roughly 800 records.


WHERE THIS DIRECTORY IS
-----------------------

Inside contentPath (config.lua), beside the XML content files, so one directory
holds the whole content set and one copy of it can serve every build tree.

Before 2026-08-13 a map was two artifacts: metadata in XML/maps.xml and records
in an exe-relative maps/*.txt, with !map-save writing the second and leaving the
first to be hand-edited. A leftover maps.xml is converted into this directory
once, on the next boot, and can then be deleted.
