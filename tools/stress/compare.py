# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

"""Compare two perf_log.csv captures produced by the server's tick profiler.

The server writes one CSV row per 5s window (config.lua `perfStats = true`),
including how many players were online in that window. Comparing two runs by
their *final* numbers is misleading, because a run whose population decays
ends up measuring a different load than one that holds steady. So this bins
both runs by player count and compares like with like.

Usage:
    python compare.py before.csv after.csv
    python compare.py before.csv after.csv --bin 50
"""

from __future__ import annotations

import argparse
import csv
from collections import defaultdict


def load(path: str) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as f:
        return [
            {k: float(v) for k, v in row.items()}
            for row in csv.DictReader(f)
        ]


def bin_rows(rows: list[dict], bin_size: int) -> dict[int, dict]:
    """Group windows by player-count bucket, averaging each metric."""
    buckets: dict[int, list[dict]] = defaultdict(list)
    for row in rows:
        # Bucket by the midpoint of the player-count band.
        buckets[int(row["players"] // bin_size) * bin_size].append(row)

    out = {}
    for key, group in buckets.items():
        n = len(group)
        out[key] = {
            metric: sum(r[metric] for r in group) / n
            for metric in ("ticks_per_s", "avg_ms", "p95_ms", "max_ms",
                           "proj_ms", "move_ms", "dirty_ms", "spec_ms", "flush_ms")
        }
        out[key]["windows"] = n
        out[key]["players"] = sum(r["players"] for r in group) / n
    return out


def fmt_delta(before: float, after: float, higher_is_better: bool) -> str:
    if before == 0:
        return "     n/a"
    pct = (after - before) / before * 100.0
    good = pct > 0 if higher_is_better else pct < 0
    return f"{pct:+7.1f}%{'' if good else ' '}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("before")
    ap.add_argument("after")
    ap.add_argument("--bin", type=int, default=50,
                    help="player-count bucket width (default 50)")
    args = ap.parse_args()

    before = bin_rows(load(args.before), args.bin)
    after = bin_rows(load(args.after), args.bin)
    shared = sorted(set(before) & set(after))

    if not shared:
        raise SystemExit("no overlapping player-count buckets between the two runs")

    print(f"\nComparing {args.before} (before) -> {args.after} (after), "
          f"binned by {args.bin} players\n")
    # flush is shown alongside spec because once getSpectators stopped being
    # O(all entities) it became the largest per-player phase, so a comparison
    # that omits it hides where the remaining time actually goes.
    print(f"{'players':>9} | {'tick/s before':>13} {'after':>7} {'delta':>8} "
          f"| {'ms before':>9} {'after':>7} {'delta':>8} "
          f"| {'spec ms':>12} {'flush ms':>12} {'move ms':>12}")
    print("-" * 120)

    for key in shared:
        b, a = before[key], after[key]
        print(f"{key:>4}-{key + args.bin:<4} | "
              f"{b['ticks_per_s']:>13.1f} {a['ticks_per_s']:>7.1f} "
              f"{fmt_delta(b['ticks_per_s'], a['ticks_per_s'], True):>8} | "
              f"{b['avg_ms']:>9.2f} {a['avg_ms']:>7.2f} "
              f"{fmt_delta(b['avg_ms'], a['avg_ms'], False):>8} | "
              f"{b['spec_ms']:>5.2f}->{a['spec_ms']:<5.2f} "
              f"{b['flush_ms']:>5.2f}->{a['flush_ms']:<5.2f} "
              f"{b['move_ms']:>5.2f}->{a['move_ms']:<5.2f}")

    # Highest common load is the interesting one for a "does it hold up" answer.
    top = shared[-1]
    b, a = before[top], after[top]
    speed_before = 230.0 * min(b["ticks_per_s"], 20.0) / 20.0
    speed_after = 230.0 * min(a["ticks_per_s"], 20.0) / 20.0
    print(f"\nAt the highest shared load ({top}-{top + args.bin} players):")
    print(f"  tick rate     {b['ticks_per_s']:.1f}/s -> {a['ticks_per_s']:.1f}/s "
          f"({fmt_delta(b['ticks_per_s'], a['ticks_per_s'], True).strip()})")
    print(f"  tick cost     {b['avg_ms']:.2f}ms -> {a['avg_ms']:.2f}ms "
          f"({fmt_delta(b['avg_ms'], a['avg_ms'], False).strip()})")
    print(f"  implied walk  {speed_before:.0f} -> {speed_after:.0f} world-units/s "
          f"(of the intended 230)")
    print()


if __name__ == "__main__":
    main()
