# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

"""The aim-and-scopes benchmark: one server session, four bot runs, tick cost each.

Runs run.py --behavior aim four times against an already running
`npm run server:benchmark`: nobody aiming, half the bots aiming an SMG
Tactical with a tube scope, half aiming the sniper, and nobody aiming again.
The two baselines show the noise. It reads the perf_log.csv rows each run
added, and only windows at full population count.

Run from runtime/benchmark, where the server writes perf_log.csv:
    python ../../tools/stress/aimbench.py --password <config.lua adminPassword>

"p99" is the median of the windows' max tick. A 5 s window at 20 Hz holds 100
ticks, and the median maximum of 100 ticks sits at the 99.3rd percentile.
"""

from __future__ import annotations

import argparse
import csv
import statistics
import subprocess
import sys
import time
from pathlib import Path

SCENARIOS = [
    ("nobody aiming", ["--aim-ratio", "0"]),
    ("half aiming, tube scope", ["--aim-ratio", "0.5", "--aim-weapon", "mp5_tactical",
                                 "--aim-optic", "tube_scope"]),
    ("half aiming, sniper", ["--aim-ratio", "0.5", "--aim-weapon", "sniper"]),
    ("nobody aiming, again", ["--aim-ratio", "0"]),
]


def rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8272)
    ap.add_argument("--bots", type=int, default=100)
    ap.add_argument("--duration", type=float, default=150)
    ap.add_argument("--warmup", type=float, default=75,
                    help="seconds before run.py's own numbers count; keep it past the ramp")
    ap.add_argument("--pause", type=float, default=20,
                    help="seconds between runs, so the last run's players are gone")
    ap.add_argument("--password", required=True, help="config.lua adminPassword: bots arm with !item=")
    ap.add_argument("--perf-log", default="perf_log.csv")
    args = ap.parse_args()

    run_py = Path(__file__).with_name("run.py")
    log = Path(args.perf_log)
    results: list[tuple[str, list[dict[str, str]]]] = []
    for index, (name, extra) in enumerate(SCENARIOS):
        if index:
            time.sleep(args.pause)
        before = len(rows(log))
        print(f"=== {name} ===", flush=True)
        subprocess.run([
            sys.executable, str(run_py),
            "--port", str(args.port), "--bots", str(args.bots), "--behavior", "aim",
            "--duration", str(args.duration), "--warmup", str(args.warmup),
            "--report-interval", "30", "--password", args.password,
            "--nick-prefix", f"Aim{index}b", *extra,
        ], check=True)
        # Full population only: the ramp and the drain measure something else.
        # Measured from the run's own peak: the server may cap players below --bots.
        new = rows(log)[before:]
        peak = max((float(r["clients"]) for r in new), default=0.0)
        steady = [r for r in new if peak > 0 and float(r["clients"]) >= 0.9 * peak]
        results.append((name, steady))

    print()
    print(f"{'scenario':<26} {'windows':>7} {'avg ms':>7} {'p95 ms':>7} {'p99 ms':>7} "
          f"{'spec ms':>8} {'tick/s':>7}")
    for name, steady in results:
        if not steady:
            print(f"{name:<26} no windows at full population: raise --duration")
            continue

        def median(key: str) -> float:
            return statistics.median(float(r[key]) for r in steady)

        print(f"{name:<26} {len(steady):>7} {median('avg_ms'):>7.2f} {median('p95_ms'):>7.2f} "
              f"{median('max_ms'):>7.2f} {median('spec_ms'):>8.2f} {median('ticks_per_s'):>7.1f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
