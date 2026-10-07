// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { BASE_VIEW_HEIGHT, BASE_VIEW_WIDTH, Camera, LOOK_MAX, SCOPE_OFFSET, scopeOffset } from './camera';

describe('Camera', () => {
  it('converts world to screen coordinates centered on target', () => {
    const cam = new Camera({ viewportWidth: 800, viewportHeight: 600, zoom: 1.0 });
    cam.update(1000, 2000);

    const screenPos = cam.worldToScreen(1000, 2000);
    expect(screenPos.x).toBe(400);
    expect(screenPos.y).toBe(300);

    const offsetScreen = cam.worldToScreen(1100, 1950);
    expect(offsetScreen.x).toBe(500);
    expect(offsetScreen.y).toBe(250);
  });

  it('round-trips screen to world and world to screen', () => {
    const cam = new Camera({ viewportWidth: 1024, viewportHeight: 768, zoom: 1.5 });
    cam.update(500, 300);

    const world = { x: 550, y: 320 };
    const screen = cam.worldToScreen(world.x, world.y);
    const backToWorld = cam.screenToWorld(screen.x, screen.y);

    expect(backToWorld.x).toBeCloseTo(world.x);
    expect(backToWorld.y).toBeCloseTo(world.y);
  });

  it('culls points outside viewport with radius tolerance', () => {
    const cam = new Camera({ viewportWidth: 800, viewportHeight: 600, zoom: 1.0 });
    cam.update(0, 0);

    expect(cam.isVisible(0, 0)).toBe(true);
    expect(cam.isVisible(390, 290)).toBe(true);
    // Well beyond the right edge (400)
    expect(cam.isVisible(600, 0, 50)).toBe(false);
    // Just beyond the edge but overlapping radius (430 with radius 50 overlaps 400)
    expect(cam.isVisible(430, 0, 50)).toBe(true);
  });

  describe('mouse look-ahead', () => {
    const settle = (
      cam: Camera,
      mouseDx: number,
      mouseDy: number,
      ms: number,
      frame = 1000 / 60,
    ) => {
      for (let t = 0; t < ms; t += frame) cam.update(1000, 1000, mouseDx, mouseDy, frame);
    };

    it('keeps the view still while the cursor is inside the quarter-screen dead zone', () => {
      const cam = new Camera({ viewportWidth: 800, viewportHeight: 600 });
      // Dead zone radius = min(800, 600) / 4 = 150 px.
      settle(cam, 140, 0, 3000);
      expect(cam.lookX).toBe(0);
      expect(cam.lookY).toBe(0);
    });

    it('eases toward at most 100 world units of look-ahead past the dead zone', () => {
      const cam = new Camera({ viewportWidth: 800, viewportHeight: 600 });
      settle(cam, 700, 0, 5000);
      expect(cam.lookX).toBeGreaterThan(99);
      expect(cam.lookX).toBeLessThanOrEqual(100);
      expect(cam.lookY).toBe(0);
    });

    it('ramps look-ahead linearly over the second quarter of the screen', () => {
      const cam = new Camera({ viewportWidth: 800, viewportHeight: 600 });
      // 225 px is halfway between the dead zone (150) and full effect (300).
      settle(cam, 0, 225, 5000);
      expect(cam.lookY).toBeCloseTo(50, 0);
    });

    it('is not tied to zoom: the dead zone is measured in screen pixels', () => {
      const cam = new Camera({ viewportWidth: 800, viewportHeight: 600, zoom: 2 });
      settle(cam, 140, 0, 3000);
      expect(cam.lookX).toBe(0);
    });

    it('eases at the same rate at 60 and 144 fps', () => {
      const at = (frame: number) => {
        const cam = new Camera({ viewportWidth: 800, viewportHeight: 600 });
        settle(cam, 700, 0, 500, frame);
        return cam.lookX;
      };
      expect(Math.abs(at(1000 / 60) - at(1000 / 144))).toBeLessThan(1);
    });
  });

  it('hit shake: +-3 world units for 3 frames, as the old Render.shake = 3', () => {
    const cam = new Camera();
    cam.hitShake();
    expect(cam.hitFrames).toBe(3);

    let maxOffset = 0;
    for (let i = 0; i < 3; i++) {
      cam.update(0, 0, 0, 0, 1000 / 60);
      maxOffset = Math.max(maxOffset, Math.abs(cam.shakeOffsetX), Math.abs(cam.shakeOffsetY));
      expect(Math.abs(cam.shakeOffsetX)).toBeLessThanOrEqual(3);
      expect(Math.abs(cam.shakeOffsetY)).toBeLessThanOrEqual(3);
    }
    expect(maxOffset).toBeGreaterThan(0.2);
    expect(cam.hitFrames).toBeCloseTo(0, 5);

    cam.update(0, 0, 0, 0, 1000 / 60);
    expect(cam.shakeOffsetX).toBe(0);
    expect(cam.shakeOffsetY).toBe(0);
  });

  it('shakes at most once a second: damage ticking every 100 ms (a spike trap) is one jolt a second', () => {
    const cam = new Camera();
    let jolts = 0;
    // Two seconds on a spike: a hit every 100 ms, frames at 60 Hz in between.
    for (let t = 0; t < 2000; t += 1000 / 60) {
      if (Math.floor(t / 100) !== Math.floor((t - 1000 / 60) / 100)) {
        const before = cam.hitFrames;
        cam.hitShake();
        if (cam.hitFrames > before) jolts++;
      }
      cam.update(0, 0, 0, 0, 1000 / 60);
    }
    expect(jolts).toBe(2);
    // Hits landing together never stack: still the one 3-frame jolt.
    const fresh = new Camera();
    for (let i = 0; i < 6; i++) fresh.hitShake();
    expect(fresh.hitFrames).toBe(3);
  });

  it('explosion shake: +-9 world units a frame for N frames (old Render.explosionShake)', () => {
    const cam = new Camera();
    cam.explosionShake(20);
    expect(cam.explosionFrames).toBe(20);

    let maxOffset = 0;
    for (let i = 0; i < 10; i++) {
      cam.update(0, 0, 0, 0, 1000 / 60);
      expect(cam.explosionFrames).toBeGreaterThan(0);
      maxOffset = Math.max(maxOffset, Math.abs(cam.shakeOffsetX), Math.abs(cam.shakeOffsetY));
      expect(Math.abs(cam.shakeOffsetX)).toBeLessThanOrEqual(9);
      expect(Math.abs(cam.shakeOffsetY)).toBeLessThanOrEqual(9);
    }
    expect(maxOffset).toBeGreaterThan(1);
    expect(cam.explosionFrames).toBeCloseTo(10, 5);

    // Frame-rate independent: a 30 Hz frame counts for two.
    cam.update(0, 0, 0, 0, 1000 / 30);
    expect(cam.explosionFrames).toBeCloseTo(8, 5);

    cam.update(0, 0, 0, 0, 1000);
    expect(cam.explosionFrames).toBe(0);
    expect(cam.shakeOffsetX).toBe(0);
    expect(cam.shakeOffsetY).toBe(0);
  });

  it('a second explosion restarts the shake rather than stacking it', () => {
    const cam = new Camera();
    cam.explosionShake(10);
    cam.update(0, 0, 0, 0, 1000 / 60);
    cam.explosionShake(20);
    expect(cam.explosionFrames).toBe(20);
  });
});

