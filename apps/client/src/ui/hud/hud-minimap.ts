// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-minimap.ts
// Minimap after the old client's _Minimap inside GameUI.minimapPanel: NOT the
// whole map but a window on the world around the player. The old code scaled
// the world to an 824 px image and drew a 256 px crop of it at half size, so
// on the 150-tile map the small map showed about a third of the world and
// scrolled as you walked, pinned at the edges with the arrow sliding off
// centre instead. That world-per-pixel is kept fixed here, so the view means
// the same thing on a 50- or a 655-tile map (admins resize maps live; every
// frame reads the current size). Under the sector grid (GameUI.mapGrid, cells
// named A1..) goes what we have seen of the map (MapMemory), with structure
// markers and clan mates on top; the column beside the map names the sector
// we stand in.

import type { AssetLoader } from '../../assets/asset-loader';
import type { ContentStore } from '../../content/store';
import { drawHeadMarker, ownHeadLook } from '../../render/player-marker';
import type { BRZone } from '../../game/modes/br-zone';
import type { ClanStore } from '../../world/clan-store';
import type { WorldState } from '../../world/world-state';
import { karmaSprite } from './hud-leaderboard';
import { columnLabel, drawMapGrid, MapMemoryImage, sectorCell, sectorGrid } from './map-grid';

const TILE_SIZE = 100;
const MINIMAP_INTERVAL_MS = 100;
/** Old client: the 150-tile world (15000 units) spanned 824 texture px, shown at half size. */
export const WORLD_PER_VIEW_PX = 15000 / 412;
/** Our head marker, px across (the arrow it replaced spanned 10). */
const OWN_MARKER_PX = 16;
/** Arrows stay this far inside the frame (old `Math.max(15, ...)`, `minimapSize - 8`). */
const MARKER_INSET = 15;
const OWN_MARKER_EDGE = 8;

/** mapGrid naming: column letter(s) then row number of the cell containing (x, y). */
export function sectorLabel(x: number, y: number, worldW: number, worldH: number): string {
  const cell = sectorCell(x, y, worldW, worldH);
  return `${columnLabel(cell.col)}${cell.row + 1}`;
}

export interface MinimapView {
  /** World coordinate shown at the view's top-left corner. */
  originX: number;
  originY: number;
  /** View px per world unit. */
  scale: number;
  /** World -> view pixels. */
  toView(wx: number, wy: number): { x: number; y: number };
  /** Where our own arrow goes: mid-view, sliding towards the edge when the window is pinned. */
  marker: { x: number; y: number };
}

/**
 * The old `_Minimap` maths for a `viewW x viewH` canvas: which part of the
 * world to show for a player at (px, py), and how to place things on it. The
 * window is pinned inside the map; a map smaller than the window is centred.
 */
export function minimapView(
  px: number,
  py: number,
  worldW: number,
  worldH: number,
  viewW: number,
  viewH: number,
): MinimapView {
  const scale = 1 / WORLD_PER_VIEW_PX;
  const spanW = viewW * WORLD_PER_VIEW_PX;
  const spanH = viewH * WORLD_PER_VIEW_PX;
  const pin = (p: number, span: number, world: number) =>
    world <= span ? (world - span) / 2 : Math.min(Math.max(0, p - span / 2), world - span);
  const originX = pin(px, spanW, worldW);
  const originY = pin(py, spanH, worldH);
  const toView = (wx: number, wy: number) => ({
    x: (wx - originX) * scale,
    y: (wy - originY) * scale,
  });
  const me = toView(px, py);
  return {
    originX,
    originY,
    scale,
    toView,
    marker: {
      x: Math.min(Math.max(MARKER_INSET, me.x), viewW - OWN_MARKER_EDGE),
      y: Math.min(Math.max(MARKER_INSET, me.y), viewH - OWN_MARKER_EDGE),
    },
  };
}

export class HudMinimap {
  private mounted = false;
  private ctx!: CanvasRenderingContext2D;
  private lastRender = -Infinity;
  private width = 178;
  private height = 178;
  private sectorEl: HTMLElement | null = null;
  private lastSector = '';
  private canvas!: HTMLCanvasElement;
  /** The region's CSS zoom (Options > Interface size); the backing store follows it. */
  private scale = 1;
  private readonly memory = new MapMemoryImage();

  mount(canvas: HTMLCanvasElement, sectorEl?: HTMLElement | null): void {
    if (this.mounted) return;
    this.mounted = true;
    this.sectorEl = sectorEl ?? null;
    this.canvas = canvas;
    // The drawing space is the element's own size (its width/height
    // attributes, 178x178 in the HTML); zoom and DPR only size the backing store.
    this.width = canvas.width;
    this.height = canvas.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to obtain 2D context for minimap canvas');
    this.ctx = ctx;
    this.resizeBackingStore();
  }

  /** Called when the minimap region's zoom changes so a scaled-up map is drawn sharp, not upscaled. */
  setScale(scale: number): void {
    if (scale === this.scale || !this.mounted) return;
    this.scale = scale;
    this.resizeBackingStore();
    this.lastRender = -Infinity;
  }

