// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// 2D Camera managing world coordinates, mouse look-ahead, screen shake, and viewport transforms.
import { frameLerp, lerp } from './math2d';

// Mouse look-ahead, as the old client did it (myplayerfocusinscreen): the view
// stays locked on the player until the cursor leaves a dead zone a quarter of
// the screen wide, then shifts up to LOOK_MAX world units toward the cursor,
// reaching the full shift another quarter-screen out. Eased slowly so aiming
// around never makes the world swim underfoot.
export const LOOK_MAX = 100;
const LOOK_EASE_PER_FRAME = 0.025;
/**
 * While a scope pushes the look-ahead past LOOK_MAX, and while it eases back
 * from there, the camera tracks it this fast instead (about 150 ms): aiming
 * into a scope and out of it is quick, and the ordinary look-ahead keeps its
 * slow drift.
 */
const AIM_LOOK_EASE_PER_FRAME = 0.2;

/** Jolt amplitudes in world units (old client: hit `random*6-3`, blast `random*18-9`), counted in 60 Hz frames. */
const HIT_SHAKE = 3;
const HIT_SHAKE_FRAMES = 3;
/**
 * The hit jolt fires at most once a second. Damage that ticks -- a spike trap
 * deals 1 every 100 ms -- restarted it ten times a second, which read as one
 * long violent shake for as long as the player stood there.
 */
const HIT_SHAKE_COOLDOWN_MS = 1000;
const EXPLOSION_SHAKE = 9;
const FRAME_MS = 1000 / 60;

// The old client (initAnimatedCanvas size 1280, scaleby = max(h/880, w/1280))
// showed a fixed 1280x880 world-unit area whatever the window size, so a big
// monitor got bigger sprites rather than more of the map -- and a constant
// number of entities to draw. The server's cosmetic broadcast radius assumes
// the same (config.lua eventBroadcastRadius).
export const BASE_VIEW_WIDTH = 1280;
export const BASE_VIEW_HEIGHT = 880;

/** World scale that shows the old client's fixed view area in a viewport of this size. */
export function baseWorldScale(viewportWidth: number, viewportHeight: number): number {
  return Math.max(viewportHeight / BASE_VIEW_HEIGHT, viewportWidth / BASE_VIEW_WIDTH);
}

/**
 * How far a strong scope moves the view centre toward the screen edge along
 * the aim: this share of the distance from the centre to that edge. The
 * player ends up near the opposite edge, with the shape ahead filling the
 * screen. aim_view::CLIENT_SCOPE_OFFSET mirrors it for the server's
 * off-screen note.
 */
export const SCOPE_OFFSET = 0.85;

/** Where a strong scope puts the view centre, as an offset from the player, and how far into the scope the camera is (0..1). */
export interface ScopeTarget {
  x: number;
  y: number;
  blend: number;
}

/**
 * The offset from the player to the view centre while a strong scope aims
 * toward `angle` (radians, y down): SCOPE_OFFSET of the distance from the
 * centre to the screen edge along the aim, in world units, at `zoom` (screen
 * pixels per world unit) on a viewport of this size.
 */
export function scopeOffset(
  angle: number,
  viewportWidth: number,
  viewportHeight: number,
  zoom: number,
): { x: number; y: number } {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const toSide = Math.abs(c) > 1e-9 ? viewportWidth / 2 / zoom / Math.abs(c) : Infinity;
  const toTop = Math.abs(s) > 1e-9 ? viewportHeight / 2 / zoom / Math.abs(s) : Infinity;
  const t = Math.min(toSide, toTop);
  return { x: SCOPE_OFFSET * t * c, y: SCOPE_OFFSET * t * s };
}

export interface CameraOptions {
  viewportWidth?: number;
  viewportHeight?: number;
  zoom?: number;
}

export class Camera {
  x = 0;
  y = 0;
  viewportWidth = 800;
  viewportHeight = 600;
  zoom = 1.0;

  // Smoothed mouse look-ahead offset
  lookX = 0;
  lookY = 0;

  // Screen shake: this frame's offset and the two jolt clocks feeding it.
  shakeOffsetX = 0;
  shakeOffsetY = 0;
  /**
   * Old client onPlayerHit (`Render.shake = 3`): frames left of a +-HIT_SHAKE
   * jolt. An assignment, never a sum -- ten ghouls landing in one tick shake
   * the screen exactly as much as one does.
   */
  hitFrames = 0;
  /** Ms until another hit may shake the screen (HIT_SHAKE_COOLDOWN_MS). */
  hitCooldownMs = 0;
  /**
   * Old client Render.explosionShake (SHAKE_EXPLOSION_STATE): frames left of a
   * +-EXPLOSION_SHAKE world-unit jolt, counted in 60 Hz frames.
   */
  explosionFrames = 0;

  constructor(options?: CameraOptions) {
    if (options?.viewportWidth !== undefined) this.viewportWidth = options.viewportWidth;
    if (options?.viewportHeight !== undefined) this.viewportHeight = options.viewportHeight;
    if (options?.zoom !== undefined) this.zoom = options.zoom;
  }

