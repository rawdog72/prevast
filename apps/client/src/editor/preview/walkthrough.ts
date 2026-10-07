// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Offline walkthrough: walk the authored map with the game's renderer and basic collision,
// no server involved. It reads the document and never writes it; door toggles are preview
// state only. Combat, crafting, loot, AI, rules and real effect changes are server features
// and are deliberately absent -- the HUD says so.
import { TILE_SIZE } from '../../../../../shared/typescript/editor-limits';
import type { ScenarioEntity } from '../../../../../shared/typescript/scenario-schema';
import { pointInShape, regionWorldShape } from '../document/ops';
import type { EditorContext } from '../editor-context';
import { describeEffects } from '../ui/inspector-panel';

/** Server Creature::getCollisionRadius for players. */
export const PLAYER_RADIUS = 32;
/** Player::getSpeed walking / running, units per second. */
const WALK_SPEED = 230;
const RUN_SPEED = 322;
const NPC_RADIUS = 28;
const DOOR_REACH = 160;
const SAFE_SEARCH_TILES = 12;

export class Walkthrough {
  x = 0;
  y = 0;
  angle = 0;
  collision = true;
  /** Doors opened (or closed) in the preview only: id -> open. */
  readonly doorState = new Map<string, boolean>();
  private readonly keys = new Set<string>();

  constructor(private readonly ctx: EditorContext) {}

  /** Finds a safe start near `preferred`; null when nothing within reach is free. */
  enter(preferred: { x: number; y: number }): string | null {
    const { tilesX, tilesY } = this.ctx.store.header.world;
    const spawn = [...this.ctx.store.entities.values()].find((e) => e.kind === 'spawn');
    const start = spawn ?? preferred;
    const cx = Math.floor(start.x / TILE_SIZE);
    const cy = Math.floor(start.y / TILE_SIZE);
    if (!this.blocked(start.x, start.y)) return this.place(start.x, start.y);
    for (let r = 1; r <= SAFE_SEARCH_TILES; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = cx + dx;
          const ty = cy + dy;
          if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) continue;
          const x = tx * TILE_SIZE + TILE_SIZE / 2;
          const y = ty * TILE_SIZE + TILE_SIZE / 2;
          if (!this.blocked(x, y)) return this.place(x, y);
        }
    return null;
  }

  private place(x: number, y: number): string {
    this.x = x;
    this.y = y;
    return 'ok';
  }

  keyDown(key: string): void {
    this.keys.add(key.toLowerCase());
  }

  keyUp(key: string): void {
    this.keys.delete(key.toLowerCase());
  }

  releaseKeys(): void {
    this.keys.clear();
  }

  /** Aims at a world point (the cursor). */
  aim(wx: number, wy: number): void {
    this.angle = Math.atan2(wy - this.y, wx - this.x);
  }

  update(deltaMs: number): void {
    let dx = 0;
    let dy = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) dy -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) dy += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) dx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) dx += 1;
    if (!dx && !dy) return;
    const len = Math.hypot(dx, dy);
    const step = ((this.keys.has('shift') ? RUN_SPEED : WALK_SPEED) * Math.min(deltaMs, 100)) / 1000;
    const mx = (dx / len) * step;
    const my = (dy / len) * step;
    // Axis by axis, so a wall stops one direction and the player slides along it.
    if (!this.blocked(this.x + mx, this.y)) this.x += mx;
    if (!this.blocked(this.x, this.y + my)) this.y += my;
  }

  /** Toggles the nearest door within reach, in the preview only. */
  toggleDoor(): string | null {
    let best: ScenarioEntity | undefined;
    let bestD = DOOR_REACH;
    for (const id of this.ctx.spatial.query(this.x - DOOR_REACH, this.y - DOOR_REACH, this.x + DOOR_REACH, this.y + DOOR_REACH, 0)) {
      const e = this.ctx.store.entities.get(id);
      if (!e || !this.ctx.catalog.resolve(e.kind, e.ref, e.variant)?.isDoor) continue;
      const d = Math.hypot(e.x - this.x, e.y - this.y);
      if (d < bestD) {
        best = e;
        bestD = d;
      }
    }
    if (!best) return null;
    this.doorState.set(best.id, !this.doorOpen(best));
    return best.id;
  }

  doorOpen(e: ScenarioEntity): boolean {
    return this.doorState.get(e.id) ?? e.overrides?.doorOpen ?? false;
  }

  /** Regions whose area contains the avatar, strongest priority first, described. */
  describeHere(): string[] {
    const out: string[] = [];
    for (const r of this.ctx.store.regions.values()) {
      const shape = regionWorldShape(this.ctx.store, r);
      if (shape && pointInShape(shape, this.x, this.y)) out.push(`${r.name}: ${describeEffects(r)}`);
    }
    return out;
  }

  blocked(x: number, y: number): boolean {
    const { tilesX, tilesY } = this.ctx.store.header.world;
    const r = PLAYER_RADIUS;
    if (x - r < 0 || y - r < 0 || x + r > tilesX * TILE_SIZE || y + r > tilesY * TILE_SIZE) return true;
    if (!this.collision) return false;
    for (const id of this.ctx.spatial.query(x - 200, y - 200, x + 200, y + 200, 0)) {
      const e = this.ctx.store.entities.get(id);
      if (!e) continue;
      const entry = this.ctx.catalog.resolve(e.kind, e.ref, e.variant);
      if (!entry || this.ctx.hiddenLayers.has(entry.layer)) continue;
      if (entry.isDoor && this.doorOpen(e)) continue;
      const shape = e.kind === 'npc' ? ({ shape: 'circle', r: NPC_RADIUS } as const) : entry.collision;
      if (!shape) continue;
      if (shape.shape === 'circle') {
        if (Math.hypot(x - e.x, y - e.y) < shape.r + r) return true;
      } else {
        const w = e.rotation && e.rotation % 2 ? shape.h : shape.w;
        const hh = e.rotation && e.rotation % 2 ? shape.w : shape.h;
        const nx = Math.max(e.x - w / 2, Math.min(x, e.x + w / 2));
        const ny = Math.max(e.y - hh / 2, Math.min(y, e.y + hh / 2));
        if (Math.hypot(x - nx, y - ny) < r) return true;
      }
    }
    return false;
  }
}
