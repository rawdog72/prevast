// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/character-animator.ts
// Per-creature animation clocks for players and agents, mirroring the old
// client's _EntitiePlayer / _Ghoul state machines: the attack swing (server
// pulses bit 1 of `state` for one tick), the walk cycle and idle breathing,
// the hurt / heal / eat pulses and the death fade. The renderer reads these
// clocks and turns them into arm/weapon/head offsets; nothing here draws.
//
// Kept as a standalone system (like ParticleSystem) rather than mutating
// WorldState, so the renderer can stay a pure reader of world + content.

import type { ContentStore } from '../content/store';
import { fastDist } from '../core/math2d';
import { EntityType, type WorldEntity } from '../world/entity-types';
import type { WorldState } from '../world/world-state';

const DEFAULT_SWING_MS = 300;

// Old client timings.
export const HURT_PULSE_MS = 300;
/**
 * A player's hurt pulse starts at most once a second. Damage that ticks -- a
 * spike trap deals 1 every 100 ms -- restarted the 300 ms knock-and-flash
 * before it ever finished, so the sprite jittered ten times a second for as
 * long as the player stood there. Same pacing as the camera's hit shake.
 */
export const HURT_REPEAT_MS = 1000;
export const AGENT_HURT_PULSE_MS = 250;
export const HEAL_PULSE_MS = 300;
export const EAT_PULSE_MS = 300;
const WALK_CYCLE_MS = 800; // one arm stride; direction flips each cycle
const AGENT_WALK_CYCLE_MS = 1500;
const BREATH_CYCLE_MS = 1500;
const SPRINT_CYCLE_RATE = 1.9;
const WALK_WIRE_SPEED = 0.23; // units/ms; faster than this is a sprint

/** A spent shell tumbling away from a gun (world coordinates). */
export interface Cartridge {
  sprite: string;
  x: number;
  y: number;
  ax: number;
  ay: number;
  /** ms left; total is the weapon's cartridgeDelay. */
  delay: number;
  total: number;
}

/** A dust puff kicked up by a sprinting player (world coordinates). */
export interface DustPuff {
  x: number;
  y: number;
  angle: number;
  size: number;
  /** ms left of PUFF_LIFE_MS. */
  delay: number;
}

export const PUFF_LIFE_MS = 750;
const PUFF_INTERVAL_MS = 250;
const MAX_PUFFS = 3;
const MAX_CARTRIDGES = 4;
const CARTRIDGE_SPEED = 0.18; // units/ms

export interface CharacterAnimState {
  /** ms left in the current attack swing, and its full length (0 when idle). */
  hit: number;
  hitMax: number;
  /** Which hand throws the next punch (bare hands / ghouls): 1 = left, -1 = right. */
  punch: 1 | -1;
  /** Walk cycle phase 0..cycle; arms stride `orientation` ways, flipping every cycle. */
  move: number;
  orientation: 1 | -1;
  /** Idle breathing phase 0..1500. */
  breath: number;
  /** Hand-to-mouth bob while consuming: 0..consumeAnimMs, bouncing. */
  consume: number;
  consumeDir: 1 | -1;
  /** Pulse clocks (ms left). */
  hurt: number;
  hurtAngle: number;
  /** Ms until another hit may start a hurt pulse (HURT_REPEAT_MS). */
  hurtCooldown: number;
  heal: number;
  food: number;
  /** ms since removal (death animation clock). */
  death: number;
  cartridges: Cartridge[];
  puffs: DustPuff[];
  puffTimer: number;
}

interface TimingLike {
  attackDelayMs?: number;
  shotDelayMs?: number;
  impactMs?: number;
}

interface EquipClientLike {
  swingAnimMs?: number;
  consumeAnimMs?: number;
  cartridge?: string;
  cartridgeDelay?: number;
}

/**
 * How long a swing animation runs (old client `weapon.delay`): the client's own
 * swing length when the content states one, else the server's attack/shot/impact
 * cadence, which is what the old table carried for every weapon type.
 */
export function swingDurationMs(
  client: EquipClientLike | undefined,
  timing: TimingLike | undefined,
): number {
  return (
    client?.swingAnimMs ??
    timing?.attackDelayMs ??
    timing?.shotDelayMs ??
    timing?.impactMs ??
    DEFAULT_SWING_MS
  );
}

/** 0 -> 1 -> 0 over one period, linear both ways (the old client's move/breath shaping). */
export function triangleWave(phase: number, period: number): number {
  const half = period / 2;
  return phase < half ? phase / half : 1 - (phase - half) / half;
}

function easeInQuad(t: number): number {
  return t * t;
}

function easeOutQuad(t: number): number {
  return t * (2 - t);
}

export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

/**
 * Alpha and scale of a hurt/heal/eat overlay with `remaining` ms of `total`
 * left. Old client: a faint quadratic fade-in over the first half, then the
 * overlay pops to full and fades out over the second half while swelling 20%.
 */
