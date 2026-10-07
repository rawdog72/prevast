# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

"""Run a stress test as several run.py processes and aggregate the results.

Why this exists
---------------
The harness is single-threaded asyncio, so one run.py process is capped at one
CPU core. Measured on a 4-core box, one process reaches ~57% of a core at 200
bots -- i.e. it saturates somewhere around 350-400 bots. Past that point the
process being measured is the TEST, not the server, and the numbers invert in
a way that is easy to mistake for a good result: the server looks faster
(input is arriving more slowly than the bots intended) while the bot-side tick
rate looks worse (received frames are not being drained promptly).

Sharding the bots over several processes keeps every shard well under its core
so the server stays the bottleneck. The server's own perf_log.csv remains the
authoritative record; the aggregate printed here is the client-side view.

Usage:
    python shard.py --bots 500 --shards 3 --behavior bench --duration 600 --warmup 220

Each shard gets a distinct --nick-prefix, because config.lua sets
allowClones = false and identical nicknames across shards would be rejected.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="sharded Prevast stress test")
    ap.add_argument("--bots", type=int, default=500)
    ap.add_argument("--shards", type=int, default=3)
    ap.add_argument("--behavior", default="bench")
    ap.add_argument("--duration", type=float, default=600)
    ap.add_argument("--warmup", type=float, default=0)
    ap.add_argument("--connect-interval", type=float, default=0.6,
                    help="AGGREGATE seconds between connection attempts across "
                         "all shards. Each shard's own gate is set to this "
                         "times --shards, because ConnectionGate is per-process "
                         "and the server throttles per IP, not per process.")
    ap.add_argument("--report-interval", type=float, default=30)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7172)
    ap.add_argument("--logdir", default=".")
    ap.add_argument("--tag", default="run")
    ap.add_argument("--password", default="",
                    help="login password; set to config.lua's adminPassword "
                         "when --behavior combat (bots self-arm via '!item=')")
    ap.add_argument("--fire-ratio", type=float, default=1.0,
                    help="fraction of bots that shoot under --behavior combat")
    return ap.parse_args()


# Pulled from each shard's "==== stress test summary ====" block.
_PATTERNS = {
    "peak": re.compile(r"peak connected:\s+(\d+)"),
    "deaths": re.compile(r"deaths:\s+(\d+)"),
    "errors": re.compile(r"errors:\s+(\d+)"),
    "disconnects": re.compile(r"disconnects:\s+(\d+)"),
    "tick": re.compile(r"tick rate:\s+([\d.]+)"),
    "speed": re.compile(r"observed speed:\s+([\d.]+)"),
}


def main() -> int:
    args = parse_args()
    logdir = Path(args.logdir)
    logdir.mkdir(parents=True, exist_ok=True)

    per_shard = args.bots // args.shards
    counts = [per_shard] * args.shards
    for i in range(args.bots - per_shard * args.shards):
        counts[i] += 1

    # The shards must share ONE connect gate, not merely a matching rate.
    # The server blocks on any single inter-arrival gap <= 500ms (and then
    # extends that block on every retry), so what has to be bounded is the
    # minimum gap, not the average. Independent per-process gates cannot do
    # that however they are tuned, because they interleave: 3 shards at one
    # connect per 1.8s each averages a safe 1.67/s and still produced 124
    # retries with 43 of 167 bots connected after 300s.
    #
    # A shared statefile + lockfile serializes every shard's attempts through
    # one timestamp, so the aggregate gap is always >= --connect-interval.
    # Ramp time is therefore the same as unsharded; sharding buys CPU
    # headroom for the harness, not a faster ramp.
    gate_state = str(Path(args.logdir) / f"{args.tag}_gate.state")
    for stale in (gate_state, gate_state + ".lock"):
        try:
            Path(stale).unlink()
        except OSError:
            pass
    ramp = args.bots * args.connect_interval
    print(f"{args.bots} bots over {args.shards} shards ({counts}), "
          f"behavior={args.behavior}, ramp~{ramp:.0f}s, duration={args.duration:.0f}s")
    if args.warmup and args.warmup < ramp + 20:
        print(f"  [warn] --warmup {args.warmup:.0f}s is below the ~{ramp:.0f}s ramp; "
              f"steady-state numbers will include connecting bots")

    procs = []
    for i, n in enumerate(counts):
        log = logdir / f"{args.tag}_shard{i}.log"
        cmd = [
            sys.executable, "run.py",
            "--bots", str(n),
            "--behavior", args.behavior,
            "--duration", str(args.duration),
            "--warmup", str(args.warmup),
            "--report-interval", str(args.report_interval),
            "--connect-interval", str(args.connect_interval),
            "--gate-statefile", gate_state,
            "--host", args.host, "--port", str(args.port),
            "--nick-prefix", f"S{i}b",
            "--password", args.password,
            "--fire-ratio", str(args.fire_ratio),
        ]
        fh = open(log, "w")
        procs.append((subprocess.Popen(cmd, stdout=fh, stderr=subprocess.STDOUT), fh, log))
        print(f"  shard {i}: {n} bots -> {log}")

    t0 = time.monotonic()
    for p, fh, _ in procs:
        p.wait()
        fh.close()
    print(f"all shards finished in {time.monotonic() - t0:.0f}s\n")

    agg = {k: [] for k in _PATTERNS}
    for _, _, log in procs:
        text = log.read_text(errors="replace")
        for key, pat in _PATTERNS.items():
            m = pat.search(text)
            agg[key].append(float(m.group(1)) if m else float("nan"))

    def total(k):
        return sum(v for v in agg[k] if v == v)

    def weighted(k):
        # Weight per-bot rates by each shard's peak so shards of unequal size
        # do not count equally.
        pairs = [(v, w) for v, w in zip(agg[k], agg["peak"]) if v == v and w == w]
        tw = sum(w for _, w in pairs)
        return sum(v * w for v, w in pairs) / tw if tw else float("nan")

    print("==== aggregate across shards ====")
    print(f"peak connected:  {total('peak'):.0f}")
    print(f"disconnects:     {total('disconnects'):.0f}")
    print(f"errors:          {total('errors'):.0f}")
    print(f"deaths:          {total('deaths'):.0f}")
    print(f"tick rate:       {weighted('tick'):.2f} ENTITY_UPDATES/s/bot   (target 20.00)")
    print(f"observed speed:  {weighted('speed'):.1f} world-units/s")
    print("\nper shard: " + ", ".join(
        f"[{i}] peak={int(p)} tick={t:.2f} speed={s:.1f}"
        for i, (p, t, s) in enumerate(zip(agg["peak"], agg["tick"], agg["speed"]))))
    print("\nServer-side perf_log.csv next to the executable is authoritative "
          "for tick rate and phase costs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
