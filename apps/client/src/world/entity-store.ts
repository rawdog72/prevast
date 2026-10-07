// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// EntityStore maintains the live set of active world entities.
// Indexing constraint:
// - pid === 0: keyed by id in worldCache Map
// - pid !== 0: keyed by (pid * unitsPerPlayer) + id in playerCache Map
import { distance, frameLerp, lerp, reduceAngle } from '../core/math2d';
import type { UnitRecord } from '../net/events';
import { EntityType, type WorldEntity } from './entity-types';

// Client-side motion model per entity type, mirroring the old client's
// ENTITIES table. `speed` is in world units per ms; 'wire' means the server
// packs it into the high byte of `state` as units/ms x 100 (creatures and
// projectiles: Creature::buildUpdate / Projectile::buildUpdate). Loot's high
// byte is the attacker pid, not a speed, so it keeps a fixed glide speed.
// `lerp` is the visual smoothing factor per 60 fps frame.
interface MotionProfile {
  speed: number | 'wire';
  lerp: number;
}

const DEFAULT_MOTION: MotionProfile = { speed: 0, lerp: 0.15 };

const MOTION_PROFILES: Record<number, MotionProfile> = {
  [EntityType.PLAYER]: { speed: 'wire', lerp: 0.15 },
  [EntityType.LOOT]: { speed: 0.2, lerp: 0.1 },
  [EntityType.BULLET]: { speed: 'wire', lerp: 0.2 },
  [EntityType.BUILD_TOP]: { speed: 0, lerp: 0.2 },
  [EntityType.BUILD_DOWN]: { speed: 0, lerp: 0.2 },
  [EntityType.BUILD_GROUND]: { speed: 0, lerp: 0.2 },
  [EntityType.BUILD_GROUND2]: { speed: 0, lerp: 0.2 },
  [EntityType.PARTICLES]: { speed: 0.7, lerp: 0.2 },
  [EntityType.RES_TOP]: { speed: 0, lerp: 0.15 },
  [EntityType.RES_DOWN]: { speed: 0, lerp: 0.15 },
  [EntityType.RES_MID]: { speed: 0, lerp: 0.15 },
  [EntityType.RES_STOP]: { speed: 0, lerp: 0.15 },
  [EntityType.EXPLOSION]: { speed: 0, lerp: 0.15 },
  [EntityType.NPC]: { speed: 0, lerp: 0.2 },
  [EntityType.AI]: { speed: 'wire', lerp: 0.15 },
};

function motionProfile(type: number): MotionProfile {
  return MOTION_PROFILES[type] ?? DEFAULT_MOTION;
}

function resolveSpeed(type: number, state: number): number {
  const profile = motionProfile(type);
  return profile.speed === 'wire' ? (state >> 8) / 100 : profile.speed;
}

/** Players and agents: the server reports their position every movement tick. */
function isCreature(type: number): boolean {
  return type === EntityType.PLAYER || type === EntityType.AI || type === EntityType.NPC;
}

/** Buildings and resources: static things that can be hit. */
export function isStructure(type: number): boolean {
  return (
    type === EntityType.BUILD_TOP ||
    type === EntityType.BUILD_DOWN ||
    type === EntityType.BUILD_GROUND ||
    type === EntityType.BUILD_GROUND2 ||
    type === EntityType.RES_TOP ||
    type === EntityType.RES_DOWN ||
    type === EntityType.RES_MID ||
    type === EntityType.RES_STOP
  );
}

// Server movement tick (MOVEMENT_TICK_MS). A creature's endX/endY is where it
// stands right now and its startX/startY is where it stood one tick ago, so at
// wire speed the logical position takes exactly one tick to reach the target.
const SERVER_TICK_MS = 50;

// Old client (updateEntitiePlayer): a creature whose smoothed position has
// drifted this far from where the server says it was last tick is re-anchored
// there. Catches dropped packets and jitter without a visible teleport.
const CREATURE_RESYNC_DIST = 66;

// Beyond this the entity has warped (respawn, admin teleport): snap the visual
// position too instead of zipping across the map.
const TELEPORT_DIST = 500;

// Old client: a removed entity keeps drawing while its exit animation plays
// (a dead player/agent's splat + fade, a building's shrink-and-fade, a loot's
// fade-out), so it stays in its type list, flagged `removed`, until the
// animation is over. It leaves the id caches immediately so a respawn under the
// same id gets a fresh entity.
export const DEATH_ANIM_MS = 900;
export const STRUCTURE_FADE_MS = 300;
export const LOOT_FADE_MS = 800;

