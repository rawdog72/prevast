// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { Camera } from '../../core/camera';
import { BRZone } from './br-zone';
import { GhoulEffects } from './ghoul-effects';

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
    setLineDash: () => {},
    createRadialGradient: () =>
      ({
        addColorStop: () => {},
      }) as unknown as CanvasGradient,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalCompositeOperation: 'source-over',
  } as unknown as CanvasRenderingContext2D;
}

describe('Game Modes', () => {
  describe('BRZone', () => {
    it('initializes with default config and tracks safe zone boundary', () => {
      const zone = new BRZone({ centerX: 1000, centerY: 1000, currentRadius: 500 });
      expect(zone.centerX).toBe(1000);
      expect(zone.centerY).toBe(1000);
      expect(zone.currentRadius).toBe(500);
      expect(zone.isInside(1000, 1000)).toBe(true);
      expect(zone.isInside(1400, 1000)).toBe(true);
      expect(zone.isInside(1600, 1000)).toBe(false);
      expect(zone.distanceFromZone(1600, 1000)).toBe(100);
    });

    it('interpolates radius when shrinking over time', () => {
      const zone = new BRZone({ centerX: 0, centerY: 0, currentRadius: 1000 });
      zone.setTarget(500, 1000); // shrink to 500 over 1000ms
      expect(zone.getIsShrinking()).toBe(true);

      // Advance 500ms
      zone.update(500);
      expect(zone.currentRadius).toBeLessThan(1000);
      expect(zone.currentRadius).toBeGreaterThan(500);
      expect(zone.getShrinkProgress()).toBeCloseTo(0.5, 1);

      // Advance to end
      zone.update(500);
      expect(zone.currentRadius).toBe(500);
      expect(zone.getIsShrinking()).toBe(false);
      expect(zone.getShrinkProgress()).toBe(1);
    });

    it('stays inactive (renders nothing) until the server actually configures a zone', () => {
      // Nothing currently calls setTarget/setCenter from the network, so a
      // default-constructed zone must not paint its placeholder circle over
      // every non-BR map -- that circle is not a real storm boundary.
      const zone = new BRZone();
      expect(zone.isActive()).toBe(false);

      const ctx = createMockContext();
      let arcCalls = 0;
      (ctx as unknown as { arc: () => void }).arc = () => {
        arcCalls++;
      };
      const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });

      zone.renderWorld(ctx, camera, 15000, 15000);
      zone.renderMinimap(ctx, 10, 10, 150, 150, 15000, 15000);
      expect(arcCalls).toBe(0);

      zone.setCenter(3000, 3000);
      expect(zone.isActive()).toBe(true);
      zone.renderWorld(ctx, camera, 15000, 15000);
      expect(arcCalls).toBeGreaterThan(0);
    });

    it('renders world danger overlay and minimap marker without error', () => {
      const zone = new BRZone({ centerX: 500, centerY: 500, currentRadius: 300 });
      const ctx = createMockContext();
      const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });

      expect(() => {
        zone.renderWorld(ctx, camera, 2000, 2000);
        zone.renderMinimap(ctx, 10, 10, 150, 150, 2000, 2000);
      }).not.toThrow();
    });
  });

  describe('GhoulEffects', () => {
    it('manages ghoul state, infection, and darkness vision bonus', () => {
      const effects = new GhoulEffects();
      expect(effects.isGhoul).toBe(false);
      expect(effects.getVisionRadiusMultiplier()).toBe(1.0);

      effects.setGhoul(true, 2);
      expect(effects.isGhoul).toBe(true);
      expect(effects.getVisionRadiusMultiplier()).toBeCloseTo(1.7, 5);

      effects.setInfection(0.5);
      expect(effects.infection).toBe(0.5);
    });

    it('updates pulse phase and renders screen effects & scent trails', () => {
      const effects = new GhoulEffects({ isGhoul: true });
      effects.update(100);

      const ctx = createMockContext();
      expect(() => {
        effects.renderScreenEffects(ctx, 800, 600);
        effects.renderScentTrail(ctx, 100, 100, 200, 200);
      }).not.toThrow();
    });

    it('renders infection overlay when infected but not yet full ghoul', () => {
      const effects = new GhoulEffects({ isGhoul: false, infection: 0.8 });
      const ctx = createMockContext();
      expect(() => {
        effects.renderScreenEffects(ctx, 800, 600);
      }).not.toThrow();
    });
  });
});
