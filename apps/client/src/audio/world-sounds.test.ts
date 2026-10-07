// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import type { ContentTable } from '../../../../shared/typescript/content-format';
import { ContentStore } from '../content/store';
import { CharacterAnimator } from '../render/character-animator';
import { EntityType } from '../world/entity-types';
import { WorldState } from '../world/world-state';
import { WorldSounds, type WorldSoundSink } from './world-sounds';

interface Played {
  file: string;
  x: number;
  y: number;
  reach: number;
  volume: number;
  delaySec: number;
}

function sink(): WorldSoundSink & { played: Played[] } {
  const played: Played[] = [];
  return {
    played,
    playFileAt(file, x, y, _lx, _ly, reach, volume, delaySec = 0) {
      played.push({ file, x, y, reach, volume, delaySec });
    },
  };
}

function table(name: string, entries: Record<string, unknown>): ContentTable {
  return { name, version: 1, hash: 'x', attributes: {}, entries } as unknown as ContentTable;
}

function content(): ContentStore {
  const store = new ContentStore();
  store.load(
    table('equipables', {
      hand: {
        key: 'hand',
        id: 0,
        idWeapon: 0,
        typeId: 0,
        client: {
          render: 'hand',
          breath: 0.05,
          move: 3,
          soundVolume: 0.5,
          soundDelay: 0,
          sound: [{ file: 'hand-swing0' }, { file: 'hand-swing2' }, { file: 'hand-swing3' }],
        },
      },
      bow: {
        key: 'wood_bow',
        id: 6,
        idWeapon: 6,
        typeId: 4,
        client: {
          render: 'bow',
          breath: 0.5,
          move: 1,
          soundVolume: 1.4,
          soundDelay: 1.08,
          sound: [{ file: 'bow-shot' }],
        },
      },
      ak47: {
        key: 'ak47',
        id: 10,
        idWeapon: 10,
        typeId: 3,
        client: {
          render: 'gun',
          breath: 1,
          move: 2,
          soundVolume: 1,
          soundDelay: 0,
          sound: [{ file: 'ak47-shot' }],
        },
      },
      steak: {
        key: 'raw_steak',
        id: 12,
        idWeapon: 12,
        typeId: 5,
        client: {
          render: 'consumable',
          breath: 0.02,
          move: 2,
          soundVolume: 1,
          soundDelay: 0,
          sound: [{ file: 'eat-1s-0' }],
        },
      },
    }),
  );
  const resource = (key: string, id: number, impactSound: string, destroySound: string) => ({
    key,
    id,
    types: { type: [{ id: 0, life: 100, radius: 30, layer: 'top', collision: true }] },
    client: { render: 'resource', impactSound, destroySound, type: [{ id: 0, sprite: key }] },
  });
  store.load(
    table('resources', {
      tree: resource('tree', 1, 'wood_impact', 'wood_destroy'),
      stone: resource('stone', 2, 'stone_impact_2', 'stone_destroy'),
    }),
  );
  store.load(table('items', { wall: { key: 'wall', id: 40, clientItemId: 40, name: 'Wall' } }));
  store.load(
    table('objects', {
      wall: {
        key: 'wall',
        category: 'wall',
        healthMax: 100,
        layer: 'top',
        client: { render: 'wall', impactSound: 'steel_impact', destroySound: 'steel_destroy' },
      },
    }),
  );
  return store;
}

const ALIVE = 1;
const ATTACK = 2;
const CONSUME = 4;

function unit(
  type: number,
  state: number,
  opts: { pid?: number; id?: number; x?: number; y?: number; extra?: number } = {},
) {
  const x = opts.x ?? 0;
  const y = opts.y ?? 0;
  return {
    pid: opts.pid ?? 0,
    id: opts.id ?? 0,
    type,
    rotation: 0,
    state,
    startX: x,
    startY: y,
    endX: x,
    endY: y,
    extra: opts.extra ?? 0,
  };
}

function setup() {
  const world = new WorldState();
  const store = content();
  const out = sink();
  const animator = new CharacterAnimator();
  const sounds = new WorldSounds(out, animator);
  const frame = (now: number) => sounds.update(world, store, 0, 0, now);
  return { world, store, out, animator, sounds, frame };
}

