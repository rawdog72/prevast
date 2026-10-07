# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

"""Bot behaviors — the pluggable "brain" of each bot.

A behavior is any object with:

    async def on_spawn(self, bot):   # called once right after login
    async def tick(self, bot):       # called every bot tick (default 10 Hz)

Keeping the decision logic here (and out of bot.py) is the futureproofing
seam: to make bots smarter you write a new Behavior and register it in
BEHAVIORS below, without touching the network/plumbing layer. A behavior can
read `bot.view` (own x/y, aim, sprint, other visible entities) and call the
`bot.send(...)` helpers via the protocol builders.

Because MOVE/ROTATION/SHIFT are state-change opcodes (client.js only sends
them when the value actually changes), behaviors should mirror that: only
send when the intent changes. WanderBehavior does this via _set_move / etc.
"""

from __future__ import annotations

import math
import random

import protocol as P


class _StatefulInput:
    """Mixin: remember last MOVE/ROT/SHIFT/mouse we sent and only resend on
    change, matching how the real client throttles input."""

    def __init__(self) -> None:
        self._last_move = None
        self._last_rot = None
        self._last_shift = None
        self._last_mouse_dir = None

    async def _set_move(self, bot, mask: int) -> None:
        if mask != self._last_move:
            self._last_move = mask
            await bot.send(P.move(mask))

    async def _set_rotation(self, bot, degrees: int) -> None:
        degrees %= 360
        if degrees != self._last_rot:
            self._last_rot = degrees
            bot.view.aim = degrees
            await bot.send(P.rotation(degrees))

    async def _set_shift(self, bot, enabled: bool) -> None:
        if enabled != self._last_shift:
            self._last_shift = enabled
            bot.view.sprinting = enabled
            await bot.send(P.shift(enabled))

    async def _set_mouse_dir(self, bot, direction: int) -> None:
        if direction != self._last_mouse_dir:
            self._last_mouse_dir = direction
            await bot.send(P.mouse_direction(direction))


# All four directional bit combos that represent actual movement.
_MOVE_CHOICES = [
    P.MOVE_LEFT, P.MOVE_RIGHT, P.MOVE_UP, P.MOVE_DOWN,
    P.MOVE_LEFT | P.MOVE_UP, P.MOVE_LEFT | P.MOVE_DOWN,
    P.MOVE_RIGHT | P.MOVE_UP, P.MOVE_RIGHT | P.MOVE_DOWN,
]


class WanderBehavior(_StatefulInput):
    """Walks in a random direction for a while, turns/aims continuously, and
    occasionally sprints, stops, or clicks. Deliberately noisy so it exercises
    the movement resolver, rotation rescaling, and viewport updates.

    Tunables are plain attributes so a runner could tweak them per-bot later.
    """

    def __init__(self, *, sprint_chance=0.15, attack_chance=0.02,
                 idle_chance=0.1, min_hold_ticks=8, max_hold_ticks=30):
        super().__init__()
        self.sprint_chance = sprint_chance
        self.attack_chance = attack_chance
        self.idle_chance = idle_chance
        self.min_hold_ticks = min_hold_ticks
        self.max_hold_ticks = max_hold_ticks
        self._hold = 0
        self._aim = random.randint(0, 359)
        self._aim_drift = random.uniform(-12, 12)

    async def on_spawn(self, bot) -> None:
        await self._set_rotation(bot, self._aim)
        await self._pick_new_intent(bot)

    async def tick(self, bot) -> None:
        if not bot.view.alive:
            return

        # Continuously drift the aim so the server keeps re-broadcasting our
        # rotation to spectators (a cheap way to generate steady update load).
        self._aim = (self._aim + self._aim_drift) % 360
        await self._set_rotation(bot, int(self._aim))
        await self._set_mouse_dir(
            bot, P.MOUSE_RIGHT if 0 <= self._aim < 180 else P.MOUSE_LEFT)

        self._hold -= 1
        if self._hold <= 0:
            await self._pick_new_intent(bot)

        if random.random() < self.attack_chance:
            await bot.send(P.mouse_down())
            await bot.send(P.mouse_up())

    async def _pick_new_intent(self, bot) -> None:
        self._hold = random.randint(self.min_hold_ticks, self.max_hold_ticks)
        self._aim_drift = random.uniform(-12, 12)

        if random.random() < self.idle_chance:
            await self._set_move(bot, 0)
            await self._set_shift(bot, False)
            return

        await self._set_move(bot, random.choice(_MOVE_CHOICES))
        await self._set_shift(bot, random.random() < self.sprint_chance)


