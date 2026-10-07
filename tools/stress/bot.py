# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

"""A single simulated player.

Bot owns the websocket, the login handshake, the receive loop that keeps a
lightweight view of the world (own position/guid/health + other visible
entities), and a fixed-rate "tick" that asks a Behavior what to do next.

The world-view is intentionally minimal right now (enough for movement and
future targeting). It is populated from UNITS frames, so smarter behaviors
later can read `self.others` to chase/avoid/attack without touching this file.
"""

from __future__ import annotations

import asyncio
import math
import os
import random
import time

import websockets

import protocol as P


class ConnectionGate:
    """Rate-limiter for connection *attempts* shared by every bot.

    What the server actually does (server.cpp acceptConnection), which is worth
    stating precisely because the obvious reading is wrong: it tracks the gap
    since the PREVIOUS attempt from that IP, not a sliding window. Any gap
    under 5s increments a counter; when that counter passes 5 it resets, and if
    that particular gap was <= 500ms the IP is blocked for 3s. While blocked,
    every further attempt adds another 250ms. So retries extend their own
    block, which is how this livelocks.

    The consequence for the harness: it is not the average connect rate that
    matters, it is whether ANY single inter-arrival gap dips below 500ms. Keep
    every gap above that and the block never engages at all.

    `statefile` makes the gate work ACROSS processes. Without it each shard
    gates independently, so three shards at one connect per 1.8s each still
    interleave into frequent sub-500ms gaps — measured: 124 retries and 43 of
    167 bots connected after 300s. With it, all shards serialize through one
    lock and one shared timestamp, so the aggregate gap is always >= interval.
    Set interval <= 0 to disable gating entirely.
    """

    # A lock file older than this is assumed to be from a crashed process.
    STALE_LOCK_SECONDS = 30.0

    def __init__(self, interval: float, statefile: str | None = None):
        self.interval = interval
        self._lock = asyncio.Lock()
        self._last = 0.0
        self.statefile = statefile
        self._lockfile = (statefile + ".lock") if statefile else None

    async def wait(self) -> None:
        if self.interval <= 0:
            return
        if self.statefile is None:
            async with self._lock:
                loop = asyncio.get_running_loop()
                delay = self.interval - (loop.time() - self._last)
                if delay > 0:
                    await asyncio.sleep(delay)
                self._last = loop.time()
            return

        # Cross-process path. The in-process lock still serializes this
        # process's own bots so they don't spin on the file lock in a pack.
        async with self._lock:
            await self._wait_shared()

    async def _wait_shared(self) -> None:
        while True:
            try:
                # O_EXCL create is the cross-process mutex: exactly one process
                # can hold it, and it works the same on Windows and POSIX.
                fd = os.open(self._lockfile, os.O_CREAT | os.O_EXCL | os.O_RDWR)
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(self._lockfile) > self.STALE_LOCK_SECONDS:
                        os.unlink(self._lockfile)
                        continue
                except OSError:
                    pass  # someone else cleaned it up; just retry
                await asyncio.sleep(0.02)
                continue

            try:
                try:
                    with open(self.statefile, "r") as f:
                        last = float(f.read().strip() or 0.0)
                except (OSError, ValueError):
                    last = 0.0

                # Sleeping while holding the lock is the point: it blocks the
                # other shards too, which is what makes the gap global.
                delay = self.interval - (time.time() - last)
                if delay > 0:
                    await asyncio.sleep(delay)

                with open(self.statefile, "w") as f:
                    f.write(str(time.time()))
                return
            finally:
                os.close(fd)
                try:
                    os.unlink(self._lockfile)
                except OSError:
                    pass