// Old client _Loots: a pickup whose state high byte names a player (the
// server's attackerPid -- who harvested it, or who just picked it up) homes on
// that player's entity every frame instead of sitting where it dropped; the
// server removes it 250 ms after the take and it fades out still flying. The
// old client flew at the fixed 0.2 units/ms; here the pull ramps up the longer
// it lasts (a magnet, not a drift) so it always reaches a player who keeps
// walking, and the visual follows tighter than resting loot does.
const LOOT_MAGNET_SPEED = 0.25;
const LOOT_MAGNET_ACCEL = 0.0015;
const LOOT_MAGNET_MAX_SPEED = 1.6;
const LOOT_MAGNET_LERP = 0.3;

/** Whether this pickup is flying to a player (state high byte = taker pid). */
export function isLootFlying(entity: WorldEntity): boolean {
  return entity.type === EntityType.LOOT && entity.state >> 8 !== 0;
}

function removalFadeMs(type: number): number {
  if (isCreature(type)) return DEATH_ANIM_MS;
  if (isStructure(type)) return STRUCTURE_FADE_MS;
  if (type === EntityType.LOOT) return LOOT_FADE_MS;
  return 0;
}

export class EntityStore {
  unitsPerPlayer = 100;

  // Address space split
  private readonly worldCache = new Map<number, WorldEntity>();
  private readonly playerCache = new Map<number, WorldEntity>();

  // Fast type lookup lists
  private readonly byTypeLists = new Map<number, Set<WorldEntity>>();

  // Removed creatures still playing their death animation, with ms left.
  private readonly dying = new Map<WorldEntity, number>();

  constructor(unitsPerPlayer = 100) {
    this.unitsPerPlayer = unitsPerPlayer;
  }

  setUnitsPerPlayer(count: number): void {
    if (count <= 0) return;
    if (this.unitsPerPlayer === count) return;
    this.unitsPerPlayer = count;
    // Re-index playerCache with new unitsPerPlayer multiplier
    const existing = Array.from(this.playerCache.values());
    this.playerCache.clear();
    for (const entity of existing) {
      this.playerCache.set(this.playerKey(entity.pid, entity.id), entity);
    }
  }

  private playerKey(pid: number, id: number): number {
    return pid * this.unitsPerPlayer + id;
  }

  get(pid: number, id: number): WorldEntity | undefined {
    if (pid === 0) return this.worldCache.get(id);
    return this.playerCache.get(this.playerKey(pid, id));
  }

  private set(entity: WorldEntity): void {
    if (entity.pid === 0) {
      this.worldCache.set(entity.id, entity);
    } else {
      this.playerCache.set(this.playerKey(entity.pid, entity.id), entity);
    }
    let set = this.byTypeLists.get(entity.type);
    if (!set) {
      set = new Set<WorldEntity>();
      this.byTypeLists.set(entity.type, set);
    }
    set.add(entity);
  }

  remove(pid: number, id: number, type?: number, keepInCache = 0): boolean {
    let entity: WorldEntity | undefined;
    if (pid === 0) {
      entity = this.worldCache.get(id);
      this.worldCache.delete(id);
    } else {
      const key = this.playerKey(pid, id);
      entity = this.playerCache.get(key);
      this.playerCache.delete(key);
    }

    if (entity) {
      if (keepInCache === 1) {
        const fade = removalFadeMs(entity.type);
        if (fade > 0) {
          entity.removed = true;
          this.dying.set(entity, fade);
        } else {
          const t = type ?? entity.type;
          this.byTypeLists.get(t)?.delete(entity);
        }
      } else {
        if (isStructure(entity.type)) {
          entity.retracted = true;
          this.dying.set(entity, STRUCTURE_FADE_MS);
        } else {
          const t = type ?? entity.type;
          this.byTypeLists.get(t)?.delete(entity);
        }
      }
      return true;
    }
    return false;
  }

  clear(): void {
    this.worldCache.clear();
    this.playerCache.clear();
    this.byTypeLists.clear();
    this.dying.clear();
  }

  /** ms left before a removed entity is dropped from its type list (undefined if not fading). */
  fadeLeft(entity: WorldEntity): number | undefined {
    return this.dying.get(entity);
  }

