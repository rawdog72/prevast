// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { Camera } from '../../core/camera';
import { ParticleSystem } from './particle-system';

function createMockContext(): CanvasRenderingContext2D {
  let saves = 0;
  let restores = 0;
  return {
    save: () => saves++,
    restore: () => restores++,
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    fillRect: () => {},
    globalAlpha: 1,
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D;
}

describe('ParticleSystem', () => {
  it('spawns particles of different types and tracks active count', () => {
    const ps = new ParticleSystem(100);
    expect(ps.getActiveCount()).toBe(0);

    ps.spawnWoodDebris(100, 100, 5);
    expect(ps.getActiveCount()).toBe(5);

    ps.spawnStoneDebris(200, 200, 5);
    expect(ps.getActiveCount()).toBe(10);

    ps.spawnMetalSparks(300, 300, 8);
    expect(ps.getActiveCount()).toBe(18);

    ps.spawnBlood(400, 400, 4);
    expect(ps.getActiveCount()).toBe(22);

    ps.spawnExplosion(500, 500, 15);
    expect(ps.getActiveCount()).toBe(37);
  });

  it('updates particle physics and cleans up expired particles', () => {
    const ps = new ParticleSystem(50);
    ps.spawnMetalSparks(100, 100, 10);
    expect(ps.getActiveCount()).toBe(10);

    // Advance by 100ms
    ps.update(100);
    expect(ps.getActiveCount()).toBe(10);

    // Advance by 2 seconds (sparks maxLife is 0.5s)
    ps.update(2000);
    expect(ps.getActiveCount()).toBe(0);
  });

  it('renders active particles with balanced transforms', () => {
    const ps = new ParticleSystem(50);
    ps.spawnWoodDebris(400, 300, 5);

    const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });
    camera.x = 400;
    camera.y = 300;

    const ctx = createMockContext();
    expect(() => ps.render(ctx, camera)).not.toThrow();
  });
});
