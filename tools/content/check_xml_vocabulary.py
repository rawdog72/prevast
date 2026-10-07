#!/usr/bin/env python3
# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

"""
Find XML attributes no loader ever reads.

pugixml returns a default for an attribute that is not there, so a typo is
silent: write `healthMaxx="500"` and the object gets healthMax 0 with nothing
said. That is the same failure family as every other bug this content layer has
produced, and it is the one thing a schema would catch.

Rather than hand-maintain an allowed-list that would rot, this derives the
vocabulary from the source: every `attribute("name")` literal in the C++
loaders is a name the server knows. Anything present in the XML but absent from
that set is either a typo or dead data.

    python tools/check_xml_vocabulary.py         # check data/XML and its includes
    python tools/check_xml_vocabulary.py -v      # also list the known set

Limits, and why the output needs reading rather than trusting: an attribute
fetched through a variable or a helper's parameter is invisible to this scan, so
a name it reports may still be live. Confirm each hit before deleting anything.
Names confirmed live-but-indirect belong in INDIRECT below.
"""

import argparse
import os
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Read through a variable or a helper parameter, so the literal never appears
# next to attribute(). Each was confirmed by reading the call site.
INDIRECT = {
    # agent.cpp resistances: frac("melee") etc. via a lambda taking the name
    "melee", "piercing", "explosion", "energy",
    # condition.cpp: forbid(name, bit) and parseFraction(resNode, "all", ...).
    "move", "run", "attack", "use", "build", "turn", "all",
    # content_validation.h: item(node) defaults its attribute name to "item".
    "item",
    # skills.xml: presentation metadata exported generically by contentexport.cpp
    # and consumed by the TypeScript skill-tab UI/schema.
    "icon",
}


def loader_attributes(root):
    """Every attribute("...") literal in the C++ sources."""
    names = set()
    pat = re.compile(r'attribute\("([A-Za-z_][A-Za-z0-9_]*)"\)')
    helpers = re.compile(r'\b(?:number|flag|text|key|item)\([^,\n]+,\s*"([A-Za-z_][A-Za-z0-9_]*)"')
    for fn in sorted(str(p) for p in Path(root).rglob("*") if p.is_file()):
        if not fn.endswith((".cpp", ".h")):
            continue
        with open(os.path.join(root, fn), encoding="utf-8", errors="replace") as f:
            source = f.read()
            names.update(pat.findall(source))
            names.update(helpers.findall(source))
    return names


def xml_attributes(xmldir):
    """attribute name -> {(file, element, sample value)}"""
    found = {}
    pending = [os.path.join(xmldir, fn) for fn in sorted(os.listdir(xmldir)) if fn.endswith(".xml")]
    seen = set()
    data = os.path.realpath(os.path.dirname(xmldir))
    while pending:
        path = os.path.realpath(pending.pop(0))
        if path in seen:
            continue
        seen.add(path)
        if os.path.commonpath([data, path]) != data:
            raise ValueError("include escapes the data directory: " + path)
        fn = os.path.relpath(path, xmldir)
        try:
            tree = ET.parse(path)
        except ET.ParseError as e:
            raise ValueError("PARSE FAIL %s: %s" % (fn, e)) from e
        def walk(node):
            if node.tag == "client":
                return
            if node.tag == "include":
                pending.append(os.path.join(os.path.dirname(path), node.attrib["file"]))
            for name, value in node.attrib.items():
                found.setdefault(name, set()).add((fn, node.tag, value))
            for child in node:
                walk(child)

        walk(tree.getroot())
    return found


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--xml", default=os.path.join("data", "XML"))
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    known = loader_attributes(os.path.join(ROOT, "apps", "server", "src")) | INDIRECT
    present = xml_attributes(os.path.join(ROOT, args.xml))

    print("loaders read %d distinct attribute names (+%d indirect)" % (
        len(known) - len(INDIRECT), len(INDIRECT)))
    print("%s uses %d\n" % (args.xml, len(present)))

    if args.verbose:
        print("known to the loaders:")
        print("  " + ", ".join(sorted(known)) + "\n")

    unread = sorted(n for n in present if n not in known)
    if not unread:
        print("OK - every attribute in the XML is one a loader asks for.")
        return 0

    width = max(len(n) for n in unread)
    print("%-*s  used by" % (width, "attribute"))
    print("-" * (width + 46))
    for name in unread:
        where = sorted(present[name])
        shown = ", ".join("%s <%s %s=\"%s\">" % (f[:-4], tag, name, val)
                          for f, tag, val in where[:2])
        if len(where) > 2:
            shown += " (+%d more)" % (len(where) - 2)
        print("%-*s  %s" % (width, name, shown))
    print("-" * (width + 46))
    print("%d attribute name(s) no loader reads. Each is a typo, dead data, or "
          "read indirectly - check before deleting." % len(unread))
    return 1


if __name__ == "__main__":
    sys.exit(main())
