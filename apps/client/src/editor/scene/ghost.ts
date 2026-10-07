// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Translucent previews of pieces that are about to be placed or moved.
import { TILE_SIZE } from '../../../../../shared/typescript/editor-limits';
import { GRID_KINDS, type EntityKind } from '../../../../../shared/typescript/scenario-schema';
import type { AssetLoader } from '../../assets/asset-loader';
import type { CatalogEntry } from '../catalog/catalog';

export const OK_COLOUR = 'rgba(110, 200, 255, 0.95)';
export const BAD_COLOUR = 'rgba(255, 90, 90, 0.95)';

export function drawGhost(
  g: CanvasRenderingContext2D,
  assets: AssetLoader,
  entry: CatalogEntry | undefined,
  kind: EntityKind,
  x: number,
  y: number,
  rotation: number,
  ok: boolean,
  isNight = false,
): void {
  g.save();
  const sprite = entry?.icon ? assets.get(entry.icon, isNight) : undefined;
  if (sprite) {
    g.save();
    g.globalAlpha = 0.55;
    g.translate(x, y);
    if (entry?.rotatable) g.rotate((rotation * Math.PI) / 2);
    const w = sprite.naturalWidth / 2;
    const h = sprite.naturalHeight / 2;
    g.drawImage(sprite.image, -w / 2, -h / 2, w, h);
    g.restore();
  } else if (entry?.icon) {
    assets.warm(entry.icon, isNight);
  }
  g.strokeStyle = ok ? OK_COLOUR : BAD_COLOUR;
  g.lineWidth = 3;
  if (GRID_KINDS.has(kind)) {
    const half = TILE_SIZE / 2 - 2;
    g.strokeRect(x - half, y - half, half * 2, half * 2);
  } else {
    g.beginPath();
    g.arc(x, y, 34, 0, Math.PI * 2);
    g.stroke();
  }
  g.restore();
}

/** A soft rectangle over a set of tiles (line/rect/fill previews for large counts). */
export function drawTiles(g: CanvasRenderingContext2D, tiles: readonly [number, number][], colour: string): void {
  g.save();
  g.fillStyle = colour;
  for (const [tx, ty] of tiles) g.fillRect(tx * TILE_SIZE + 4, ty * TILE_SIZE + 4, TILE_SIZE - 8, TILE_SIZE - 8);
  g.restore();
}
