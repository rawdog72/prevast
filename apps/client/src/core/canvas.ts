// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// CanvasManager handles the HTML5 canvas element, full-screen sizing,
// devicePixelRatio scaling, and resize dispatch.

export interface CanvasDimensions {
  width: number;
  height: number;
  dpr: number;
}

/**
 * Backing-store divisors the poison effect may pick from. Assigning
 * canvas.width reallocates the buffer, so the continuous 1..21 curve is
 * snapped to these few steps rather than resized every frame.
 */
const RESOLUTION_LEVELS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16, 21];

export function snapResolutionDivisor(divisor: number): number {
  let best = RESOLUTION_LEVELS[0]!;
  for (const level of RESOLUTION_LEVELS) {
    if (Math.abs(level - divisor) < Math.abs(best - divisor)) best = level;
  }
  return best;
}

export class CanvasManager {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;

  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  private divisor = 1;
  private readonly listeners = new Set<(dims: CanvasDimensions) => void>();
  private readonly handleResize = () => this.resize();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Failed to obtain 2D canvas rendering context');
    this.ctx = ctx;

    this.resize();
    window.addEventListener('resize', this.handleResize);
  }

  get width(): number {
    return this.cssWidth;
  }

  get height(): number {
    return this.cssHeight;
  }

  get pixelRatio(): number {
    return this.dpr;
  }

  /** Current backing-store divisor (1 = full resolution). */
  get resolutionDivisor(): number {
    return this.divisor;
  }

  /**
   * Draws the frame at 1/`divisor` of the device resolution, stretched back
   * up by CSS -- the old client's scheduledRatio trick the poison screen uses.
   * Snapped to RESOLUTION_LEVELS; only a change touches the canvas.
   */
  setResolutionDivisor(divisor: number): void {
    const snapped = snapResolutionDivisor(divisor);
    if (snapped === this.divisor) return;
    this.divisor = snapped;
    this.applyBackingStore();
  }

  onResize(listener: (dims: CanvasDimensions) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resize(): void {
    const cssWidth = window.innerWidth || 800;
    const cssHeight = window.innerHeight || 600;
    const dpr = window.devicePixelRatio || 1;

    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;
    this.applyBackingStore();

    const dims: CanvasDimensions = { width: cssWidth, height: cssHeight, dpr };
    for (const listener of this.listeners) {
      listener(dims);
    }
  }

  private applyBackingStore(): void {
    const ratio = this.dpr / this.divisor;
    this.canvas.width = Math.max(1, Math.floor(this.cssWidth * ratio));
    this.canvas.height = Math.max(1, Math.floor(this.cssHeight * ratio));
    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;

    // Scale canvas context so draw operations use CSS pixel coordinates
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  destroy(): void {
    window.removeEventListener('resize', this.handleResize);
    this.listeners.clear();
  }
}