  private resizeBackingStore(): void {
    const k = (window.devicePixelRatio || 1) * this.scale;
    this.canvas.width = Math.round(this.width * k);
    this.canvas.height = Math.round(this.height * k);
    this.ctx.setTransform(k, 0, 0, k, 0, 0);
  }

  render(
    world: WorldState,
    clans: ClanStore,
    brZone?: BRZone,
    assets?: AssetLoader,
    content?: ContentStore,
  ): void {
    // A 10 Hz map is indistinguishable from a 60 Hz one, and this small
    // canvas is software-rasterised and re-uploaded on every change.
    const now = performance.now();
    if (now - this.lastRender < MINIMAP_INTERVAL_MS) return;
    this.lastRender = now;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);

    const wWidth = world.worldWidth || 15000;
    const wHeight = world.worldHeight || 15000;
    const local = world.getLocalEntity();
    const px = local?.x ?? wWidth / 2;
    const py = local?.y ?? wHeight / 2;
    const view = minimapView(px, py, wWidth, wHeight, w, h);
    const grid = sectorGrid(wWidth, wHeight);

    // The world rectangle in view space, with only the visible cells drawn.
    const origin = view.toView(0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.translate(origin.x, origin.y);
    const mapW = wWidth * view.scale;
    const mapH = wHeight * view.scale;
    drawMapGrid(
      ctx,
      mapW,
      mapH,
      {
        grid,
        active: local ? sectorCell(px, py, wWidth, wHeight, grid) : undefined,
        underlay: (c) => this.memory.draw(c, world.mapMemory, mapW, mapH),
      },
      { x: -origin.x, y: -origin.y, w, h },
    );
    ctx.restore();

    // Structure markers (CITY_LOCATIONS, tile coordinates) that fall inside the window.
    const marker = (name: string, tx: number, ty: number) => {
      const p = view.toView(tx * TILE_SIZE, ty * TILE_SIZE);
      if (p.x < 0 || p.y < 0 || p.x > w || p.y > h) return;
      const img = assets?.get(name);
      if (img) {
        const mw = img.naturalWidth / 4;
        const mh = img.naturalHeight / 4;
        ctx.drawImage(img.image, p.x - mw / 2, p.y - mh / 2, mw, mh);
      } else {
        ctx.fillStyle = 'rgba(230,236,245,.7)';
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
      }
    };
    for (const house of world.houses) marker('house-icon', house.x, house.y);
    for (const city of world.cities) marker('city-icon', city.x, city.y);

    // Clan mates (PLAYER_POSITIONS is scaled to 0..255 over the map), kept inside
    // the frame like the old arrows so a far mate sits on the edge towards them.
    ctx.fillStyle = 'rgba(230,236,245,.9)';
    for (const [, pos] of clans.positions) {
      const p = view.toView((pos.x / 255) * wWidth, (pos.y / 255) * wHeight);
      const x = Math.min(Math.max(MARKER_INSET, p.x), w - MARKER_INSET);
      const y = Math.min(Math.max(MARKER_INSET, p.y), h - MARKER_INSET);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // The worst-karma player (WORST_KARMA_PLAYER): their karma badge for 14 s, kept
    // inside the frame like the old `Math.max(15, Math.min(size - 15, ...))`.
    if (world.badKarma) {
      const img = assets?.get(karmaSprite(world.badKarma.karma));
      if (img) {
        const p = view.toView(world.badKarma.x, world.badKarma.y);
        const x = Math.min(Math.max(MARKER_INSET, p.x), w - MARKER_INSET);
        const y = Math.min(Math.max(MARKER_INSET, p.y), h - MARKER_INSET);
        const mw = img.naturalWidth / 3;
        const mh = img.naturalHeight / 3;
        ctx.drawImage(img.image, x - mw / 2, y - mh / 2, mw, mh);
      }
    }

    if (local) {
      // Us: our own head as the character renderer draws it, turned to our
      // aim; the old arrow only until the sprite is in.
      const look = assets && content ? ownHeadLook(world, content) : null;
      const drawn =
        !!look &&
        drawHeadMarker(
          ctx,
          assets!,
          look,
          view.marker.x,
          view.marker.y,
          world.localPlayerAngle,
          OWN_MARKER_PX,
        );
      if (!drawn) {
        ctx.save();
        ctx.translate(view.marker.x, view.marker.y);
        ctx.rotate(world.localPlayerAngle);
        ctx.fillStyle = '#e3e7df';
        ctx.beginPath();
        ctx.moveTo(6, 0);
        ctx.lineTo(-4, 4);
        ctx.lineTo(-2, 0);
        ctx.lineTo(-4, -4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      const sector = sectorLabel(local.x, local.y, wWidth, wHeight);
      if (this.sectorEl && sector !== this.lastSector) {
        this.lastSector = sector;
        this.sectorEl.textContent = sector;
      }
    }

    if (brZone) {
      // The zone renders over a whole-world rectangle: give it the world at
      // view scale, shifted to the window, clipped to the frame.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();
      brZone.renderMinimap(
        ctx,
        origin.x,
        origin.y,
        wWidth * view.scale,
        wHeight * view.scale,
        wWidth,
        wHeight,
      );
      ctx.restore();
    }
  }
}
