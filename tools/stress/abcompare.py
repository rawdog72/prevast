# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

"""Pool the legs of an A,B,B,A benchmark and report per-metric deltas with a t.

Why pooling and not a single before/after pair: the first A/B ever run on this
box showed `move_ms` -- code that had not been touched -- moving 17%, purely
because one leg landed on a noisier machine. Four legs in A,B,B,A order cancel
that drift, and the *untouched* metrics coming out flat is what makes a real
delta believable. A big number with noisy controls means nothing.

Rows are filtered on `clients` (players with a live client), not `players`.
A dropped connection leaves the character in the world, so `players` keeps
counting bodies the visibility loop skips entirely -- a run reporting 255
players can be doing the work of 46. If a capture has no `clients` column it
predates that fix and cannot be compared to one that has it.

Usage:
    python abcompare.py --a captures/projA.csv captures/projA2.csv \
                        --b captures/projB.csv captures/projB2.csv --min-clients 60
"""

from __future__ import annotations

import argparse
import csv
import math

# Reported in this order. The first group is what a change is usually aimed at;
# the second is the control group -- phases a given change should NOT move.
METRICS = [
    "ticks_per_s", "avg_ms", "p95_ms", "max_ms",
    "proj_ms", "spec_ms", "flush_ms", "move_ms", "dirty_ms",
    "seen_per_tick", "rec_per_tick", "projectiles", "things",
    "post_avg_ms", "write_avg_ms",
]

HIGHER_IS_BETTER = {"ticks_per_s"}
# Load descriptors, not results: a delta here means the two runs were not
# comparable, which invalidates everything else rather than being a win.
#
# rec_per_tick is the important one and it is the correctness check, not just a
# load check: it counts the EntityUpdate records actually handed to clients. A
# change that makes the visibility diff cheaper must leave it alone -- if it
# drops, the server got faster by telling clients less, which is a bug.
#
# seen_per_tick is deliberately NOT here. It counts entities the sweep looked
# at, which is the thing an optimisation is allowed to cut; it describes the
# mechanism, not the workload.
LOAD = {"rec_per_tick", "projectiles", "things"}


def load(path: str, min_clients: int) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if rows and "clients" not in rows[0]:
        raise SystemExit(
            f"{path} has no 'clients' column: it predates the live-client "
            f"counter and cannot be compared against a capture that has it.")
    out = []
    for row in rows:
        if int(float(row["clients"])) < min_clients:
            continue
        out.append({k: float(v) for k, v in row.items() if v != ""})
    return out


def mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else float("nan")


def welch(a: list[float], b: list[float]) -> float:
    """Welch's t. Unequal variance is the norm here -- a slower build is also
    a more variable one, so pooled-variance t would overstate significance."""
    na, nb = len(a), len(b)
    if na < 2 or nb < 2:
        return float("nan")
    ma, mb = mean(a), mean(b)
    va = sum((x - ma) ** 2 for x in a) / (na - 1)
    vb = sum((x - mb) ** 2 for x in b) / (nb - 1)
    denom = math.sqrt(va / na + vb / nb)
    return (mb - ma) / denom if denom > 0 else float("nan")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--a", nargs="+", required=True, help="control (before) captures")
    ap.add_argument("--b", nargs="+", required=True, help="treatment (after) captures")
    ap.add_argument("--min-clients", type=int, default=1,
                    help="drop windows below this live-client count (ramp/teardown)")
    args = ap.parse_args()

    rows_a = [r for p in args.a for r in load(p, args.min_clients)]
    rows_b = [r for p in args.b for r in load(p, args.min_clients)]
    if not rows_a or not rows_b:
        raise SystemExit("no windows survived the --min-clients filter")

    print(f"\nA: {', '.join(args.a)}  ({len(rows_a)} windows)")
    print(f"B: {', '.join(args.b)}  ({len(rows_b)} windows)")
    print(f"filtered to clients >= {args.min_clients}\n")

    print(f"{'metric':>14} {'A':>10} {'B':>10} {'delta':>9} {'t':>7}   note")
    print("-" * 72)
    for metric in METRICS:
        a = [r[metric] for r in rows_a if metric in r]
        b = [r[metric] for r in rows_b if metric in r]
        if not a or not b:
            continue
        ma, mb = mean(a), mean(b)
        pct = (mb - ma) / ma * 100.0 if ma else float("nan")
        t = welch(a, b)
        if metric in LOAD:
            note = "LOAD -- must match" if abs(pct) < 10 else "LOAD MISMATCH"
        elif abs(t) < 2:
            note = "flat (control)"
        else:
            good = pct > 0 if metric in HIGHER_IS_BETTER else pct < 0
            note = "better" if good else "WORSE"
        print(f"{metric:>14} {ma:>10.3f} {mb:>10.3f} {pct:>+8.1f}% {t:>7.1f}   {note}")

    print("\nA metric that moved with a t below ~2 is noise. A change that moves "
          "its target\nwhile the untouched phases stay flat is the shape to look for.\n")


if __name__ == "__main__":
    main()
