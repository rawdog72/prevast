# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

"""Stress-test runner: spawn N bots against the Prevast websocket server.

Examples:
    python run.py --bots 100
    python run.py --bots 500 --behavior spin --host 127.0.0.1 --port 7172
    python run.py --bots 200 --ramp 20 --duration 120

The server rate-limits new connections per IP (server.cpp acceptConnection:
>5 connects within 500ms from one IP => 3s block), so bots are spawned in
batches with a delay (--ramp / --ramp-delay) rather than all at once.
"""

from __future__ import annotations

import argparse
import asyncio
import signal

from behaviors import BEHAVIORS, make_behavior
from bot import Bot, ConnectionGate
from stats import Stats, print_periodically


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Prevast server stress test")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7172)
    ap.add_argument("--url", default=None,
                    help="full ws:// url (overrides --host/--port)")
    ap.add_argument("--bots", type=int, default=50, help="number of bots to spawn")
    ap.add_argument("--behavior", default="wander", choices=sorted(BEHAVIORS),
                    help="bot brain (see behaviors.py)")
    ap.add_argument("--tick-hz", type=float, default=10.0,
                    help="bot decision/input rate")
    ap.add_argument("--connect-interval", type=float, default=0.6,
                    help="minimum seconds between connection attempts, GLOBAL "
                         "across all bots. Must stay >0.5s or the server's "
                         "per-IP throttle blocks the IP. Set 0 to disable "
                         "(only safe if the server throttle is relaxed, e.g. a "
                         "loopback exemption).")
    ap.add_argument("--connect-retries", type=int, default=20,
                    help="per-bot connect retries with backoff, as a safety net "
                         "for transient connect failures")
    ap.add_argument("--duration", type=float, default=0,
                    help="stop after N seconds (0 = run until Ctrl+C)")
    ap.add_argument("--warmup", type=float, default=0,
                    help="reset the tick-rate/speed measurements N seconds in, "
                         "so the final summary reflects steady state at full "
                         "bot count rather than the connect ramp. Set it to "
                         "roughly bots*connect-interval.")
    ap.add_argument("--report-interval", type=float, default=2.0,
                    help="seconds between stats lines")
    ap.add_argument("--nick-prefix", default="Bot")
    ap.add_argument("--password", default="",
                    help="login password. Set it to config.lua's adminPassword "
                         "for --behavior combat: bots arm themselves with "
                         "'!item=', which requires admin rights.")
    ap.add_argument("--fire-ratio", type=float, default=1.0,
                    help="fraction of bots that shoot under --behavior combat "
                         "(the rest behave exactly like 'bench'). Lower it if "
                         "bots killing each other churns the population enough "
                         "to make two runs incomparable.")
    ap.add_argument("--aim-ratio", type=float, default=0.5,
                    help="fraction of bots that hold aim under --behavior aim "
                         "(the rest behave exactly like 'bench')")
    ap.add_argument("--aim-weapon", default="sniper",
                    help="weapon key aiming bots arm with under --behavior aim")
    ap.add_argument("--aim-optic", default="",
                    help="optic key aiming bots fit before aiming, e.g. "
                         "tube_scope with --aim-weapon mp5_tactical; empty for none")
    ap.add_argument("--no-respawn", action="store_true",
                    help="do not reconnect a bot after it dies. Off by "
                         "default: bots die of normal gameplay, and without "
                         "reconnecting the population decays during the run, "
                         "which makes builds impossible to compare.")
    ap.add_argument("--gate-statefile", default=None,
                    help="path to a shared timestamp file that makes the "
                         "connect gate global ACROSS processes. Required when "
                         "several run.py processes target one server, since "
                         "the server throttles per IP and per-process gates "
                         "interleave into sub-500ms gaps that trip it. "
                         "shard.py sets this automatically.")
    ap.add_argument("--track-others", action="store_true",
                    help="have each bot maintain a dict of every entity it can "
                         "see. Off by default: no behavior reads it, and the "
                         "per-record parsing it costs saturates the harness's "
                         "single core at ~400 bots, which silently makes the "
                         "TEST the bottleneck instead of the server. Only "
                         "enable for a behavior that needs world awareness, "
                         "and treat server numbers from such a run with care.")
    ap.add_argument("--verbose", action="store_true",
                    help="print per-bot errors")
    return ap.parse_args()


def spawn_bots(args, stats, gate: ConnectionGate) -> list[asyncio.Task]:
    # All bots are created up front; the shared gate serializes their actual
    # connection attempts, so there's no batch/ramp loop to manage.
    url = args.url or f"ws://{args.host}:{args.port}/?token=stress"
    tasks: list[asyncio.Task] = []
    for i in range(args.bots):
        bot = Bot(
            index=i,
            url=url,
            behavior=make_behavior(args.behavior, fire_ratio=args.fire_ratio,
                                   aim_ratio=args.aim_ratio, aim_weapon=args.aim_weapon,
                                   aim_optic=args.aim_optic),
            nickname=f"{args.nick_prefix}{i:03d}",
            password=args.password,
            tick_hz=args.tick_hz,
            stats=stats,
            verbose=args.verbose,
            connect_retries=args.connect_retries,
            gate=gate,
            respawn=not args.no_respawn,
            track_others=args.track_others,
        )
        tasks.append(asyncio.create_task(bot.run(), name=f"bot-{i}"))
    return tasks


async def main() -> None:
    args = parse_args()
    stats = Stats()
    stop = asyncio.Event()

    loop = asyncio.get_running_loop()
    # SIGINT/SIGTERM -> graceful stop (Windows delivers SIGINT via KeyboardInterrupt
    # if add_signal_handler is unavailable, handled in the __main__ guard).
    for sig in (getattr(signal, "SIGINT", None), getattr(signal, "SIGTERM", None)):
        if sig is None:
            continue
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass  # Windows selector loop: fall back to KeyboardInterrupt

    est = args.bots * args.connect_interval
    print(f"target {args.url or f'ws://{args.host}:{args.port}'} | "
          f"{args.bots} bots | behavior={args.behavior} | tick={args.tick_hz}Hz | "
          f"connect-interval={args.connect_interval}s (~{est:.0f}s to ramp all)")

    async def warmup_reset() -> None:
        if args.warmup <= 0:
            return
        try:
            await asyncio.wait_for(stop.wait(), timeout=args.warmup)
        except asyncio.TimeoutError:
            stats.reset_measurements()
            print(f"--- warmup over ({args.warmup:.0f}s): measurements reset, "
                  f"{stats.connected} bots live; steady-state measurement begins ---",
                  flush=True)

    gate = ConnectionGate(args.connect_interval, args.gate_statefile)
    printer = asyncio.create_task(print_periodically(stats, args.report_interval, stop))
    warmup = asyncio.create_task(warmup_reset())
    bot_tasks = spawn_bots(args, stats, gate)
    print(f"{len(bot_tasks)} bots created; connecting through the gate...")

    async def wait_for_end() -> None:
        if args.duration > 0:
            try:
                await asyncio.wait_for(stop.wait(), timeout=args.duration)
            except asyncio.TimeoutError:
                pass
        else:
            await stop.wait()

    try:
        await wait_for_end()
    finally:
        stop.set()
        for t in bot_tasks:
            t.cancel()
        await asyncio.gather(*bot_tasks, return_exceptions=True)
        printer.cancel()
        warmup.cancel()
        await asyncio.gather(printer, warmup, return_exceptions=True)
        print(stats.summary())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\ninterrupted")
