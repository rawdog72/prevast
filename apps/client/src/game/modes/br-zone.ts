// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import type { Camera } from '../../core/camera';

export interface BRZoneConfig {
  centerX: number;
  centerY: number;
  currentRadius: number;
  targetRadius?: number;
  shrinkDurationMs?: number;
  damagePerSecond?: number;
}

export class BRZone {
  centerX: number;
  centerY: number;
  currentRadius: number;
  targetRadius: number;

  private startRadius: number;
  private shrinkElapsedMs = 0;
  private shrinkDurationMs = 0;
  private isShrinking = false;
  private pulsePhase = 0;

  damagePerSecond: number;

  // Nothing currently drives this from the network (no handler ever calls
  // setTarget/setCenter), so the constructor defaults -- an arbitrary circle
  // at (3000,3000) r=4000 -- are all this ever renders. Outside an actual BR
  // match that arc is not a "storm boundary", it's a permanent giant purple
  // slash across whatever survival/ghoul map the player is on. Stay inactive
  // (render nothing) until something explicitly configures a real zone.
  private active = false;

  constructor(config?: Partial<BRZoneConfig>) {
    this.centerX = config?.centerX ?? 3000;
    this.centerY = config?.centerY ?? 3000;
    this.currentRadius = config?.currentRadius ?? 4000;
    this.targetRadius = config?.targetRadius ?? this.currentRadius;
    this.startRadius = this.currentRadius;
    this.damagePerSecond = config?.damagePerSecond ?? 5;
    this.active = config !== undefined;
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Configures or starts a new zone shrink stage.
   */
  setTarget(targetRadius: number, durationMs: number): void {
    this.active = true;
    this.startRadius = this.currentRadius;
    this.targetRadius = Math.max(0, targetRadius);
    this.shrinkElapsedMs = 0;
    this.shrinkDurationMs = Math.max(0, durationMs);
    this.isShrinking = durationMs > 0 && this.targetRadius !== this.startRadius;
    if (!this.isShrinking) {
      this.currentRadius = this.targetRadius;
    }
  }

  setCenter(cx: number, cy: number): void {
    this.active = true;
    this.centerX = cx;
    this.centerY = cy;
  }

  update(deltaMs: number): void {
    this.pulsePhase = (this.pulsePhase + deltaMs * 0.003) % (Math.PI * 2);

    if (!this.isShrinking) return;

    this.shrinkElapsedMs += deltaMs;
    const progress = Math.min(1, this.shrinkElapsedMs / this.shrinkDurationMs);

    // Smooth easeInOutQuad interpolation
    const easeProgress =
      progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;

    this.currentRadius = this.startRadius + (this.targetRadius - this.startRadius) * easeProgress;

    if (progress >= 1) {
      this.currentRadius = this.targetRadius;
      this.isShrinking = false;
    }
  }

  isInside(x: number, y: number): boolean {
    const dist = Math.hypot(x - this.centerX, y - this.centerY);
    return dist <= this.currentRadius;
  }

  distanceFromZone(x: number, y: number): number {
    const dist = Math.hypot(x - this.centerX, y - this.centerY);
    return Math.max(0, dist - this.currentRadius);
  }

  getShrinkProgress(): number {
    if (!this.isShrinking || this.shrinkDurationMs <= 0) return 1;
    return Math.min(1, this.shrinkElapsedMs / this.shrinkDurationMs);
  }

  getIsShrinking(): boolean {
    return this.isShrinking;
  }

  /**
   * Renders the danger storm zone and electric boundary line in world space.
   * Expects camera.applyTransform(ctx) to already be active or renders directly in world space.
   */
  renderWorld(
    ctx: CanvasRenderingContext2D,
    _camera: Camera,
    worldWidth: number,
    worldHeight: number,
  ): void {
    if (!this.active || this.currentRadius <= 0) return;

    // Draw danger area outside safe circle using evenodd fill
    ctx.save();
    ctx.beginPath();
    // Outer bounding rectangle (encompassing entire map + safety margin)
    ctx.rect(-1000, -1000, worldWidth + 2000, worldHeight + 2000);
    // Inner circular safe zone cut out
    ctx.arc(this.centerX, this.centerY, this.currentRadius, 0, Math.PI * 2, true);
    ctx.closePath();

    // Translucent storm overlay
    ctx.fillStyle = 'rgba(120, 20, 160, 0.28)';
    ctx.fill('evenodd');

    // Pulsing danger border ring
    const pulse = Math.sin(this.pulsePhase) * 0.2 + 0.8;
    ctx.strokeStyle = `rgba(180, 80, 255, ${pulse * 0.85})`;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, this.currentRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Inner bright energy core
    ctx.strokeStyle = `rgba(240, 220, 255, ${pulse * 0.9})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, this.currentRadius, 0, Math.PI * 2);
    ctx.stroke();

    // If shrinking, draw subtle dotted target boundary
    if (this.isShrinking && this.targetRadius > 0) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 2;
      ctx.setLineDash([12, 12]);
      ctx.beginPath();
      ctx.arc(this.centerX, this.centerY, this.targetRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  /**
   * Renders the safe and target circles on the minimap HUD.
   */
  renderMinimap(
    ctx: CanvasRenderingContext2D,
    mapX: number,
    mapY: number,
    mapWidth: number,
    mapHeight: number,
    worldWidth: number,
    worldHeight: number,
  ): void {
    if (!this.active || worldWidth <= 0 || worldHeight <= 0) return;

    const scaleX = mapWidth / worldWidth;
    const scaleY = mapHeight / worldHeight;
    const miniX = mapX + this.centerX * scaleX;
    const miniY = mapY + this.centerY * scaleY;
    const miniRadius = this.currentRadius * ((scaleX + scaleY) / 2);

    ctx.save();

    // Target circle (if shrinking)
    if (this.isShrinking && this.targetRadius > 0) {
      const targetMiniRadius = this.targetRadius * ((scaleX + scaleY) / 2);
      ctx.strokeStyle = '#facc15'; // yellow dash
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(miniX, miniY, Math.max(1, targetMiniRadius), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Current safe zone circle
    ctx.strokeStyle = '#38bdf8'; // bright cyan
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(miniX, miniY, Math.max(1, miniRadius), 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }
}
