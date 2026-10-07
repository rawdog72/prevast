// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/player-marker.ts
// Our own marker on the minimap and the full map: a small copy of our head
// as the character renderer draws it -- the base skin the drug state picks
// (day-skin0..5) with the wearable's head sprite over it -- turned to our aim.
// Both maps draw the same look through drawHeadMarker so they cannot drift.

import type { AssetLoader } from '../assets/asset-loader';
import type { ContentStore } from '../content/store';
import type { WorldEntity } from '../world/entity-types';
import { drugSkinIndex, type PlayerInfo, type WorldState } from '../world/world-state';

export interface HeadLook {
  /** The base skin sprite (`day-skin<N>`). */
  head: string;
  /** The wearable's head sprite drawn over it, when one is worn. */
  cosmeticHead?: string;
}

/** The wearable table entry's client sprites for a skinId (the low byte of a player's `extra`). */
export function wearableClientFor(
  content: ContentStore,
  skinId: number,
): { head?: string; leftArm?: string; rightArm?: string } | undefined {
  if (skinId === 0 || !content.has('wearables')) return undefined;
  for (const w of Object.values(content.table('wearables'))) {
    if ((w as { skinId?: number }).skinId === skinId)
      return w.client as { head?: string; leftArm?: string; rightArm?: string } | undefined;
  }
  return undefined;
}

export function headLookFor(
  entity: WorldEntity,
  info: PlayerInfo | undefined,
  content: ContentStore,
): HeadLook {
  const look: HeadLook = { head: `day-skin${info ? drugSkinIndex(info) : 0}` };
  const cosmetic = wearableClientFor(content, entity.extra & 255)?.head;
  if (cosmetic) look.cosmeticHead = cosmetic;
  return look;
}

/** Our head look, or null until our entity has arrived. */
export function ownHeadLook(world: WorldState, content: ContentStore): HeadLook | null {
  const local = world.getLocalEntity();
  if (!local) return null;
  return headLookFor(local, world.players.get(world.ownGuid), content);
}

/**
 * Draws the look centred on (x, y), the base head `size` px across and the
 * wearable at the same scale, rotated by `angle`. Returns false (drawing
 * nothing) while the head sprite is not decoded yet, so the caller can fall
 * back to a plain marker.
 */
export function drawHeadMarker(
  ctx: CanvasRenderingContext2D,
  assets: AssetLoader,
  look: HeadLook,
  x: number,
  y: number,
  angle: number,
  size: number,
): boolean {
  const head = assets.get(look.head);
  if (!head) return false;
  const k = size / head.naturalWidth;
  const cosmetic = look.cosmeticHead ? assets.get(look.cosmeticHead) : undefined;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const hw = head.naturalWidth * k;
  const hh = head.naturalHeight * k;
  ctx.drawImage(head.image, -hw / 2, -hh / 2, hw, hh);
  if (cosmetic) {
    const cw = cosmetic.naturalWidth * k;
    const ch = cosmetic.naturalHeight * k;
    ctx.drawImage(cosmetic.image, -cw / 2, -ch / 2, cw, ch);
  }
  ctx.restore();
  return true;
}