export function hitPulse(remaining: number, total: number): { alpha: number; scale: number } {
  const half = total / 2;
  if (remaining > half) {
    return { alpha: Math.min(1, Math.max(0, easeInQuad((total - remaining) / total))), scale: 1 };
  }
  const value = Math.min(1, Math.max(0, easeOutQuad(remaining / half)));
  return { alpha: value, scale: 1 + (1 - value) * 0.2 };
}

/**
 * Swing progress shaping shared by every weapon type: 0 at rest, rising to 1
 * at the impact point (`impactMs` before the end), then back to 0.
 */
export function swingValue(hit: number, hitMax: number, impactMs: number): number {
  if (hit <= 0 || hitMax <= 0) return 0;
  const impact = Math.min(impactMs, hitMax);
  if (hit > impact) return hitMax === impact ? 1 : 1 - (hit - impact) / (hitMax - impact);
  return hit / impact;
}

function freshState(): CharacterAnimState {
  return {
    hit: 0,
    hitMax: 0,
    punch: 1,
    move: 0,
    orientation: 1,
    breath: 0,
    consume: 0,
    consumeDir: 1,
    hurt: 0,
    hurtAngle: 0,
    hurtCooldown: 0,
    heal: 0,
    food: 0,
    death: 0,
    cartridges: [],
    puffs: [],
    puffTimer: 0,
  };
}

export class CharacterAnimator {
  private readonly states = new WeakMap<WorldEntity, CharacterAnimState>();

  get(entity: WorldEntity): CharacterAnimState | undefined {
    return this.states.get(entity);
  }

  private stateFor(entity: WorldEntity): CharacterAnimState {
    let state = this.states.get(entity);
    if (!state) {
      state = freshState();
      this.states.set(entity, state);
    }
    return state;
  }

  /** PLAYER_HIT: the creature was struck from `angle` (radians). */
  hurt(entity: WorldEntity, angle: number, durationMs = HURT_PULSE_MS): void {
    const s = this.stateFor(entity);
    if (s.hurtCooldown > 0) return;
    s.hurt = durationMs;
    s.hurtAngle = angle;
    s.hurtCooldown = HURT_REPEAT_MS;
  }

  /** PLAYER_HEAL: green pulse. */
  heal(entity: WorldEntity): void {
    this.stateFor(entity).heal = HEAL_PULSE_MS;
  }

  /** PLAYER_EAT: hand-to-mouth pulse. */
  eat(entity: WorldEntity): void {
    this.stateFor(entity).food = EAT_PULSE_MS;
  }

  /** Starts a swing directly (feedback with no state-bit signal). */
  triggerSwing(entity: WorldEntity, durationMs = DEFAULT_SWING_MS): void {
    const s = this.stateFor(entity);
    if (s.hit <= 0) {
      s.hit = durationMs;
      s.hitMax = durationMs;
    }
  }

  update(world: WorldState, content: ContentStore, deltaMs: number): void {
    const creatures = [
      ...world.entities.getByType(EntityType.PLAYER),
      ...world.entities.getByType(EntityType.AI),
    ];

    for (const entity of creatures) {
      const s = this.stateFor(entity);
      const isAgent = entity.type === EntityType.AI;

      if (entity.removed) {
        s.death += deltaMs;
        this.tickPulses(s, deltaMs);
        this.tickDebris(s, deltaMs);
        continue;
      }

      const equipClient = isAgent ? undefined : this.equipClient(entity, content);

      // Attack swing: the store latches the one-tick state pulse (old client
      // `player.state & 254 === 2`); length from the held weapon / agent ability.
      if (entity.attackPulse) {
        entity.attackPulse = false;
        if (s.hit <= 0) {
          const duration = isAgent
            ? this.agentSwingMs(entity, content)
            : this.playerSwingMs(entity, content);
          s.hit = duration;
          s.hitMax = duration;
          if (equipClient?.cartridge) this.ejectCartridge(s, entity, equipClient);
        }
      }

      // Consuming (state bit 2): the held food bobs to the mouth and back.
      if ((entity.state & 4) !== 0 && equipClient?.consumeAnimMs) {
        const span = equipClient.consumeAnimMs;
        s.consume =
          s.consumeDir === 1
            ? Math.min(span, s.consume + deltaMs)
            : Math.max(0, s.consume - deltaMs);
        if (s.consume === 0 || s.consume === span) s.consumeDir = s.consumeDir === 1 ? -1 : 1;
      } else {
        s.consume = 0;
        s.consumeDir = 1;
      }

      // Agent hurt pulse (latched by the store off extra bit 4, direction in 31
      // steps). The server holds the flag for two ticks; the second packet must
      // not restart a pulse that has only just begun.
      if (entity.hurtPulse) {
        entity.hurtPulse = false;
        if (s.hurt < AGENT_HURT_PULSE_MS - 100) {
          s.hurt = AGENT_HURT_PULSE_MS;
          s.hurtAngle = (Math.PI * 2 * entity.hurtPulseDir) / 31;
        }
      }

      // Swing clock; bare hands alternate the punching arm each swing.
      if (s.hit > 0) {
        s.hit = Math.max(0, s.hit - deltaMs);
        if (s.hit === 0) s.punch = s.punch === 1 ? -1 : 1;
      }

      // Walk cycle vs. idle breathing. Moving: stride advances (faster when
      // sprinting) and any breath in progress winds back to rest. Idle: breath
      // cycles and a stride in progress winds back to rest.
      const moving = fastDist(entity.x, entity.y, entity.nx, entity.ny) >= 1;
      const sprinting = !isAgent && entity.speed > WALK_WIRE_SPEED;
      const cycle = isAgent ? AGENT_WALK_CYCLE_MS : WALK_CYCLE_MS;
      if (moving) {
        const rate = sprinting ? SPRINT_CYCLE_RATE : 1;
        s.move += deltaMs * rate;
        if (s.move > cycle) {
          s.orientation = s.orientation === 1 ? -1 : 1;
          s.move %= cycle;
        }
        if (s.breath !== 0) {
          if (s.breath < BREATH_CYCLE_MS / 2) s.breath = BREATH_CYCLE_MS - s.breath;
          s.breath += deltaMs;
          if (s.breath > BREATH_CYCLE_MS) s.breath = 0;
        }
      } else {
        s.breath = (s.breath + deltaMs) % BREATH_CYCLE_MS;
        if (s.move !== 0) {
          if (s.move < cycle / 2) s.move = cycle - s.move;
          s.move += deltaMs;
          if (s.move > cycle) s.move = 0;
        }
      }

      // Sprint dust: a puff under the feet every PUFF_INTERVAL_MS while running.
      s.puffTimer = Math.max(0, s.puffTimer - deltaMs);
      if (moving && sprinting && s.puffTimer === 0 && s.puffs.length < MAX_PUFFS) {
        s.puffs.push({
          x: entity.x,
          y: entity.y,
          angle: Math.random() * Math.PI * 2,
          size: 1 + Math.random() * 0.8,
          delay: PUFF_LIFE_MS,
        });
        s.puffTimer = PUFF_INTERVAL_MS;
      }

      this.tickPulses(s, deltaMs);
      this.tickDebris(s, deltaMs);
    }
  }