class IdleBehavior(_StatefulInput):
    """Connects and just holds position (only keepalive pings). Useful for
    measuring pure connection/memory overhead vs. active movement load."""

    async def on_spawn(self, bot) -> None:
        await self._set_rotation(bot, random.randint(0, 359))

    async def tick(self, bot) -> None:
        return


class SpinBehavior(_StatefulInput):
    """Stands still and spins the aim every tick — maximum rotation-broadcast
    pressure with minimal movement math. Good for isolating update-fanout cost."""

    def __init__(self, degrees_per_tick: int = 20):
        super().__init__()
        self.step = degrees_per_tick
        self._aim = 0

    async def on_spawn(self, bot) -> None:
        return

    async def tick(self, bot) -> None:
        self._aim = (self._aim + self.step) % 360
        await self._set_rotation(bot, self._aim)


class MarchBehavior(_StatefulInput):
    """Walks continuously at a constant speed, never idling and never
    sprinting, reversing direction on a fixed cadence so bots stay on the map.

    This is the benchmark behavior: because the intended speed is constant,
    `Stats.observed_speed` becomes a clean read of how fast the server is
    ACTUALLY moving players, with none of the variance WanderBehavior's
    sprint/idle rolls introduce. It still drives the full movement, collision
    and spectator-fanout path, so the load is representative.
    """

    def __init__(self, hold_ticks: int = 100):
        super().__init__()
        self.hold_ticks = hold_ticks
        self._hold = 0
        self._dir_index = random.randrange(len(_MOVE_CHOICES))

    async def on_spawn(self, bot) -> None:
        await self._set_rotation(bot, random.randint(0, 359))
        await self._set_shift(bot, False)
        await self._set_move(bot, _MOVE_CHOICES[self._dir_index])
        self._hold = self.hold_ticks

    async def tick(self, bot) -> None:
        if not bot.view.alive:
            return
        self._hold -= 1
        if self._hold <= 0:
            # Reverse into the opposite quadrant so bots oscillate around
            # their spawn area instead of piling up against the map edges.
            self._dir_index = (self._dir_index + len(_MOVE_CHOICES) // 2) % len(_MOVE_CHOICES)
            await self._set_move(bot, _MOVE_CHOICES[self._dir_index])
            self._hold = self.hold_ticks


class BenchBehavior(_StatefulInput):
    """The worst case the server actually has to survive, and the behavior the
    headline numbers should be measured with.

    `march` understates load in two ways this fixes:

    1. A marching bot holds one of 8 fixed directions for 100 ticks and only
       ever reverses into the opposite quadrant. A bot that walks into a wall
       or a tree presses into it for the rest of that hold -- it still costs a
       collision pass, but a stationary player is not dirty, so it generates no
       updates to its spectators and contributes nothing to visibility churn.
       Stuck bots were the gap between observed speed (~168-186 u/s) and the
       speed the tick rate implied (~208-217). Here, a bot that fails to cover
       ground over `stall_window` ticks picks a genuinely new direction (not
       the opposite, which stays wedged in a corner), so it never stops paying.

    2. `march` deliberately does not rotate, so between direction changes a bot
       moving in a straight line is only dirty from its position delta. Drifting
       the aim every tick makes `Creature::isDirty()` (rotation != lastRotation)
       true for every player every tick, which forces a real buildUpdate and
       pushUpdate to every nearby client. That is the fanout the server has to
       hold up under, and nothing in the current test measured it.

    Movement intent stays constant-speed -- never idle, never sprint -- so
    `Stats.observed_speed` remains a clean read of how fast the server is
    actually moving players, exactly as it is under `march`.
    """

    def __init__(self, hold_ticks: int = 100, aim_step: int = 7,
                 stall_window: int = 8, stall_distance: float = 40.0):
        super().__init__()
        self.hold_ticks = hold_ticks
        # Degrees per bot tick. Rotation is rescaled to a uint8 server-side
        # (360deg -> 256 steps), so the step must be big enough that every tick
        # lands on a different stored value: 7deg ~= 5 steps, comfortably clear.
        self.aim_step = aim_step
        self.stall_window = stall_window
        self.stall_distance = stall_distance
        self._hold = 0
        self._dir_index = random.randrange(len(_MOVE_CHOICES))
        self._aim = random.randint(0, 359)
        self._stall_countdown = stall_window
        self._stall_x = None
        self._stall_y = None

    async def on_spawn(self, bot) -> None:
        await self._set_rotation(bot, self._aim)
        await self._set_shift(bot, False)
        await self._set_move(bot, _MOVE_CHOICES[self._dir_index])
        self._hold = self.hold_ticks
        self._arm_stall_check(bot)

    def _arm_stall_check(self, bot) -> None:
        self._stall_x, self._stall_y = bot.view.x, bot.view.y
        self._stall_countdown = self.stall_window

    async def _pick_new_direction(self, bot) -> None:
        # Any direction but the current one. Reversing is not enough: a bot
        # wedged in a concave corner bounces between two blocked headings.
        choices = [i for i in range(len(_MOVE_CHOICES)) if i != self._dir_index]
        self._dir_index = random.choice(choices)
        await self._set_move(bot, _MOVE_CHOICES[self._dir_index])
        self._hold = self.hold_ticks

    async def tick(self, bot) -> None:
        if not bot.view.alive:
            return

        # Every tick, unconditionally: keeps this player dirty and forces the
        # server to re-broadcast it to every spectator.
        self._aim = (self._aim + self.aim_step) % 360
        await self._set_rotation(bot, self._aim)

        self._stall_countdown -= 1
        if self._stall_countdown <= 0:
            moved = math.hypot(bot.view.x - self._stall_x,
                               bot.view.y - self._stall_y)
            if moved < self.stall_distance:
                await self._pick_new_direction(bot)
            self._arm_stall_check(bot)

        self._hold -= 1
        if self._hold <= 0:
            await self._pick_new_direction(bot)


class CombatBehavior(BenchBehavior):
    """`bench`, plus sustained automatic fire.

    Why this exists: **no shipped benchmark has ever created a single
    projectile.** `bench` never sends MOUSE_DOWN, `march` and `spin` never
    attack, and only `wander` clicks (2% per tick, with bare hands, which is
    melee). So every capture in `captures/` measures a server on which the
    entire combat path is idle -- projectile simulation, the per-projectile
    search for collision candidates, hit application, knockback, loot drops.
    That path is not incidental: a projectile is simulated on every tick of its
    whole flight, and its cost per tick scales with the configured viewport.

    Arming goes through the real admin command path because no starting kit in
    kits.xml contains a ranged weapon. The bot logs in with config.lua's
    `adminPassword`, has the server hand it an ak47 plus ammo, reads the
    weapon's uid out of the resulting INVENTORY_SLOT packet, and equips it.

    Two things to know before reading numbers from this:

    - **Bots kill each other, so the population churns.** Invincibility is not
      an option: `applyProjectilePlayerHit` deliberately lets an admin attacker
      through `isInvincible()`, and every bot here has to be an admin to arm
      itself. Cross-check the `deaths:` line between two runs before comparing
      them, and use `--fire-ratio` to thin the shooters if deaths dominate.
    - The duty cycle is one full magazine then a reload, which is what a real
      auto weapon produces: 30 rounds at ak47's 120ms shotDelay = 3.6s of fire
      against a 2.5s reload.
    """

    # Constructor options run.py may forward from the command line.
    OPTIONS = ("fire_ratio",)

    # Bot ticks (10 Hz by default), sized against ak47's XML timings.
    # ARM_DELAY_TICKS exists because the starting kit's own item packets
    # arrive AFTER on_spawn runs (on_spawn fires the moment the login frame is
    # sent, not when the server answers). Asking for the weapon immediately
    # meant the first arrival in the queue was a kit item -- measured: the bot
    # equipped 2x stone and never fired a shot.
    ARM_DELAY_TICKS = 20
    EQUIP_TICKS = 15    # let startEquipping's interaction finish before firing
    FIRE_TICKS = 38     # 30 rounds x 120ms shotDelayMs, plus margin
    RELOAD_TICKS = 30   # 2500ms reloadMs, plus margin

    def __init__(self, *, fire_ratio: float = 1.0, weapon: str = "ak47",
                 ammo: str = "762_round", ammo_count: int = 200,
                 magazine: int = 30, **kwargs):
        super().__init__(**kwargs)
        self.magazine = magazine
        # Decided per bot at construction so a fraction of the fleet can shoot
        # while the rest behave exactly like `bench`.
        self.shooter = random.random() < fire_ratio
        self.weapon = weapon
        self.ammo = ammo
        self.ammo_count = ammo_count
        self._armed = False
        self._requested = False
        self._firing = True          # first transition is mouse_up + reload
        self._countdown = self.EQUIP_TICKS

    async def on_spawn(self, bot) -> None:
        await super().on_spawn(bot)
        self._armed = False
        self._requested = False
        self._countdown = self.ARM_DELAY_TICKS

    async def tick(self, bot) -> None:
        await super().tick(bot)
        if not self.shooter or not bot.view.alive:
            return

        if not self._armed:
            await self._try_arm(bot)
            return

        self._countdown -= 1
        if self._countdown > 0:
            return

        if self._firing:
            await bot.send(P.mouse_up())
            await bot.send(P.reload_weapon())
            # Top up exactly one magazine per cycle, i.e. replace what was just
            # fired. Without this the run silently stops being a combat run:
            # the opening grant of 200 rounds lasts ~6 magazines (~42s), which
            # is spent during the connect ramp, so every steady-state window
            # measured zero projectiles. Measured on the first attempt --
            # captures/projA.csv peaks at 145 projectiles early and sits at 0
            # for all 32 windows at full population.
            # Net-zero by construction, so the inventory never overflows into
            # ground loot (762_round stacks to 255, and this hovers near 200).
            await bot.send(P.chat(f"!item={self.ammo}*{self.magazine}"))
            self._firing = False
            self._countdown = self.RELOAD_TICKS
        else:
            await bot.send(P.mouse_down())
            self._firing = True
            self._countdown = self.FIRE_TICKS

    async def _try_arm(self, bot) -> None:
        if not self._requested:
            self._countdown -= 1
            if self._countdown > 0:
                return
            # Drained only now: everything the kit granted has landed, so the
            # next arrival is unambiguously the weapon we are about to ask for.
            bot.view.new_items.clear()
            await bot.send(P.chat(f"!item={self.weapon}"))
            self._requested = True
            self._countdown = self.ARM_DELAY_TICKS  # retry if the reply is lost
            return

        if not bot.view.new_items:
            self._countdown -= 1
            if self._countdown <= 0:
                self._requested = False
            return

        weapon = bot.view.new_items.pop(0)
        await bot.send(P.equip_item(weapon.iid, weapon.uid))
        await bot.send(P.chat(f"!item={self.ammo}*{self.ammo_count}"))
        self._armed = True
        self._firing = True   # first transition is mouse_up + reload
        self._countdown = self.EQUIP_TICKS


class AimBehavior(BenchBehavior):
    """`bench`, with a share of the bots holding aim with one weapon.

    For the scope benchmark (aim-and-scopes spec, phase 2; see aimbench.py).
    An aiming bot arms itself through the admin command path, as `combat`
    does, so log in with config.lua's adminPassword. It equips the weapon,
    fits the optic if one is given, then holds the aim button for the rest of
    its life. It keeps bench's walking and turning, so a strong scope's shape
    is rebuilt and its scenery box moves every tick: the worst case.
    """

    OPTIONS = ("aim_ratio", "aim_weapon", "aim_optic")

    ARM_DELAY_TICKS = 20  # as CombatBehavior: the kit's own items land first
    EQUIP_TICKS = 15      # let startEquipping finish; equipping cancels a mod change

    def __init__(self, *, aim_ratio: float = 0.5, aim_weapon: str = "sniper",
                 aim_optic: str = "", **kwargs):
        super().__init__(**kwargs)
        # Decided per bot at construction, like CombatBehavior.shooter.
        self.aimer = random.random() < aim_ratio
        self.weapon = aim_weapon
        self.optic = aim_optic
        self._step = "wait"
        self._countdown = self.ARM_DELAY_TICKS
        self._weapon_uid = 0

    async def on_spawn(self, bot) -> None:
        await super().on_spawn(bot)
        self._step = "wait"
        self._countdown = self.ARM_DELAY_TICKS

    async def tick(self, bot) -> None:
        await super().tick(bot)
        if not self.aimer or not bot.view.alive or self._step == "aiming":
            return
        self._countdown -= 1
        if self._step == "wait":
            if self._countdown > 0:
                return
            # Drained only now: the next arrival is the weapon asked for.
            bot.view.new_items.clear()
            await bot.send(P.chat(f"!item={self.weapon}"))
            self._step, self._countdown = "weapon", self.ARM_DELAY_TICKS
        elif self._step == "weapon":
            if not bot.view.new_items:
                if self._countdown <= 0:
                    self._step, self._countdown = "wait", 0  # lost: ask again
                return
            weapon = bot.view.new_items.pop(0)
            self._weapon_uid = weapon.uid
            await bot.send(P.equip_item(weapon.iid, weapon.uid))
            if not self.optic:
                # Held from now on: aiming turns on once the weapon is drawn.
                await bot.send(P.aim(True))
                self._step = "aiming"
                return
            self._step, self._countdown = "equip", self.EQUIP_TICKS
        elif self._step == "equip":
            if self._countdown > 0:
                return
            bot.view.new_items.clear()
            await bot.send(P.chat(f"!item={self.optic}"))
            self._step, self._countdown = "optic", self.ARM_DELAY_TICKS
        elif self._step == "optic":
            if not bot.view.new_items:
                if self._countdown <= 0:
                    self._step, self._countdown = "equip", 0  # lost: ask again
                return
            optic = bot.view.new_items.pop(0)
            await bot.send(P.weapon_mod(self._weapon_uid, P.OPTIC_SLOT, optic.uid))
            # Held from now on: aiming turns on once the fitting is done.
            await bot.send(P.aim(True))
            self._step = "aiming"


BEHAVIORS = {
    "wander": WanderBehavior,
    "idle": IdleBehavior,
    "spin": SpinBehavior,
    "march": MarchBehavior,
    "bench": BenchBehavior,
    "combat": CombatBehavior,
    "aim": AimBehavior,
}


def make_behavior(name: str, **kwargs):
    try:
        cls = BEHAVIORS[name]
    except KeyError:
        raise SystemExit(
            f"unknown behavior '{name}'. choices: {', '.join(sorted(BEHAVIORS))}")
    # Only pass options the chosen behavior actually accepts, so --fire-ratio
    # is harmless when the run is not a combat run.
    accepted = {k: v for k, v in kwargs.items()
                if k in getattr(cls, "OPTIONS", ())}
    return cls(**accepted)
