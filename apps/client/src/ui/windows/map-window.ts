// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/windows/map-window.ts
// The full map (M), after the old client's _BigMinimap drawn with
// GameUI.mapGrid: the world fitted into a 410 px box (the old square, but
// keeping the map's aspect ratio), the sector grid with the column letters
// above and row numbers on the left and our cell lit, what we have seen of
// the map (MapMemory) under it, city / house icons at
// their tiles, clan mates as arrows with their names, and our own head (as
// the character renderer draws it) turned the way the mouse points. Everything
// is read from WorldState / ClanStore on each refresh, so a map an admin
// resizes while we play re-fits itself.

import type { AssetLoader } from '../../assets/asset-loader';
import type { ContentStore } from '../../content/store';
import type { BRZone } from '../../game/modes/br-zone';
import { drawHeadMarker, ownHeadLook } from '../../render/player-marker';
import type { ClanStore } from '../../world/clan-store';
import type { WorldState } from '../../world/world-state';
import { karmaSprite } from '../hud/hud-leaderboard';
import { drawMapGrid, MAP_FONT, MapMemoryImage, sectorCell, sectorGrid } from '../hud/map-grid';

export const BIG_MAP_PX = 410;
/** Room around the box for the A.. / 1.. labels (GameUI drew them 12-13 px out). */
export const MAP_MARGIN = 28;
/** Old client: markers stay between 10 and 400 on the 410 square. */
const MARKER_INSET = 10;
const TILE_SIZE = 100;
const REFRESH_MS = 100;

/** The box the world is drawn in: the 410 square shrunk on one axis to keep the aspect. */
export function bigMapLayout(worldW: number, worldH: number): { w: number; h: number } {
  if (worldW <= 0 || worldH <= 0) return { w: BIG_MAP_PX, h: BIG_MAP_PX };
  if (worldW >= worldH) return { w: BIG_MAP_PX, h: Math.round((BIG_MAP_PX * worldH) / worldW) };
  return { w: Math.round((BIG_MAP_PX * worldW) / worldH), h: BIG_MAP_PX };
}

/** A world point on the box, kept MARKER_INSET px inside it. */
export function bigMapPoint(
  wx: number,
  wy: number,
  worldW: number,
  worldH: number,
): { x: number; y: number } {
  const box = bigMapLayout(worldW, worldH);
  const clamp = (v: number, max: number) => Math.min(Math.max(MARKER_INSET, v), max - MARKER_INSET);
  return {
    x: clamp((wx / worldW) * box.w, box.w),
    y: clamp((wy / worldH) * box.h, box.h),
  };
}

export interface MapWindowDeps {
  world: WorldState;
  clans: ClanStore;
  assets?: AssetLoader;
  /** For our own head marker's wearable lookup. */
  content?: ContentStore;
  brZone?: BRZone;
}

/** Our head marker, px across (the arrow it replaced spanned 14). */
const OWN_MARKER_PX = 22;

export class MapWindow {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private dpr = 1;
  private lastRefresh = -Infinity;
  private readonly memory = new MapMemoryImage();

  mount(body: HTMLElement, deps: MapWindowDeps): void {
    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'dv-map';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'dv-map-canvas';
    wrap.appendChild(this.canvas);
    body.appendChild(wrap);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to obtain 2D context for the map canvas');
    this.ctx = ctx;
    this.dpr = window.devicePixelRatio || 1;
    this.lastRefresh = -Infinity;
    this.fit(deps.world);
    this.refresh(deps, true);
  }

  /** Sizes the canvas to the current map box (called on mount and when the world size changes). */
  private fit(world: WorldState): { w: number; h: number } {
    const box = bigMapLayout(world.worldWidth, world.worldHeight);
    const cssW = box.w + MAP_MARGIN * 2;
    const cssH = box.h + MAP_MARGIN * 2;
    if (
      this.canvas.width !== Math.round(cssW * this.dpr) ||
      this.canvas.height !== Math.round(cssH * this.dpr)
    ) {
      this.canvas.width = Math.round(cssW * this.dpr);
      this.canvas.height = Math.round(cssH * this.dpr);
      this.canvas.style.width = `${cssW}px`;
      this.canvas.style.height = `${cssH}px`;
    }
    return box;
  }

  /** Redraws at most every REFRESH_MS unless forced; the window manager calls it every frame. */
  refresh({ world, clans, assets, content, brZone }: MapWindowDeps, force = false): void {
    const now = performance.now();
    if (!force && now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;

    const worldW = world.worldWidth;
    const worldH = world.worldHeight;
    const box = this.fit(world);
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, box.w + MAP_MARGIN * 2, box.h + MAP_MARGIN * 2);
    ctx.save();
    ctx.translate(MAP_MARGIN, MAP_MARGIN);

    const local = world.getLocalEntity();
    const grid = sectorGrid(worldW, worldH);
    drawMapGrid(ctx, box.w, box.h, {
      grid,
      active: local ? sectorCell(local.x, local.y, worldW, worldH, grid) : undefined,
      margins: true,
      underlay: (c) => this.memory.draw(c, world.mapMemory, box.w, box.h),
    });

    if (brZone) brZone.renderMinimap(ctx, 0, 0, box.w, box.h, worldW, worldH);

    // Structures: cities then houses (CITIES_LOCATION), at their tile centres.
    const icon = (name: string, tx: number, ty: number) => {
      const p = bigMapPoint(tx * TILE_SIZE, ty * TILE_SIZE, worldW, worldH);
      const img = assets?.get(name);
      if (img) {
        const w = img.naturalWidth / 2;
        const h = img.naturalHeight / 2;
        ctx.drawImage(img.image, p.x - w / 2, p.y - h / 2, w, h);
      } else {
        ctx.fillStyle = 'rgba(230,236,245,.85)';
        ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
      }
    };
    for (const city of world.cities) icon('city-icon', city.x, city.y);
    for (const house of world.houses) icon('house-icon', house.x, house.y);

    // Clan mates (TEAM_POSITION, 0..255 over the map) as arrows with their names.
    ctx.font = `12px ${MAP_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const [guid, pos] of clans.positions) {
      const p = bigMapPoint((pos.x / 255) * worldW, (pos.y / 255) * worldH, worldW, worldH);
      this.arrow(ctx, p.x, p.y, 0, 'rgba(230,236,245,.9)');
      const name = world.players.get(guid)?.nickname;
      if (name) {
        ctx.fillStyle = '#f2f4f6';
        ctx.fillText(name, p.x, p.y - 9);
      }
    }

    // The worst-karma player (BAD_KARMA): their karma badge, as the old big map
    // drew KARMA[icon] at 1.25x for 14 s.
    if (world.badKarma) {
      const p = bigMapPoint(world.badKarma.x, world.badKarma.y, worldW, worldH);
      const img = assets?.get(karmaSprite(world.badKarma.karma));
      if (img) {
        const w = (img.naturalWidth / 2) * 1.25;
        const h = (img.naturalHeight / 2) * 1.25;
        ctx.drawImage(img.image, p.x - w / 2, p.y - h / 2, w, h);
      }
    }

    if (local) {
      const p = bigMapPoint(local.x, local.y, worldW, worldH);
      const look = assets && content ? ownHeadLook(world, content) : null;
      const drawn =
        !!look &&
        drawHeadMarker(ctx, assets!, look, p.x, p.y, world.localPlayerAngle, OWN_MARKER_PX);
      if (!drawn) this.arrow(ctx, p.x, p.y, world.localPlayerAngle, '#e3e7df');
    }
    ctx.restore();
  }

  private arrow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    angle: number,
    fill: string,
  ): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-6, 5.5);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, -5.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