  private tickPulses(s: CharacterAnimState, deltaMs: number): void {
    if (s.hurt > 0) s.hurt = Math.max(0, s.hurt - deltaMs);
    if (s.hurtCooldown > 0) s.hurtCooldown = Math.max(0, s.hurtCooldown - deltaMs);
    if (s.heal > 0) s.heal = Math.max(0, s.heal - deltaMs);
    if (s.food > 0) s.food = Math.max(0, s.food - deltaMs);
  }

  private tickDebris(s: CharacterAnimState, deltaMs: number): void {
    for (const c of s.cartridges) {
      c.x += deltaMs * c.ax * CARTRIDGE_SPEED;
      c.y += deltaMs * c.ay * CARTRIDGE_SPEED;
      c.delay -= deltaMs;
    }
    if (s.cartridges.length) s.cartridges = s.cartridges.filter((c) => c.delay > 0);
    for (const p of s.puffs) p.delay -= deltaMs;
    if (s.puffs.length) s.puffs = s.puffs.filter((p) => p.delay > 0);
  }

  // Old client: the shell leaves 44 units ahead of the player and tumbles off
  // to their right-rear at a random spread.
  private ejectCartridge(
    s: CharacterAnimState,
    entity: WorldEntity,
    client: EquipClientLike,
  ): void {
    if (s.cartridges.length >= MAX_CARTRIDGES) s.cartridges.shift();
    const angle = -Math.PI / 2.5 + entity.angle + (Math.random() * -Math.PI) / 3.5;
    const total = client.cartridgeDelay ?? 500;
    s.cartridges.push({
      sprite: client.cartridge!,
      x: entity.x + Math.cos(entity.angle) * 44,
      y: entity.y + Math.sin(entity.angle) * 44,
      ax: Math.cos(angle),
      ay: Math.sin(angle),
      delay: total,
      total,
    });
  }

  private equipClient(entity: WorldEntity, content: ContentStore): EquipClientLike | undefined {
    const weaponId = (entity.extra >> 8) & 255;
    const equipable = content.has('equipables') ? content.byId('equipables', weaponId) : undefined;
    return equipable?.client as EquipClientLike | undefined;
  }

  private playerSwingMs(entity: WorldEntity, content: ContentStore): number {
    const weaponId = (entity.extra >> 8) & 255;
    const equipable = content.has('equipables') ? content.byId('equipables', weaponId) : undefined;
    return swingDurationMs(
      equipable?.client as EquipClientLike | undefined,
      equipable?.timing as TimingLike | undefined,
    );
  }

  private agentSwingMs(entity: WorldEntity, content: ContentStore): number {
    const agent = content.has('agents') ? content.byId('agents', entity.extra & 15) : undefined;
    const abilities = (agent as { abilities?: { ability?: { cooldownMs?: number }[] } } | undefined)
      ?.abilities;
    return abilities?.ability?.[0]?.cooldownMs ?? DEFAULT_SWING_MS;
  }
}