  get count(): number {
    return this.worldCache.size + this.playerCache.size;
  }

  getByType(type: number): WorldEntity[] {
    const set = this.byTypeLists.get(type);
    return set ? Array.from(set) : [];
  }

  all(): WorldEntity[] {
    return [...this.worldCache.values(), ...this.playerCache.values()];
  }

  /**
   * Processes a batch of unit records from a server ENTITY_UPDATES packet.
   */
  processUnits(units: readonly UnitRecord[], isFullReset = false): void {
    if (isFullReset) {
      this.clear();
    }

    for (const record of units) {
      if (record.state === 0) {
        this.remove(record.pid, record.id, record.type, record.extra);
        continue;
      }

      let existingRetracting: WorldEntity | undefined;
      for (const corpse of this.dying.keys()) {
        if (corpse.pid === record.pid && corpse.id === record.id && corpse.retracted) {
          existingRetracting = corpse;
          break;
        }
      }

      let entity = this.get(record.pid, record.id);
      if (existingRetracting) {
        this.dying.delete(existingRetracting);
        existingRetracting.retracted = false;
        entity = existingRetracting;
        this.set(entity);
      }

      const targetAngle = (record.rotation * Math.PI * 2) / 255;
      const speed = resolveSpeed(record.type, record.state);

      if (!entity) {
        // Create new entity
        entity = {
          pid: record.pid,
          id: record.id,
          type: record.type,
          rotation: record.rotation,
          state: record.state,
          extra: record.extra,
          x: record.startX,
          y: record.startY,
          angle: targetAngle,
          rx: record.startX,
          ry: record.startY,
          nx: record.endX,
          ny: record.endY,
          nangle: targetAngle,
          tileX: Math.floor(record.startX / 100),
          tileY: Math.floor(record.startY / 100),
          speed,
          lerp: motionProfile(record.type).lerp,
          removed: false,
          retracted: false,
          updateCount: 1,
          stale: 0,
          attackPulse: false,
          hurtPulse: false,
          hurtPulseDir: 0,
          failPulse: false,
          flightMs: 0,
        };
        this.set(entity);
        this.latchPulses(entity, record);
        this.aimLootAtTaker(entity);
      } else {
        // Update existing entity
        entity.type = record.type;
        entity.rotation = record.rotation;
        entity.state = record.state;
        entity.extra = record.extra;
        entity.nx = record.endX;
        entity.ny = record.endY;
        entity.nangle = targetAngle;
        entity.speed = speed;
        entity.updateCount++;
        this.latchPulses(entity, record);
        this.aimLootAtTaker(entity);

        // Warped (respawn/teleport): put the sprite there outright.
        const drift = distance(entity.x, entity.y, record.startX, record.startY);
        if (drift > TELEPORT_DIST) {
          entity.rx = record.startX;
          entity.ry = record.startY;
          entity.x = record.startX;
          entity.y = record.startY;
        } else if (isCreature(record.type) && drift > CREATURE_RESYNC_DIST) {
          // Drifted out of tolerance: re-anchor the logical position on the
          // server's last-tick position and let the smoothing carry the sprite.
          entity.rx = record.startX;
          entity.ry = record.startY;
        }
      }
    }
  }

  /** A taken pickup heads for its taker from the packet on, not one frame later. */
  private aimLootAtTaker(entity: WorldEntity): void {
    if (!isLootFlying(entity)) return;
    const taker = this.get(entity.state >> 8, 0);
    if (!taker || taker.removed) return;
    entity.nx = taker.x;
    entity.ny = taker.y;
  }

  // Pulses ride in for a single tick and are latched here rather than sampled
  // by the animators, so they survive until a frame actually runs. Creatures:
  // bit 1 of `state` is an attack swing; agents also carry a hurt flag in bit 4
  // of `extra` with the direction in bits 5-9. Buildings and resources: bit 1
  // of `state` is a hurt knock, direction in the low 5 bits of `extra`.
  private latchPulses(entity: WorldEntity, record: UnitRecord): void {
    if (isCreature(record.type)) {
      if ((record.state & 254) === 2) entity.attackPulse = true;
      if (record.type === EntityType.AI && (record.extra & 16) !== 0) {
        entity.hurtPulse = true;
        entity.hurtPulseDir = (record.extra >> 5) & 31;
      }
    } else if (isStructure(record.type)) {
      if ((record.state & 2) !== 0) {
        entity.hurtPulse = true;
        entity.hurtPulseDir = record.extra & 31;
      }
      if ((record.state & 32) !== 0) entity.failPulse = true;
    }
  }

