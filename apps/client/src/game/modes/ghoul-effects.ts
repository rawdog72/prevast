// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

export interface GhoulState {
  isGhoul: boolean;
  infection: number; // 0.0 to 1.0
  level: number;
}

export class GhoulEffects {
  isGhoul = false;
  infection = 0.0;
  level = 1;

  private pulsePhase = 0;
  private heartbeatAlpha = 0;

  constructor(initialState?: Partial<GhoulState>) {
    if (initialState?.isGhoul !== undefined) this.isGhoul = initialState.isGhoul;
    if (initialState?.infection !== undefined) this.infection = initialState.infection;
    if (initialState?.level !== undefined) this.level = initialState.level;
  }

  setGhoul(isGhoul: boolean, level = 1): void {
    this.isGhoul = isGhoul;
    this.level = level;
  }

  setInfection(level: number): void {
    this.infection = Math.max(0, Math.min(1, level));
  }

  update(deltaMs: number): void {
    // Pulse speed increases if infected or ghoul
    const pulseSpeed = this.isGhoul
      ? 0.004
      : this.infection > 0
        ? 0.002 + this.infection * 0.004
        : 0.001;
    this.pulsePhase = (this.pulsePhase + deltaMs * pulseSpeed) % (Math.PI * 2);

    // Heartbeat rhythmic intensity
    const beat = Math.sin(this.pulsePhase);
    this.heartbeatAlpha = Math.max(0, beat);
  }

  /**
   * Returns darkness vision multiplier (ghouls can see significantly further in the dark).
   */
  getVisionRadiusMultiplier(): number {
    if (this.isGhoul) {
      return Math.round((1.6 + (this.level - 1) * 0.1) * 100) / 100;
    }
    return 1.0;
  }

  /**
   * Renders screen-space dark atmosphere, blood vignette, and mutation pulse.
   */
  renderScreenEffects(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (!this.isGhoul && this.infection <= 0) return;

    ctx.save();

    const cx = width / 2;
    const cy = height / 2;
    const maxRadius = Math.hypot(cx, cy);

    if (this.isGhoul) {
      // Ghoul dark predator vignette
      const pulse = 0.4 + this.heartbeatAlpha * 0.2;
      const innerRadius = maxRadius * 0.35;
      const outerRadius = maxRadius * 0.95;

      const grad = ctx.createRadialGradient(cx, cy, innerRadius, cx, cy, outerRadius);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      grad.addColorStop(0.65, `rgba(50, 5, 10, ${pulse * 0.35})`);
      grad.addColorStop(1, `rgba(80, 0, 5, ${pulse * 0.75})`);

      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      // Subtle edge veins/darkness
      ctx.strokeStyle = `rgba(180, 20, 20, ${this.heartbeatAlpha * 0.3})`;
      ctx.lineWidth = 12;
      ctx.strokeRect(0, 0, width, height);
    } else if (this.infection > 0) {
      // Infection creep vignette
      const pulse = 0.2 + this.heartbeatAlpha * 0.15 * this.infection;
      const innerRadius = maxRadius * (0.8 - this.infection * 0.35);
      const outerRadius = maxRadius;

      const grad = ctx.createRadialGradient(cx, cy, innerRadius, cx, cy, outerRadius);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      grad.addColorStop(1, `rgba(70, 10, 15, ${pulse * this.infection})`);

      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
    }

    ctx.restore();
  }

  /**
   * Renders a scent tracking trail from local ghoul toward a living target entity.
   */
  renderScentTrail(
    ctx: CanvasRenderingContext2D,
    startX: number,
    startY: number,
    targetX: number,
    targetY: number,
  ): void {
    if (!this.isGhoul) return;

    const dist = Math.hypot(targetX - startX, targetY - startY);
    if (dist > 1200) return; // Scent limit

    const alpha = Math.max(0, 1 - dist / 1200) * (0.3 + this.heartbeatAlpha * 0.3);

    ctx.save();
    ctx.strokeStyle = `rgba(220, 38, 38, ${alpha})`;
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(targetX, targetY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}