class BotView:
    """What a bot currently believes about the world. Fed by the recv loop."""

    def __init__(self) -> None:
        self.guid: int | None = None            # our own player slot id
        self.mode_id: int = 0
        self.x: int = 0
        self.y: int = 0
        self.aim: int = 0                        # last rotation we sent (degrees)
        self.sprinting: bool = False
        self.alive: bool = True
        # guid/id -> last known UnitRecord for every *other* entity in view.
        self.others: dict[int, P.UnitRecord] = {}
        # Item ARRIVALS since the last drain, oldest first -- INVENTORY_SLOT
        # messages with a non-zero iid. Only combat-style behaviors read this
        # (they need the uid of a weapon they just had the server give them);
        # it is a bounded list, not a growing inventory model, so an unread
        # queue cannot leak.
        #
        # An arrival is not necessarily a NEW item: INVENTORY_SLOT also restates
        # a slot whose count or ammo changed. That is fine for every caller here
        # -- they clear the queue first, then ask for exactly one thing.
        self.new_items: list[P.InventorySlot] = []
        self.last_packet_time: float = time.monotonic()
        # Previous self-position sample, for the observed-speed metric.
        self.prev_x: int | None = None
        self.prev_y: int | None = None
        self.prev_time: float = 0.0

    # A single tick can never legitimately move a player this far; anything
    # bigger is a respawn/teleport and must not pollute the speed average.
    MAX_TICK_JUMP = 200.0

    def note_self_position(self, rec: P.UnitRecord, stats=None) -> None:
        # The server sends where we're heading this tick as (end_x, end_y).
        now = time.monotonic()
        nx, ny = rec.end_x, rec.end_y

        if stats is not None and self.prev_x is not None:
            dist = math.hypot(nx - self.prev_x, ny - self.prev_y)
            dt = now - self.prev_time
            # Drop teleports and samples spanning a stall/reconnect gap.
            if dist < self.MAX_TICK_JUMP and 0.0 < dt < 1.0:
                stats.on_self_move(dist, dt)

        self.prev_x, self.prev_y, self.prev_time = nx, ny, now
        self.x, self.y = nx, ny


