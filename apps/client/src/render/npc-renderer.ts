// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import type { AssetLoader } from '../assets/asset-loader';
import type { ContentStore } from '../content/store';
import type { WorldEntity } from '../world/entity-types';

/** NPCs share the game's character art without inheriting combat animation. */
export function drawNpc(ctx: CanvasRenderingContext2D, entity: WorldEntity, content: ContentStore, assets: AssetLoader, night: boolean, time: number): void {
  if (entity.removed || !content.has('npcs')) return;
  const data = content.byId('npcs', entity.extra);
  if (!data) return;
  const breath = 1 + Math.sin(time / 700 + entity.id) * 0.015;
  ctx.save(); ctx.translate(entity.x, entity.y); ctx.rotate(entity.angle); ctx.scale(breath, breath);
  for (const [name, x, y] of [[data.client.leftArm, 22, -35], [data.client.rightArm, 22, 35], [data.client.head, 0, 0]] as const) {
    const sprite = assets.get(name, night);
    if (!sprite) continue;
    const w = sprite.naturalWidth / 2, h = sprite.naturalHeight / 2;
    ctx.drawImage(sprite.image, x - w / 2, y - h / 2, w, h);
  }
  ctx.restore();
}
