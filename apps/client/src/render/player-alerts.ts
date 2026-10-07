// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/player-alerts.ts
// The old client's _playerNotification: when a player's health / hunger /
// cold / radiation crosses a threshold the server broadcasts OVERHEAD_ALERT and
// an alert{type}_{level} bubble pops above that player for 3 s -- fading in
// over the first 500 ms while rising 15 px into place, and fading out over
// the last 500 ms while drifting 40 px up. Each player has a FIFO; only its
// head is shown, the next starts when it expires.

import type { AssetLoader } from '../assets/asset-loader';
import type { Camera } from '../core/camera';
import type { WorldState } from '../world/world-state';

const SHOW_MS = 3000;
const FADE_IN_MS = 500;
const FADE_OUT_START_MS = 2500;
/** Old client draw offset from the player's position, in world units. */
const OFFSET_X = -120;
const OFFSET_Y = -45;

export interface AlertFrame {
  sprite: string;
  alpha: number;
  /** Vertical drift in world units, added to OFFSET_Y. */
  offsetY: number;
}

interface Queue {
  items: { type: number; level: number }[];
  elapsedMs: number;
}

export class PlayerAlerts {
  private readonly queues = new Map<number, Queue>();

  push(pid: number, type: number, level: number): void {
    let q = this.queues.get(pid);
    if (!q) {
      q = { items: [], elapsedMs: 0 };
      this.queues.set(pid, q);
    }
    q.items.push({ type, level });
  }

  clear(pid: number): void {
    this.queues.delete(pid);
  }

  update(deltaMs: number): void {
    for (const [pid, q] of this.queues) {
      if (q.items.length === 0) {
        this.queues.delete(pid);
        continue;
      }
      q.elapsedMs += deltaMs;
      if (q.elapsedMs >= SHOW_MS) {
        q.elapsedMs = 0;
        q.items.shift();
        if (q.items.length === 0) this.queues.delete(pid);
      }
    }
  }

  frame(pid: number): AlertFrame | null {
    const q = this.queues.get(pid);
    if (!q || q.items.length === 0) return null;
    const head = q.items[0];
    const t = q.elapsedMs;
    let alpha = 1;
    let offsetY = 0;
    if (t < FADE_IN_MS) {
      alpha = t / FADE_IN_MS;
      offsetY = 15 * (1 - alpha);
    } else if (t > FADE_OUT_START_MS) {
      alpha = (SHOW_MS - t) / (SHOW_MS - FADE_OUT_START_MS);
      offsetY = 40 * (alpha - 1);
    }
    return { sprite: `alert${head.type}_${head.level}`, alpha, offsetY };
  }

  render(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    assets: AssetLoader,
    world: WorldState,
  ): void {
    if (this.queues.size === 0) return;
    const zoom = camera.zoom;
    for (const pid of this.queues.keys()) {
      const f = this.frame(pid);
      if (!f) continue;
      const entity = world.entities.get(pid, 0);
      if (!entity || entity.removed) continue;
      const img = assets.get(f.sprite);
      if (!img) continue;
      const p = camera.worldToScreen(entity.x + OFFSET_X, entity.y + OFFSET_Y + f.offsetY);
      const w = (img.naturalWidth / 2) * zoom;
      const h = (img.naturalHeight / 2) * zoom;
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = prev * f.alpha;
      ctx.drawImage(img.image, p.x, p.y, w, h);
      ctx.globalAlpha = prev;
    }
  }
}
