// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Minimap: the cached overview bitmap, the current view, and click/drag navigation.
import { TILE_SIZE } from '../../../../../shared/typescript/editor-limits';
import type { Camera } from '../../core/camera';
import type { OverviewBitmap } from '../scene/overview';
import { h } from './dom';

const MAX_SIZE = 190;

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private dragging = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly camera: Camera,
    private readonly tiles: () => { tilesX: number; tilesY: number },
    private readonly moved: () => void,
  ) {
    this.canvas = h('canvas', { class: 'we-minimap', 'aria-label': 'Minimap: click to move the view', role: 'img' });
    const down = (ev: PointerEvent) => {
      this.dragging = true;
      this.canvas.setPointerCapture(ev.pointerId);
      this.jump(ev);
    };
    const move = (ev: PointerEvent) => this.dragging && this.jump(ev);
    const up = () => (this.dragging = false);
    this.canvas.addEventListener('pointerdown', down);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.cleanups.push(() => {
      this.canvas.removeEventListener('pointerdown', down);
      this.canvas.removeEventListener('pointermove', move);
      this.canvas.removeEventListener('pointerup', up);
    });
  }

  dispose(): void {
    for (const c of this.cleanups) c();
  }

  private scale(): number {
    const { tilesX, tilesY } = this.tiles();
    return MAX_SIZE / Math.max(tilesX, tilesY);
  }

  private jump(ev: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const s = this.scale();
    this.camera.x = ((ev.clientX - rect.left) / s) * TILE_SIZE;
    this.camera.y = ((ev.clientY - rect.top) / s) * TILE_SIZE;
    this.moved();
  }

  draw(overview: OverviewBitmap): void {
    const { tilesX, tilesY } = this.tiles();
    const s = this.scale();
    const w = Math.max(1, Math.round(tilesX * s));
    const hh = Math.max(1, Math.round(tilesY * s));
    if (this.canvas.width !== w || this.canvas.height !== hh) {
      this.canvas.width = w;
      this.canvas.height = hh;
    }
    const g = this.canvas.getContext('2d');
    if (!g) return;
    g.imageSmoothingEnabled = false;
    g.drawImage(overview.bitmap(), 0, 0, w, hh);
    const cam = this.camera;
    const vw = cam.viewportWidth / cam.zoom / TILE_SIZE;
    const vh = cam.viewportHeight / cam.zoom / TILE_SIZE;
    g.strokeStyle = '#ffe680';
    g.lineWidth = 1.5;
    g.strokeRect((cam.x / TILE_SIZE - vw / 2) * s, (cam.y / TILE_SIZE - vh / 2) * s, vw * s, vh * s);
  }
}
