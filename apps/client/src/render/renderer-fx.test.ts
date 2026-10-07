// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { AssetLoader } from '../assets/asset-loader';
import { ContentStore } from '../content/store';
import { Camera } from '../core/camera';
import { EntityType } from '../world/entity-types';
import { WorldState } from '../world/world-state';
import { BRZone } from '../game/modes/br-zone';
import { GhoulEffects } from '../game/modes/ghoul-effects';
import { ParticleSystem } from './particles/particle-system';
import { GameRenderer } from './renderer';

function createMockContext(): CanvasRenderingContext2D {
  let saves = 0;
  let restores = 0;
  return {
    save: () => saves++,
    restore: () => restores++,
    fillRect: () => {},
    strokeRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    rect: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    moveTo: () => {},
    lineTo: () => {},
    rotate: () => {},
    translate: () => {},
    scale: () => {},
    setLineDash: () => {},
    createRadialGradient: () =>
      ({
        addColorStop: () => {},
      }) as unknown as CanvasGradient,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  } as unknown as CanvasRenderingContext2D;
}

describe('Renderer FX Integration', () => {
  it('renders all FX layers: particles, BR zone, and ghoul effects', () => {
    const renderer = new GameRenderer();
    const ctx = createMockContext();
    const camera = new Camera({ viewportWidth: 1024, viewportHeight: 768 });
    const world = new WorldState();
    const content = new ContentStore();
    const assets = new AssetLoader();

    // Enable night to test illumination
    world.clock.isNight = true;
    world.ownGuid = 1;

    // Spawn local player and other player
    world.entities.processUnits([
      {
        pid: 1,
        id: 0,
        type: EntityType.PLAYER,
        rotation: 0,
        state: 1,
        startX: 500,
        startY: 500,
        endX: 500,
        endY: 500,
        extra: 0,
      },
      {
        pid: 2,
        id: 0,
        type: EntityType.PLAYER,
        rotation: 0,
        state: 1,
        startX: 600,
        startY: 600,
        endX: 600,
        endY: 600,
        extra: 0,
      },
    ]);

    // Setup FX systems
    const particles = new ParticleSystem();
    particles.spawnWoodDebris(500, 500, 10);
    particles.spawnBlood(500, 500, 8);
    particles.spawnFootprint(500, 500, 0);

    const brZone = new BRZone({ centerX: 500, centerY: 500, currentRadius: 800 });
    brZone.setTarget(400, 2000);
    brZone.update(100);

    const ghoulEffects = new GhoulEffects({ isGhoul: true, level: 2 });
    ghoulEffects.update(100);

    // Full render pass
    expect(() => {
      renderer.render({
        ctx,
        camera,
        world,
        content,
        assets,
        particles,
        brZone,
        ghoulEffects,
        timeMs: 1500,
      });
    }).not.toThrow();
  });

  it('renders gracefully when FX systems are omitted (backward compatible)', () => {
    const renderer = new GameRenderer();
    const ctx = createMockContext();
    const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });
    const world = new WorldState();
    const content = new ContentStore();
    const assets = new AssetLoader();

    expect(() => {
      renderer.render({
        ctx,
        camera,
        world,
        content,
        assets,
      });
    }).not.toThrow();
  });
});