describe('WorldSounds', () => {
  it('plays the held gun shot on a player attack pulse, heard up to 1200 units away', () => {
    const { world, out, frame } = setup();
    world.entities.processUnits([
      unit(EntityType.PLAYER, ALIVE | ATTACK, { pid: 3, x: 600, extra: 10 << 8 }),
    ]);
    frame(0);
    expect(out.played).toEqual([
      { file: 'ak47-shot.mp3', x: 600, y: 0, reach: 1200, volume: 1, delaySec: 0 },
    ]);
  });

  it('carries the weapon volume and delay (a bow twangs 1.08 s after the draw)', () => {
    const { world, out, frame } = setup();
    world.entities.processUnits([
      unit(EntityType.PLAYER, ALIVE | ATTACK, { pid: 3, extra: 6 << 8 }),
    ]);
    frame(0);
    expect(out.played[0]).toMatchObject({ file: 'bow-shot.mp3', volume: 1.4, delaySec: 1.08 });
  });

  it('picks one of the weapon sounds at random (bare hands have three swings)', () => {
    const { world, out, frame } = setup();
    world.entities.processUnits([unit(EntityType.PLAYER, ALIVE | ATTACK, { pid: 3 })]);
    frame(0);
    expect(['hand-swing0.mp3', 'hand-swing2.mp3', 'hand-swing3.mp3']).toContain(out.played[0].file);
    expect(out.played[0].volume).toBe(0.5);
  });

  it('plays nothing without a pulse', () => {
    const { world, out, frame } = setup();
    world.entities.processUnits([unit(EntityType.PLAYER, ALIVE, { pid: 3, extra: 10 << 8 })]);
    frame(0);
    expect(out.played).toEqual([]);
  });

  it('plays the eat sound when a player starts consuming, at most every 800 ms', () => {
    const { world, out, frame } = setup();
    const eating = unit(EntityType.PLAYER, ALIVE | CONSUME, { pid: 3, extra: 12 << 8 });
    const idle = unit(EntityType.PLAYER, ALIVE, { pid: 3, extra: 12 << 8 });
    world.entities.processUnits([eating]);
    frame(0);
    frame(100); // still consuming: no repeat
    expect(out.played.map((p) => p.file)).toEqual(['eat-1s-0.mp3']);

    world.entities.processUnits([idle]);
    frame(200);
    world.entities.processUnits([eating]);
    frame(300); // started again, but inside 800 ms
    expect(out.played).toHaveLength(1);

    world.entities.processUnits([idle]);
    frame(900);
    world.entities.processUnits([eating]);
    frame(1000);
    expect(out.played).toHaveLength(2);
  });

  it('gives an agent attack the bare-hand swing at half volume, once per swing', () => {
    const { world, store, out, animator, frame } = setup();
    world.entities.processUnits([unit(EntityType.AI, ALIVE | ATTACK, { id: 7, x: 100 })]);
    frame(0);
    animator.update(world, store, 16);
    // The server holds an agent's pulse for two ticks; the second is the same swing.
    world.entities.processUnits([unit(EntityType.AI, ALIVE | ATTACK, { id: 7, x: 100 })]);
    frame(50);
    expect(out.played).toHaveLength(1);
    expect(out.played[0]).toMatchObject({ reach: 1050, volume: 0.5 });
    expect(out.played[0].file).toMatch(/^hand-swing\d\.mp3$/);
  });

  it('plays a resource impact from its content sound name', () => {
    const { world, out, frame } = setup();
    world.entities.processUnits([
      unit(EntityType.RES_TOP, ALIVE | ATTACK, { id: 5, x: 300, extra: 1 << 5 }),
    ]);
    frame(0);
    expect(out.played).toEqual([
      { file: 'wood-impact.mp3', x: 300, y: 0, reach: 840, volume: 1, delaySec: 0 },
    ]);
  });

  it('maps the old stone sound ids onto their files (stone_impact_2 is stone-impact.mp3)', () => {
    const { world, out, frame } = setup();
    world.entities.processUnits([
      unit(EntityType.RES_DOWN, ALIVE | ATTACK, { id: 5, extra: 2 << 5 }),
    ]);
    frame(0);
    expect(out.played[0].file).toBe('stone-impact.mp3');
  });

  it('plays a building impact and its destroy sound once when it is removed', () => {
    const { world, out, frame } = setup();
    const wall = (state: number) =>
      unit(EntityType.BUILD_TOP, state, { pid: 2, id: 4, x: 200, extra: 40 << 7 });
    world.entities.processUnits([wall(ALIVE | ATTACK)]);
    frame(0);
    // state 0 with extra 1: destroyed (keep in cache to fade out).
    world.entities.processUnits([{ ...wall(0), extra: 1 }]);
    frame(16);
    frame(32);
    expect(out.played.map((p) => [p.file, p.reach])).toEqual([
      ['metal-impact2.mp3', 840],
      ['metal-destroy2.mp3', 750],
    ]);
  });

  it('stays quiet when a structure merely leaves view', () => {
    const { world, out, frame } = setup();
    world.entities.processUnits([unit(EntityType.RES_TOP, ALIVE, { id: 5, extra: 1 << 5 })]);
    frame(0);
    world.entities.processUnits([unit(EntityType.RES_TOP, 0, { id: 5, extra: 0 })]);
    frame(16);
    expect(out.played).toEqual([]);
  });

  it('plays each structure sound at most once per frame (old soundLimit)', () => {
    const { world, out, frame } = setup();
    world.entities.processUnits([
      unit(EntityType.RES_TOP, ALIVE | ATTACK, { id: 5, extra: 1 << 5 }),
      unit(EntityType.RES_TOP, ALIVE | ATTACK, { id: 6, extra: 1 << 5 }),
    ]);
    frame(0);
    expect(out.played).toHaveLength(1);
  });
});
