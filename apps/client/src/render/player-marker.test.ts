// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import type { AssetLoader } from '../assets/asset-loader';
import { ContentStore } from '../content/store';
import { EntityType } from '../world/entity-types';
import { newPlayerInfo, WorldState } from '../world/world-state';
import { drawHeadMarker, ownHeadLook } from './player-marker';

function world(extra: number, repellentMs = 0): WorldState {
  const w = new WorldState();
  w.ownGuid = 1;
  const me = newPlayerInfo(1, 'Me');
  me.repellentMs = repellentMs;
  w.players.set(1, me);
  w.entities.processUnits([
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
      extra,
    },
  ]);
  return w;
}

function content(): ContentStore {
  const store = new ContentStore();
  store.load({
    name: 'wearables',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      camouflage_gear: {
        key: 'camouflage_gear',
        id: 16,
        skinId: 16,
        client: { head: 'day-camouflage-gear', leftArm: 'x', rightArm: 'y' },
      },
    },
  });
  return store;
}

describe('ownHeadLook (the sprites the character renderer stacks for our head)', () => {
  it('is the clean base skin with nothing on', () => {
    expect(ownHeadLook(world(0), content())).toEqual({ head: 'day-skin0' });
  });

  it('adds the wearable head over the base skin, which follows the drug state', () => {
    expect(ownHeadLook(world(16, 5000), content())).toEqual({
      head: 'day-skin1',
      cosmeticHead: 'day-camouflage-gear',
    });
  });

  it('is null before we have an entity', () => {
    const w = new WorldState();
    w.ownGuid = 1;
    expect(ownHeadLook(w, content())).toBeNull();
  });
});

describe('drawHeadMarker', () => {
  function recorder() {
    const calls: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, prop: string) => {
        if (prop in target) return target[prop];
        return (...args: unknown[]) => {
          const fmt = (a: unknown) =>
            typeof a === 'string'
              ? a
              : typeof a === 'number'
                ? String(Math.round(a * 100) / 100)
                : ((a as { name?: string })?.name ?? '_');
          calls.push(`${prop}(${args.map(fmt).join(',')})`);
        };
      },
      set: (target, prop: string, value) => {
        target[prop] = value;
        return true;
      },
    });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
  }
  const sizes: Record<string, [number, number]> = {
    'day-skin0': [178, 178],
    'day-camouflage-gear': [218, 246],
  };
  const assets = {
    get: (name: string) =>
      sizes[name]
        ? { naturalWidth: sizes[name][0], naturalHeight: sizes[name][1], image: { name } }
        : undefined,
  } as unknown as AssetLoader;

  it('draws the head `size` px across, centred and turned to the aim, the wearable on top at the same scale', () => {
    const { ctx, calls } = recorder();
    const ok = drawHeadMarker(
      ctx,
      assets,
      { head: 'day-skin0', cosmeticHead: 'day-camouflage-gear' },
      40,
      50,
      Math.PI / 2,
      16,
    );
    expect(ok).toBe(true);
    expect(calls).toEqual([
      'save()',
      'translate(40,50)',
      'rotate(1.57)',
      'drawImage(day-skin0,-8,-8,16,16)',
      // 218 x 246 at 16/178 per px: 19.6 x 22.11, centred like the head.
      'drawImage(day-camouflage-gear,-9.8,-11.06,19.6,22.11)',
      'restore()',
    ]);
  });

  it('draws nothing and says so while the head sprite is not decoded yet', () => {
    const { ctx, calls } = recorder();
    expect(drawHeadMarker(ctx, assets, { head: 'day-skin3' }, 0, 0, 0, 16)).toBe(false);
    expect(calls).toEqual([]);
  });
});