  /**
   * Updates positions and interpolations between ticks.
   * @param delta Elapsed time in milliseconds
   */
  update(delta: number): void {
    const bulletsToRemove: WorldEntity[] = [];

    for (const [corpse, ttl] of this.dying) {
      const left = ttl - delta;
      if (left <= 0) {
        this.dying.delete(corpse);
        this.byTypeLists.get(corpse.type)?.delete(corpse);
      } else {
        this.dying.set(corpse, left);
      }
    }

    const updateEntity = (entity: WorldEntity) => {
      // Removed things hold still while their exit plays -- except a taken
      // pickup, which keeps flying into its taker as it fades.
      const flying = isLootFlying(entity);
      if (entity.removed && !flying) return;

      if (flying) {
        const taker = this.get(entity.state >> 8, 0);
        if (taker && !taker.removed) {
          entity.nx = taker.x;
          entity.ny = taker.y;
        }
        entity.flightMs += delta;
        entity.speed = Math.min(
          LOOT_MAGNET_MAX_SPEED,
          LOOT_MAGNET_SPEED + LOOT_MAGNET_ACCEL * entity.flightMs,
        );
        entity.lerp = LOOT_MAGNET_LERP;
      }

      // Dead reckoning (old client moveEntitie): the logical position rx/ry
      // travels toward the latest server position nx/ny at the entity's speed,
      // never overshooting it.
      const dist = distance(entity.rx, entity.ry, entity.nx, entity.ny);
      if (dist > 0 && entity.speed > 0) {
        let speed = entity.speed;
        // Creatures report a fresh position every server tick, so the logical
        // position should never need more than one tick to reach it. When a
        // late or dropped packet leaves it further behind, close the gap over
        // one tick rather than trailing by that much until the next stop.
        // Projectiles and loot glide from start to end at wire speed only --
        // their endpoint is a landing spot, not a per-tick position.
        if (isCreature(entity.type)) {
          speed = Math.max(speed, dist / SERVER_TICK_MS);
        }
        const moveDist = speed * delta;
        if (dist <= moveDist) {
          entity.rx = entity.nx;
          entity.ry = entity.ny;
        } else {
          const k = moveDist / dist;
          entity.rx += (entity.nx - entity.rx) * k;
          entity.ry += (entity.ny - entity.ry) * k;
        }
      } else if (entity.speed <= 0) {
        // Static entity (or a stopped projectile): sits where the server put it.
        entity.rx = entity.nx;
        entity.ry = entity.ny;
      }

      // Smooth the visual position toward the logical one. The factor is
      // rescaled to the actual frame time so 60 and 144 Hz feel identical.
      const alpha = frameLerp(entity.lerp, delta);
      entity.x = lerp(entity.x, entity.rx, alpha);
      entity.y = lerp(entity.y, entity.ry, alpha);
      entity.tileX = Math.floor(entity.x / 100);
      entity.tileY = Math.floor(entity.y / 100);

      // Smooth angle towards nangle taking shortest angular path. Old client:
      // creatures turn at lerp*2, world entities (pid 0) at lerp/2.
      const reducedTarget = reduceAngle(entity.angle, entity.nangle);
      const angleRate = entity.pid === 0 ? entity.lerp / 2 : Math.min(1, entity.lerp * 2);
      entity.angle = lerp(entity.angle, reducedTarget, frameLerp(angleRate, delta));

      // Projectile stale backstop (spec: drop bullets whose removal packet never arrived)
      if (entity.type === EntityType.BULLET) {
        if (dist < 1.0) {
          entity.stale += delta;
          if (entity.stale > 5000) {
            bulletsToRemove.push(entity);
          }
        } else {
          entity.stale = 0;
        }
      }
    };

    for (const entity of this.worldCache.values()) updateEntity(entity);
    for (const entity of this.playerCache.values()) updateEntity(entity);
    for (const corpse of this.dying.keys()) updateEntity(corpse);

    for (const bullet of bulletsToRemove) {
      this.remove(bullet.pid, bullet.id, bullet.type, 0);
    }
  }
}