  setViewport(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  setZoom(zoom: number): void {
    this.zoom = Math.max(0.1, zoom);
  }

  /** PLAYER_HIT on us: the short hit jolt (see hitFrames), at most once per cooldown. */
  hitShake(): void {
    if (this.hitCooldownMs > 0) return;
    this.hitFrames = HIT_SHAKE_FRAMES;
    this.hitCooldownMs = HIT_SHAKE_COOLDOWN_MS;
  }

  /** Starts (or restarts, as the old client's assignment did) an explosion jolt of `frames` frames. */
  explosionShake(frames: number): void {
    this.explosionFrames = Math.max(0, frames);
  }

  /**
   * Updates camera target position, smooths look-ahead offset, and decays shake.
   * @param targetX Local player world X
   * @param targetY Local player world Y
   * @param mouseDx Mouse distance X from screen center in CSS pixels
   * @param mouseDy Mouse distance Y from screen center in CSS pixels
   * @param delta Frame time delta in milliseconds
   * @param lookMax The furthest the view slides toward the cursor: LOOK_MAX, or a scope's `ahead` while aimed
   * @param scope While a strong scope is aimed: where it puts the view centre, which replaces the look-ahead by its blend
   */
  update(
    targetX: number,
    targetY: number,
    mouseDx = 0,
    mouseDy = 0,
    delta = 16.67,
    lookMax = LOOK_MAX,
    scope?: ScopeTarget,
  ): void {
    this.x = targetX;
    this.y = targetY;

    // Look-ahead (see LOOK_MAX): dead zone and ramp are measured in screen
    // pixels so zoom does not change where the effect starts; the shift itself
    // is in world units.
    const deadZone = Math.min(this.viewportWidth, this.viewportHeight) / 4;
    const mouseDist = Math.hypot(mouseDx, mouseDy);
    let targetLookX = 0;
    let targetLookY = 0;
    if (mouseDist > deadZone) {
      const look = lookMax * Math.min((mouseDist - deadZone) / deadZone, 1);
      targetLookX = (look * mouseDx) / mouseDist;
      targetLookY = (look * mouseDy) / mouseDist;
    }
    // A strong scope replaces the look-ahead with its own target, by its blend.
    const strong = scope !== undefined && scope.blend > 0;
    if (strong) {
      targetLookX += (scope.x - targetLookX) * scope.blend;
      targetLookY += (scope.y - targetLookY) * scope.blend;
    }
    const scoped = strong || lookMax > LOOK_MAX || Math.hypot(this.lookX, this.lookY) > LOOK_MAX + 0.5;
    const ease = frameLerp(scoped ? AIM_LOOK_EASE_PER_FRAME : LOOK_EASE_PER_FRAME, delta);
    this.lookX = lerp(this.lookX, targetLookX, ease);
    this.lookY = lerp(this.lookY, targetLookY, ease);

    // Screen shake: the hit jolt and the explosion jolt, each a fixed amplitude
    // for a fixed number of 60 Hz frames, summed when both run (old client
    // `random * 6 - 3` while shake > 0, `random * 18 - 9` while explosionShake > 0).
    this.shakeOffsetX = 0;
    this.shakeOffsetY = 0;
    if (this.hitCooldownMs > 0) this.hitCooldownMs = Math.max(0, this.hitCooldownMs - delta);
    if (this.hitFrames > 0) {
      this.hitFrames = Math.max(0, this.hitFrames - delta / FRAME_MS);
      if (this.hitFrames > 0) {
        this.shakeOffsetX += (Math.random() * 2 - 1) * HIT_SHAKE;
        this.shakeOffsetY += (Math.random() * 2 - 1) * HIT_SHAKE;
      }
    }
    if (this.explosionFrames > 0) {
      this.explosionFrames = Math.max(0, this.explosionFrames - delta / FRAME_MS);
      if (this.explosionFrames > 0) {
        this.shakeOffsetX += (Math.random() * 2 - 1) * EXPLOSION_SHAKE;
        this.shakeOffsetY += (Math.random() * 2 - 1) * EXPLOSION_SHAKE;
      }
    }
  }

  /** Final camera center including look-ahead and shake */
  get centerX(): number {
    return this.x + this.lookX + this.shakeOffsetX;
  }

  get centerY(): number {
    return this.y + this.lookY + this.shakeOffsetY;
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const halfW = this.viewportWidth / 2;
    const halfH = this.viewportHeight / 2;
    return {
      x: halfW + (wx - this.centerX) * this.zoom,
      y: halfH + (wy - this.centerY) * this.zoom,
    };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const halfW = this.viewportWidth / 2;
    const halfH = this.viewportHeight / 2;
    return {
      x: this.centerX + (sx - halfW) / this.zoom,
      y: this.centerY + (sy - halfH) / this.zoom,
    };
  }

  /**
   * Fast visibility bounding box check for frustum culling.
   */
  isVisible(wx: number, wy: number, radius = 50): boolean {
    const screen = this.worldToScreen(wx, wy);
    const r = radius * this.zoom;
    return (
      screen.x + r >= 0 &&
      screen.x - r <= this.viewportWidth &&
      screen.y + r >= 0 &&
      screen.y - r <= this.viewportHeight
    );
  }

  /**
   * Applies the camera translation and zoom matrix to the 2D canvas context.
   */
  applyTransform(ctx: CanvasRenderingContext2D): void {
    ctx.translate(this.viewportWidth / 2, this.viewportHeight / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.centerX, -this.centerY);
  }
}
