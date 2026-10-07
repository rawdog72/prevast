// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { NetEventBus } from '../net/events';
import { ClanStore } from '../world/clan-store';
import { EntityType, type WorldEntity } from '../world/entity-types';
import { WorldState } from '../world/world-state';
import {
  NAMEPLATE_OFFSET_Y,
  NAME_COLOR,
  Nameplates,
  nameplateFor,
  OTHER_CLAN_TAG_COLOR,
  OWN_CLAN_TAG_COLOR,
} from './nameplates';

// Roster: 1 = us (clan 1 "WOLF"), 2 = Bob (clan 1), 3 = Zed (no clan), 4 = alice (clan 0 "").
function setup() {
  const world = new WorldState();
  const bus = new NetEventBus();
  world.attachBus(bus);
  const clans = new ClanStore(world);
  clans.attachBus(bus);
  bus.emit('nicknames', { names: [null, 'Me', 'Bob', 'Zed', 'alice'], sessionToken: '' });
  bus.emit('teamNames', { names: ['', 'WOLF', 'FOX'] });
  const p = (guid: number, team: number) => ({
    guid,
    team,
    repellent: 0,
    withdrawal: 0,
    ghoul: 0,
    tokenId: 1000 + guid,
    score: 0,
  });
  bus.emit('handshake', {
    ownGuid: 1,
    unitsPerPlayer: 12,
    playerCount: 255,
    modeId: 0,
    players: [p(1, 1), p(2, 1), p(3, 50), p(4, 2)],
  });
  return { world, clans };
}

function player(pid: number, extra = 0): WorldEntity {
  return { pid, id: 0, type: EntityType.PLAYER, extra, removed: false } as WorldEntity;
}

describe('nameplateFor (old client _playerName rules)', () => {
  it('names every player in white, with the clan tag tinted by side', () => {
    const { world, clans } = setup();
    expect(nameplateFor(player(1), world, clans)).toEqual({
      name: 'Me',
      nameColor: NAME_COLOR,
      tag: '[WOLF]',
      tagColor: OWN_CLAN_TAG_COLOR,
    });
    expect(nameplateFor(player(2), world, clans)?.tagColor).toBe(OWN_CLAN_TAG_COLOR);
    expect(nameplateFor(player(4), world, clans)).toEqual({
      name: 'alice',
      nameColor: NAME_COLOR,
      tag: '[FOX]',
      tagColor: OTHER_CLAN_TAG_COLOR,
    });
    expect(nameplateFor(player(3), world, clans)).toEqual({ name: 'Zed', nameColor: NAME_COLOR });
  });

  it('draws nothing over a guest who joined without a name, and never a made-up one', () => {
    const { world, clans } = setup();
    // Guest 5 is in the handshake roster but PLAYER_NAMES had no name for them.
    world.players.set(5, { ...world.players.get(3)!, guid: 5, nickname: '' });
    expect(nameplateFor(player(5), world, clans)).toBeNull();
  });

  it('adds verified and staff badges', () => {
    const { world, clans } = setup();
    const info = world.players.get(1)!;
    info.verified = true;
    info.groupId = 4;
    world.groups.set(4, { id: 4, name: 'admin', badge: 'admin' });
    expect(nameplateFor(player(1), world, clans)?.badges?.map((b) => b.key)).toEqual([
      'verified',
      'admin',
    ]);
  });

  it('hides a camouflaged player (wearable 16) from everyone but themselves and their clan', () => {
    const { world, clans } = setup();
    expect(nameplateFor(player(4, 16), world, clans)).toBeNull(); // other clan
    expect(nameplateFor(player(3, 16), world, clans)).toBeNull(); // no clan
    expect(nameplateFor(player(2, 16), world, clans)?.name).toBe('Bob'); // clan mate
    expect(nameplateFor(player(1, 16), world, clans)?.name).toBe('Me'); // us
  });

  it('draws nothing for creatures, corpses, or a player with no clan store', () => {
    const { world, clans } = setup();
    expect(nameplateFor({ ...player(2), type: EntityType.AI }, world, clans)).toBeNull();
    expect(nameplateFor({ ...player(2), removed: true }, world, clans)).toBeNull();
    expect(nameplateFor(player(2), world)).toEqual({ name: 'Bob', nameColor: NAME_COLOR });
  });
});

/** A canvas whose 2D context measures 20 px per character and records nothing. */
function fakeCanvas(): HTMLCanvasElement {
  const canvas = { width: 0, height: 0 } as HTMLCanvasElement;
  const ctx = {
    measureText: (t: string) => ({ width: t.length * 20 }),
    strokeText: () => {},
    fillText: () => {},
  };
  canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
  return canvas;
}

describe('Nameplates.draw', () => {
  it('draws the cached label at half its raster size, top edge 90 units above the player', () => {
    const plates = new Nameplates(fakeCanvas);
    const draws: { w: number; h: number; x: number; y: number }[] = [];
    const ctx = {
      drawImage: (_c: unknown, x: number, y: number, w: number, h: number) =>
        draws.push({ x, y, w, h }),
    } as unknown as CanvasRenderingContext2D;
    plates.draw(ctx, 500, 500, { name: 'Bob', nameColor: '#fff' });
    expect(draws).toHaveLength(1);
    const [d] = draws;
    expect(d!.y).toBe(500 - NAMEPLATE_OFFSET_Y);
    expect(d!.h).toBe((38 + 25) / 2);
    expect(d!.x + d!.w / 2).toBeCloseTo(500); // centred

    draws.length = 0;
    plates.draw(ctx, 500, 500, {
      name: 'Bob',
      nameColor: '#fff',
      tag: '[WOLF]',
      tagColor: '#9fe3b3',
    });
    expect(draws).toHaveLength(2);
    const [tag, name] = draws;
    expect(tag!.x + tag!.w).toBeCloseTo(name!.x); // tag flush left of the name
    expect((tag!.x + name!.x + name!.w) / 2).toBeCloseTo(500); // the pair centred
  });
});
