// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/game/world-target.ts
// What a Ctrl+right-click on the world lands on. Creatures stand on top of
// everything, so they win; then buildings, a usable one (door, chest, station)
// over a plain piece and a higher layer over a lower one; then resources.

import type { ContentStore } from '../content/store';
import type { Camera } from '../core/camera';
import { EntityType, type WorldEntity } from '../world/entity-types';
import type { WorldState } from '../world/world-state';

export type WorldTargetKind = 'player' | 'npc' | 'creature' | 'object' | 'resource';

export interface WorldTarget {
  kind: WorldTargetKind;
  entity: WorldEntity;
}

const CREATURE_RADIUS = 40;
/** A building is picked anywhere on its footprint; at least its own tile. */
const TILE_HALF = { x: 50, y: 50 };
const RESOURCE_RADIUS = 60;

const CREATURES: [number, WorldTargetKind][] = [
  [EntityType.PLAYER, 'player'],
  [EntityType.NPC, 'npc'],
  [EntityType.AI, 'creature'],
];
/** Top first: a door or wall over furniture over floors. */
const BUILDING_LAYERS = [
  EntityType.BUILD_TOP,
  EntityType.BUILD_DOWN,
  EntityType.BUILD_GROUND2,
  EntityType.BUILD_GROUND,
];
const RESOURCES = [
  EntityType.RES_TOP,
  EntityType.RES_MID,
  EntityType.RES_DOWN,
  EntityType.RES_STOP,
];

export interface WorldTargetOptions {
  /** Doors, chests, stations: preferred over a plain piece under the same point. */
  isUsable?: (entity: WorldEntity) => boolean;
  /** Half the width and height a building covers (big stations span several tiles). */
  halfSize?: (entity: WorldEntity) => { x: number; y: number };
}

export function worldTargetAt(
  world: WorldState,
  camera: Camera,
  x: number,
  y: number,
  { isUsable = () => false, halfSize = () => TILE_HALF }: WorldTargetOptions = {},
): WorldTarget | null {
  const p = camera.screenToWorld(x, y);
  const d2 = (e: WorldEntity) => (p.x - e.x) ** 2 + (p.y - e.y) ** 2;

  let best: WorldTarget | null = null;
  let bestScore = CREATURE_RADIUS ** 2;
  for (const [type, kind] of CREATURES) {
    for (const e of world.entities.getByType(type)) {
      if (e.removed || (type === EntityType.PLAYER && e.pid === world.ownGuid)) continue;
      const d = d2(e);
      if (d <= bestScore) {
        bestScore = d;
        best = { kind, entity: e };
      }
    }
  }
  if (best) return best;

  // Yourself last among bodies: anyone else under the pointer comes first.
  const own = world.getLocalEntity();
  if (own && !own.removed && d2(own) <= CREATURE_RADIUS ** 2)
    return { kind: 'player', entity: own };

  bestScore = Infinity;
  BUILDING_LAYERS.forEach((type, layer) => {
    for (const e of world.entities.getByType(type)) {
      if (e.removed) continue;
      const half = halfSize(e);
      if (Math.abs(p.x - e.x) > half.x || Math.abs(p.y - e.y) > half.y) continue;
      // Usable beats layer beats distance (kept under 1 so it only breaks ties).
      const score = (isUsable(e) ? 0 : 10) + layer + Math.min(0.9, d2(e) / 1e5);
      if (score < bestScore) {
        bestScore = score;
        best = { kind: 'object', entity: e };
      }
    }
  });
  if (best) return best;

  bestScore = RESOURCE_RADIUS ** 2;
  for (const type of RESOURCES) {
    for (const e of world.entities.getByType(type)) {
      const d = d2(e);
      if (!e.removed && d <= bestScore) {
        bestScore = d;
        best = { kind: 'resource', entity: e };
      }
    }
  }
  return best;
}

/** The Ctrl+right-click menu's heading. The real description comes from the server's Look. */
export function worldTargetTitle(
  target: WorldTarget,
  world: WorldState,
  content: ContentStore,
): string {
  const e = target.entity;
  switch (target.kind) {
    case 'player':
      return world.players.get(e.pid)?.nickname ?? 'Player';
    case 'npc':
      return (content.has('npcs') ? content.byId('npcs', e.extra)?.name : undefined) ?? 'NPC';
    case 'object':
      return (
        (content.has('items') ? content.byId('items', e.extra >> 7)?.name : undefined) ?? 'Object'
      );
    case 'creature':
      return 'Creature';
    case 'resource':
      return 'Resource';
  }
}