describe('Camera scope look-ahead', () => {
  it('slides to a scope`s bigger look-ahead quickly, and back after', () => {
    const cam = new Camera({ viewportWidth: 1280, viewportHeight: 880 });
    // Cursor at the right edge: past the ramp, so the whole look-ahead applies.
    for (let i = 0; i < 12; i++) cam.update(0, 0, 640, 0, 16.67, 450);
    expect(cam.lookX).toBeGreaterThan(400);
    for (let i = 0; i < 20; i++) cam.update(0, 0, 640, 0, 16.67);
    expect(cam.lookX).toBeLessThan(110);
  });

  it('keeps the ordinary look-ahead`s slow drift', () => {
    const cam = new Camera({ viewportWidth: 1280, viewportHeight: 880 });
    for (let i = 0; i < 12; i++) cam.update(0, 0, 640, 0, 16.67);
    expect(cam.lookX).toBeLessThan(50);
  });
});

describe('strong scope offset', () => {
  // E, SE, S, SW, W, NW, N, NE as [degrees, x sign, y sign]; y grows downward.
  const directions = [
    [0, 1, 0],
    [45, 1, 1],
    [90, 0, 1],
    [135, -1, 1],
    [180, -1, 0],
    [225, -1, -1],
    [270, 0, -1],
    [315, 1, -1],
  ] as const;
  const screens = [
    { name: 'the 1280 x 880 base view', w: 1280, h: 880 },
    { name: 'a 16:9 window', w: 1920, h: 1080 },
    { name: 'a tall window', w: 880, h: 1280 },
  ];
  for (const s of screens) {
    it(`reaches ${SCOPE_OFFSET} of the way to the edge in eight directions on ${s.name}`, () => {
      const halfW = s.w / 2;
      const halfH = s.h / 2;
      for (const [deg, sx, sy] of directions) {
        const o = scopeOffset((deg * Math.PI) / 180, s.w, s.h, 1);
        // Along an axis the edge is that axis's half size away; on a diagonal
        // both components stop at the nearer half size.
        const diagonal = Math.min(halfW, halfH);
        const ex = sx * SCOPE_OFFSET * (sy === 0 ? halfW : diagonal);
        const ey = sy * SCOPE_OFFSET * (sx === 0 ? halfH : diagonal);
        expect(o.x, `${deg} degrees, x`).toBeCloseTo(ex, 6);
        expect(o.y, `${deg} degrees, y`).toBeCloseTo(ey, 6);
      }
    });
  }

  it('is in world units: half the zoom, twice the offset', () => {
    expect(scopeOffset(0, 1280, 880, 0.5).x).toBeCloseTo(2 * scopeOffset(0, 1280, 880, 1).x, 6);
  });

  it('keeps the player on screen at every aim', () => {
    const cam = new Camera({ viewportWidth: 1920, viewportHeight: 1080, zoom: 0.8 });
    for (let deg = 0; deg < 360; deg += 10) {
      const o = scopeOffset((deg * Math.PI) / 180, 1920, 1080, 0.8);
      cam.lookX = o.x;
      cam.lookY = o.y;
      const p = cam.worldToScreen(cam.x, cam.y);
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(1920);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(1080);
    }
  });

  it('moves the view to the scope target quickly while scoped, and back after', () => {
    const cam = new Camera({ viewportWidth: 1280, viewportHeight: 880 });
    for (let i = 0; i < 40; i++) cam.update(0, 0, 0, 0, 16.67, LOOK_MAX, { x: 544, y: 0, blend: 1 });
    expect(cam.lookX).toBeCloseTo(544, 0);
    for (let i = 0; i < 12; i++) cam.update(0, 0, 0, 0, 16.67);
    expect(cam.lookX).toBeLessThan(LOOK_MAX + 1);
  });

  it('goes part way while the scope blends in', () => {
    const cam = new Camera({ viewportWidth: 1280, viewportHeight: 880 });
    for (let i = 0; i < 40; i++) cam.update(0, 0, 0, 0, 16.67, LOOK_MAX, { x: 544, y: 0, blend: 0.5 });
    expect(cam.lookX).toBeCloseTo(272, 0);
  });
});

// The server's weak-view reach rule (aim_view::weakReachProblem) mirrors the
// client's screen: aim_view::CLIENT_VIEW_WIDTH / CLIENT_VIEW_HEIGHT in
// apps/server/src/gameplay/aim_view.h must equal these. Change both together.
describe('base view size', () => {
  it('matches the constants the server reach rule mirrors', () => {
    expect(BASE_VIEW_WIDTH).toBe(1280);
    expect(BASE_VIEW_HEIGHT).toBe(880);
  });
  it('matches the scope offset the server`s off-screen note mirrors', () => {
    // aim_view::CLIENT_SCOPE_OFFSET in apps/server/src/gameplay/aim_view.h.
    expect(SCOPE_OFFSET).toBe(0.85);
  });
});