class Bot:
    def __init__(self, index: int, url: str, behavior, *,
                 token: str | None = None, nickname: str | None = None,
                 skin: int | None = None, password: str = "",
                 tick_hz: float = 10.0, stats=None, verbose: bool = False,
                 connect_retries: int = 20, connect_backoff: float = 1.5,
                 gate: "ConnectionGate | None" = None, respawn: bool = True,
                 track_others: bool = False):
        self.index = index
        self.url = url
        self.behavior = behavior
        self.token = token if token is not None else f"stressbot-{index}-{random.randint(0, 1 << 30)}"
        self.nickname = nickname if nickname is not None else f"Bot{index:03d}"
        self.skin = skin if skin is not None else random.randint(0, 5)
        self.password = password
        self.tick_interval = 1.0 / tick_hz
        self.stats = stats
        self.verbose = verbose
        # The server throttles new connections per IP (server.cpp: >5 within
        # 500ms => temporary block that extends while hammered). Retrying with
        # backoff lets a blocked bot wait the block out and get in, instead of
        # failing permanently — so all bots eventually connect from one IP.
        self.connect_retries = connect_retries
        self.connect_backoff = connect_backoff
        self.gate = gate
        self.respawn = respawn
        # Maintain view.others (every visible entity) or only our own record.
        # Defaults to off: no behavior in behaviors.py reads view.others, and
        # populating it is what pushes the single-threaded harness past one
        # core at ~400 bots, at which point it -- not the server -- is the
        # bottleneck being measured. Turn it on for a behavior that needs to
        # see the world (targeting, chasing, avoidance).
        self.track_others = track_others

        self.ws: websockets.WebSocketClientProtocol | None = None
        self.view = BotView()
        self._closing = False

    # -- outbound -----------------------------------------------------------

    async def send(self, message: bytes) -> None:
        # Binary, always: the game port refuses text frames. `message` comes
        # from a protocol.py builder, which is what owns the byte layout.
        if self.ws is None:
            return
        try:
            await self.ws.send(message)
            if self.stats:
                self.stats.on_sent()
        except websockets.ConnectionClosed:
            self._closing = True

    # -- lifecycle ----------------------------------------------------------

    async def run(self) -> None:
        """Run sessions until cancelled.

        Bots die of normal gameplay (gauges, radiation) and the server drops
        the socket, so a single-session bot permanently leaves the test. That
        made the population decay mid-run -- with 500 bots the count peaked
        around 320 and then fell -- which is useless for a benchmark, since
        load has to be held constant to compare builds. Reconnecting on death
        (what a real player does) holds the population at the target.
        """
        while True:
            try:
                await self._run_session()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - report and let the runner count it
                if self.verbose:
                    print(f"[bot {self.index}] error: {exc!r}")
                if self.stats:
                    self.stats.on_error(exc)

            if not self.respawn:
                return

            # Fresh identity for the new life: reusing the token would look
            # like a session takeover/reconnect rather than a new spawn.
            self.token = f"stressbot-{self.index}-{random.randint(0, 1 << 30)}"
            self.view = BotView()
            self._closing = False
            await asyncio.sleep(random.uniform(0.5, 2.0))

    async def _connect(self):
        """Open the websocket, retrying past the server's per-IP connect
        throttle. Returns the connected ws, or None if we gave up / are
        shutting down."""
        last_exc: Exception | None = None
        for attempt in range(self.connect_retries + 1):
            if self._closing:
                return None
            # Serialize this attempt against every other bot's attempts so the
            # server's per-IP connect counter never crosses its block threshold.
            if self.gate is not None:
                await self.gate.wait()
            try:
                return await websockets.connect(
                    self.url, max_size=None, open_timeout=15, ping_interval=None)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if self.stats:
                    self.stats.on_retry()
                if self.verbose:
                    print(f"[bot {self.index}] connect attempt {attempt + 1} failed: {exc!r}")
                # Back off past the throttle's block window (3s+, and it grows
                # while hammered), with jitter so retrying bots don't
                # resynchronize into a fresh burst.
                delay = min(self.connect_backoff * (attempt + 1), 8.0) + random.uniform(0, 1.5)
                await asyncio.sleep(delay)
        if last_exc:
            raise last_exc
        return None

    async def _run_session(self) -> None:
        ws = await self._connect()
        if ws is None:
            return
        self.ws = ws
        if self.stats:
            self.stats.on_connected()
        try:
            await self.send(P.login_message(self.token, self.nickname,
                                            skin=self.skin, password=self.password))
            await self.behavior.on_spawn(self)
            await asyncio.gather(
                self._recv_loop(),
                self._tick_loop(),
                self._keepalive_loop(),
            )
        finally:
            self.ws = None
            if self.stats:
                self.stats.on_disconnected()
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass

    async def _recv_loop(self) -> None:
        assert self.ws is not None
        async for frame in self.ws:
            self.view.last_packet_time = time.monotonic()
            if self.stats:
                self.stats.on_recv(len(frame) if isinstance(frame, (bytes, bytearray)) else len(frame))
            if isinstance(frame, (bytes, bytearray)):
                self._handle_binary(bytes(frame))
            # A text frame cannot happen any more -- the server refuses them on
            # this port and never sends one. Anything else is not ours.
        self._closing = True

    def _handle_binary(self, data: bytes) -> None:
        if not data:
            return
        op = data[0]
        if op == P.ServerOp.BATCH:
            # One frame, several messages. Depth is always one -- the server
            # never nests an envelope. See P.iter_batch.
            for message in P.iter_batch(data):
                self._handle_binary(message)
            return
        if op == P.ServerOp.HANDSHAKE:
            hs = P.parse_handshake(data)
            self.view.guid = hs.own_guid
            self.view.mode_id = hs.mode_id
        elif op == P.ServerOp.UNITS:
            if self.stats:
                self.stats.on_units()
            if self.track_others:
                _login_flag, records = P.parse_units(data)
                self._apply_units(records)
            else:
                # Light path: everything the benchmark metrics need is in our
                # own record. See P.find_self_record for why this matters.
                guid = self.view.guid
                if guid is not None:
                    rec = P.find_self_record(data, guid)
                    if rec is not None:
                        self.view.note_self_position(rec, self.stats)
        elif op == P.ServerOp.INVENTORY_SLOT:
            item = P.parse_inventory_slot(data)
            if item is not None and item.iid != 0:
                # Bounded: a behavior that never drains this must not grow it.
                if len(self.view.new_items) >= 16:
                    del self.view.new_items[0]
                self.view.new_items.append(item)
        elif op == P.ServerOp.PLAYER_DIE:
            self.view.alive = False
            if self.stats:
                self.stats.on_death()

    def _apply_units(self, records) -> None:
        guid = self.view.guid
        for rec in records:
            if guid is not None and rec.pid == guid and rec.type != 12:
                self.view.note_self_position(rec, self.stats)
                continue
            # Keyed on id alone. This used to fall back to uid when id was 0,
            # for entities whose id16 carried no information; ids are globally
            # unique now, so the fallback would only ever alias.
            if rec.state == 0:
                self.view.others.pop(rec.id, None)
            else:
                self.view.others[rec.id] = rec

    async def _tick_loop(self) -> None:
        # Small random phase so N bots don't all fire on the same millisecond.
        await asyncio.sleep(random.uniform(0, self.tick_interval))
        while not self._closing:
            start = time.monotonic()
            try:
                await self.behavior.tick(self)
            except websockets.ConnectionClosed:
                self._closing = True
                break
            elapsed = time.monotonic() - start
            await asyncio.sleep(max(0.0, self.tick_interval - elapsed))

    async def _keepalive_loop(self) -> None:
        # The server drops a socket after CONNECTION_READ_TIMEOUT (90s) of
        # silence; a periodic PING keeps idle-ish bots alive.
        while not self._closing:
            await asyncio.sleep(20.0)
            await self.send(P.ping())


