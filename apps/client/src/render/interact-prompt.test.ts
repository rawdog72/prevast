// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import type { AssetLoader } from '../assets/asset-loader';
import { Camera } from '../core/camera';
import { EntityType, type WorldEntity } from '../world/entity-types';
import type { InteractTarget } from '../game/input-manager';
import { InteractPrompt } from './interact-prompt';

interface Drawn {
  sprite: string;
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
  rotation: number;
}

function recordingContext() {
  const drawn: Drawn[] = [];
  const stack: { x: number; y: number; r: number }[] = [];
  let x = 0;
  let y = 0;
  let r = 0;
  let alpha = 1;
  const ctx = {
    save: () => stack.push({ x, y, r }),
    restore: () => {
      const s = stack.pop();
      if (s) ({ x, y, r } = s);
    },
    translate: (dx: number, dy: number) => {
      x += dx;
      y += dy;
    },
    rotate: (a: number) => {
      r += a;
    },
    drawImage: (img: { name: string }, dx: number, dy: number, w: number, h: number) =>
      drawn.push({ sprite: img.name, x: x + dx, y: y + dy, w, h, alpha, rotation: r }),
    set globalAlpha(v: number) {
      alpha = v;
    },
    get globalAlpha() {
      return alpha;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
}

// Badge art is 220x132 (2x HiDPI -> 110x66 on screen at zoom 1).
const assets = {
  get: (name: string) => ({
    name,
    naturalWidth: name.startsWith('day-') ? 60 : 220,
    naturalHeight: name.startsWith('day-') ? 60 : 132,
    image: { name },
  }),
  warm: () => {},
} as unknown as AssetLoader;

function entity(x: number, y: number): WorldEntity {
  return { pid: 1, id: 0, type: EntityType.PLAYER, x, y } as WorldEntity;
}

function target(kind: 'loot' | 'object', icon: string, sprite?: string): InteractTarget {
  return {
    kind,
    icon,
    entity: entity(0, 0),
    distance: 10,
    loot: sprite
      ? { itemKey: 'wood', item: {} as never, sprite, scale: 0.8, angle: 0.3, amount: 1 }
      : undefined,
  };
}

describe('InteractPrompt', () => {
  const camera = new Camera({ viewportWidth: 1280, viewportHeight: 880 });
  camera.update(500, 500);
  const local = entity(500, 500);

  it('floats the loot badge above the player with the item drawn in its box', () => {
    const prompt = new InteractPrompt();
    const { ctx, drawn } = recordingContext();
    prompt.render(ctx, camera, assets, local, target('loot', 'loot', 'day-wood1'), null);

    const [badge, item] = drawn;
    expect(badge!.sprite).toBe('loot');
    expect(badge!.w).toBe(110);
    expect(badge!.x).toBeCloseTo(640 - 55); // centred on the player
    expect(badge!.y).toBeCloseTo(440 - 33 - 65 - 60); // 65 world units + 60 px above the head
    expect(item!.sprite).toBe('day-wood1');
    expect(item!.x + item!.w / 2).toBeCloseTo(badge!.x + 77); // box centre, old client offsets
    expect(item!.y + item!.h / 2).toBeCloseTo(badge!.y + 33);
    expect(item!.rotation).toBeCloseTo(0.3);
    expect(item!.w).toBeCloseTo(30 * 0.8);
  });

  it('shows the building icon on E and a second F badge for loot beside it', () => {
    const prompt = new InteractPrompt();
    const { ctx, drawn } = recordingContext();
    prompt.render(
      ctx,
      camera,
      assets,
      local,
      target('object', 'e-chest'),
      target('loot', 'loot2', 'day-wood1'),
    );

    expect(drawn.map((d) => d.sprite)).toEqual(['e-chest', 'loot2', 'day-wood1']);
    const [e, f] = drawn;
    expect(e!.x + e!.w).toBeCloseTo(640 - 5); // E badge sits just left of centre
    expect(f!.x).toBeCloseTo(e!.x + e!.w + 10); // F badge 10 px to its right
  });

  it('floats the rotate hint over the head at the given opacity when nothing else is up there', () => {
    const prompt = new InteractPrompt();
    const { ctx, drawn } = recordingContext();
    prompt.render(ctx, camera, assets, local, null, null, 0.5);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.sprite).toBe('hint-rotate');
    expect(drawn[0]!.alpha).toBeCloseTo(0.5);
    expect(drawn[0]!.x).toBeCloseTo(640 - 55);
    expect(drawn[0]!.y).toBeCloseTo(440 - 33 - 65 - 60);
    // Transparent: nothing drawn. A badge in reach wins the spot.
    drawn.length = 0;
    prompt.render(ctx, camera, assets, local, null, null, 0);
    expect(drawn).toHaveLength(0);
    prompt.render(ctx, camera, assets, local, target('loot', 'loot'), null, 1);
    expect(drawn.map((d) => d.sprite)).toEqual(['loot']);
  });

  it('keeps the badge on screen when the player is near the top edge', () => {
    const prompt = new InteractPrompt();
    const { ctx, drawn } = recordingContext();
    const cam = new Camera({ viewportWidth: 1280, viewportHeight: 880 });
    cam.update(500, 500);
    prompt.render(ctx, cam, assets, entity(500, 120), target('loot', 'loot'), null);
    expect(drawn[0]!.y).toBe(10);
  });

  it('keeps the badge and the timer a fixed screen size whatever the zoom, anchored above the head', () => {
    // Zooming scales the world (so the head moves up the screen) but not the
    // HUD-like badge; only the 65 world units to the head follow the zoom.
    const prompt = new InteractPrompt();
    const { ctx, drawn } = recordingContext();
    const cam = new Camera({ viewportWidth: 1280, viewportHeight: 880, zoom: 2 });
    cam.update(500, 500);
    prompt.render(ctx, cam, assets, local, target('loot', 'loot', 'day-wood1'), null);
    expect(drawn[0]!.w).toBe(110);
    expect(drawn[0]!.y).toBeCloseTo(440 - 33 - 65 * 2 - 60);
    expect(drawn[1]!.w).toBeCloseTo(30 * 0.8); // the item in the box does not grow either

    prompt.startTimer(10);
    const again = recordingContext();
    prompt.render(again.ctx, cam, assets, local, null, null);
    expect(again.drawn[0]!.w).toBe(110);
    expect(again.drawn[0]!.y).toBeCloseTo(440 - 33 - 65 * 2 - 60);
  });

  it('scales the badge with the window like the rest of the HUD (old client scaleby)', () => {
    const prompt = new InteractPrompt();
    const { ctx, drawn } = recordingContext();
    const cam = new Camera({ viewportWidth: 2560, viewportHeight: 1760, zoom: 2 });
    cam.update(500, 500);
    prompt.render(ctx, cam, assets, local, target('loot', 'loot'), null);
    expect(drawn[0]!.w).toBe(220);
  });

  it('draws the use timer dial while an interaction is in progress, arrow turning with progress', () => {
    const prompt = new InteractPrompt();
    prompt.startTimer(10); // delayMultiplier 10 -> 1000 ms
    prompt.update(250);
    const { ctx, drawn } = recordingContext();
    prompt.render(ctx, camera, assets, local, null, null);

    expect(drawn.map((d) => d.sprite)).toEqual(['timer', 'timer-arrow', 'timer-lights']);
    expect(drawn[1]!.rotation).toBeCloseTo(-Math.PI * 2 * 0.75);
    prompt.update(1000);
    const again = recordingContext();
    prompt.render(again.ctx, camera, assets, local, null, null);
    expect(again.drawn).toHaveLength(0);
  });

  it('interrupt() drops the timer', () => {
    const prompt = new InteractPrompt();
    prompt.startTimer(10);
    prompt.interrupt();
    const { ctx, drawn } = recordingContext();
    prompt.render(ctx, camera, assets, local, null, null);
    expect(drawn).toHaveLength(0);
  });

  it('flashes the wrong-tool badge with the required tool at the top of the screen for 2s', () => {
    const prompt = new InteractPrompt();
    prompt.wrongTool('day-stone-pickaxe');
    prompt.update(1000);
    const { ctx, drawn } = recordingContext();
    prompt.render(ctx, camera, assets, local, null, null);
    expect(drawn.map((d) => d.sprite)).toEqual(['wrong-tool', 'day-stone-pickaxe']);
    expect(drawn[0]!.x + drawn[0]!.w / 2).toBeCloseTo(640);
    expect(drawn[0]!.y + drawn[0]!.h / 2).toBeCloseTo(50);
    expect(drawn[0]!.alpha).toBe(1);
    prompt.update(1500);
    const again = recordingContext();
    prompt.render(again.ctx, camera, assets, local, null, null);
    expect(again.drawn).toHaveLength(0);
  });
});
