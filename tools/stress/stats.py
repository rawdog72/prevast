# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

"""Aggregate counters shared across all bots, plus a periodic printer."""

from __future__ import annotations

import asyncio
import time
from collections import Counter


class Stats:
    def __init__(self) -> None:
        self.start = time.monotonic()
        self.connecting = 0
        self.connected = 0
        self.peak_connected = 0
        self.disconnected = 0
        self.errors = 0
        self.retries = 0
        self.deaths = 0
        self.sent = 0
        self.recv_frames = 0
        self.recv_bytes = 0
        self.error_kinds: Counter[str] = Counter()
        self._last_sent = 0
        self._last_recv = 0
        self._last_time = self.start

        # --- server-health metrics -----------------------------------------
        # The server pushes one ENTITY_UPDATES frame per player per game tick, so the
        # per-bot ENTITY_UPDATES rate is a direct read of the achieved server tick rate
        # (target 20/s). Movement applies a FIXED distance per tick, so when
        # the tick rate sags, players literally walk slower -- observed_speed
        # measures exactly that symptom in world-units/sec.
        self.units_frames = 0
        self.move_dist = 0.0
        self.move_time = 0.0
        self._last_units = 0

    def reset_measurements(self) -> None:
        """Zero the rate/speed accumulators but keep connection bookkeeping.

        Called once the ramp has finished (see run.py --warmup) so the summary
        describes steady state at full bot count instead of being dragged down
        by the minutes spent connecting.
        """
        self.start = time.monotonic()
        self.units_frames = 0
        self.move_dist = 0.0
        self.move_time = 0.0
        self.sent = 0
        self.recv_frames = 0
        self.recv_bytes = 0
        self._last_sent = 0
        self._last_recv = 0
        self._last_units = 0
        self._last_time = self.start
        # peak_connected is the denominator for the per-bot tick rate; re-seed
        # it from the CURRENT live count so a mid-ramp peak can't inflate it.
        self.peak_connected = self.connected

    def on_connected(self) -> None:
        self.connected += 1
        self.peak_connected = max(self.peak_connected, self.connected)

    def on_disconnected(self) -> None:
        self.connected = max(0, self.connected - 1)
        self.disconnected += 1

    def on_error(self, exc: BaseException) -> None:
        self.errors += 1
        self.error_kinds[type(exc).__name__] += 1

    def on_retry(self) -> None:
        self.retries += 1

    def on_death(self) -> None:
        self.deaths += 1

    def on_sent(self) -> None:
        self.sent += 1

    def on_recv(self, nbytes: int) -> None:
        self.recv_frames += 1
        self.recv_bytes += nbytes

    def on_units(self) -> None:
        self.units_frames += 1

    def on_self_move(self, dist: float, dt: float) -> None:
        """One observed self-displacement sample: `dist` world units covered
        over `dt` seconds of wall time. Accumulated as a ratio of sums so the
        average is time-weighted rather than skewed by short samples."""
        self.move_dist += dist
        self.move_time += dt

    @property
    def observed_speed(self) -> float:
        """Mean movement speed actually achieved by the bots, world-units/sec."""
        return self.move_dist / self.move_time if self.move_time > 0 else 0.0

    @property
    def units_per_bot(self) -> float:
        """Mean ENTITY_UPDATES frames/sec/bot over the whole run ~= server tick rate."""
        uptime = time.monotonic() - self.start
        if uptime <= 0 or self.peak_connected == 0:
            return 0.0
        return self.units_frames / uptime / self.peak_connected

    def snapshot_line(self) -> str:
        now = time.monotonic()
        dt = max(1e-6, now - self._last_time)
        sent_rate = (self.sent - self._last_sent) / dt
        recv_rate = (self.recv_frames - self._last_recv) / dt
        units_delta = self.units_frames - self._last_units
        # Per-bot tick rate over this window only, so ramp-up doesn't drag it.
        tick_rate = units_delta / dt / self.connected if self.connected else 0.0
        self._last_sent, self._last_recv = self.sent, self.recv_frames
        self._last_units, self._last_time = self.units_frames, now
        uptime = now - self.start
        return (f"[{uptime:6.0f}s] live={self.connected:<4d} peak={self.peak_connected:<4d} "
                f"disc={self.disconnected:<4d} err={self.errors:<4d} retry={self.retries:<4d} "
                f"deaths={self.deaths:<4d} "
                f"tick={tick_rate:5.1f}/s speed={self.observed_speed:6.1f}u/s "
                f"tx={sent_rate:7.1f}/s rx={recv_rate:7.1f}/s "
                f"rxTotal={self.recv_bytes/1e6:6.1f}MB")

    def summary(self) -> str:
        uptime = time.monotonic() - self.start
        lines = [
            "",
            "==== stress test summary ====",
            f"duration:        {uptime:.1f}s",
            f"peak connected:  {self.peak_connected}",
            f"disconnects:     {self.disconnected}",
            f"errors:          {self.errors}",
            f"connect retries: {self.retries}",
            f"deaths:          {self.deaths}",
            f"frames sent:     {self.sent}",
            f"frames recv:     {self.recv_frames} ({self.recv_bytes/1e6:.1f} MB)",
            "",
            "---- server health (the numbers that matter) ----",
            f"tick rate:       {self.units_per_bot:.2f} ENTITY_UPDATES/s/bot   (target 20.00)",
            f"observed speed:  {self.observed_speed:.1f} world-units/s "
            f"(walk 230 / sprint 322 at a healthy 20 Hz)",
        ]
        if self.error_kinds:
            lines.append("error breakdown: " +
                         ", ".join(f"{k}={v}" for k, v in self.error_kinds.most_common()))
        return "\n".join(lines)


async def print_periodically(stats: Stats, interval: float, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            print(stats.snapshot_line(), flush=True)
