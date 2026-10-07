// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { NetEventBus } from '../net/events';
import { EntityType } from './entity-types';
import { drugSkinIndex, newPlayerInfo, WorldState, type PlayerInfo } from './world-state';

describe('WorldState', () => {
  it('updates state reactively from NetEventBus', () => {
    const world = new WorldState();
    const bus = new NetEventBus();
    const detach = world.attachBus(bus);

    // Handshake
    bus.emit('handshake', {
      ownGuid: 1,
      unitsPerPlayer: 120,
      playerCount: 1,
      modeId: 0,
      players: [{ guid: 1, team: 0, repellent: 0, withdrawal: 0, ghoul: 0, tokenId: 10, score: 0 }],
    });
    expect(world.ownGuid).toBe(1);
    expect(world.entities.unitsPerPlayer).toBe(120);
    expect(world.players.get(1)?.guid).toBe(1);

    // Map size
    bus.emit('mapSize', { width: 200, height: 180 });
    expect(world.tilesX).toBe(200);
    expect(world.tilesY).toBe(180);
    expect(world.worldWidth).toBe(20000);

    // World time
    bus.emit('worldTime', { cycleMs: 120000, phaseMs: 10000, isNight: false });
    expect(world.clock.isNight).toBe(false);
    expect(world.clock.phaseMs).toBe(10000);

    // Gauges
    bus.emit('gauges', { life: 200, food: 180, warmth: 250, stamina: 240, radiation: 5 });
    expect(world.localPlayerGauges.life).toBe(200);
    expect(world.localPlayerGauges.food).toBe(180);

    // Units
    bus.emit('units', {
      isFullReset: false,
      units: [
        {
          pid: 1,
          id: 0,
          type: EntityType.PLAYER,
          rotation: 64,
          state: 1,
          startX: 500,
          startY: 600,
          endX: 520,
          endY: 600,
          extra: 0,
        },
      ],
    });

    const local = world.getLocalEntity();
    expect(local).toBeDefined();
    expect(local?.x).toBe(500);
    expect(local?.y).toBe(600);

    // Detach unbinds cleanly
    detach();
    bus.emit('mapSize', { width: 300, height: 300 });
    expect(world.tilesX).toBe(200); // Unchanged
  });

  it('turns the local player with the mouse angle, not the server-echoed rotation', () => {
    const world = new WorldState();
    world.ownGuid = 1;
    const unit = {
      pid: 1,
      id: 0,
      type: EntityType.PLAYER,
      rotation: 0, // server still thinks we face right
      state: 1,
      startX: 500,
      startY: 600,
      endX: 500,
      endY: 600,
      extra: 0,
    };
    world.entities.processUnits([unit]);
    world.localPlayerAngle = Math.PI / 2;

    world.update(16);

    expect(world.getLocalEntity()!.angle).toBe(Math.PI / 2);
  });

  it('still smooths other players toward their server rotation', () => {
    const world = new WorldState();
    world.ownGuid = 1;
    world.entities.processUnits([
      {
        pid: 2,
        id: 0,
        type: EntityType.PLAYER,
        rotation: 0,
        state: 1,
        startX: 500,
        startY: 600,
        endX: 500,
        endY: 600,
        extra: 0,
      },
    ]);
    world.localPlayerAngle = Math.PI / 2;
    world.entities.processUnits([
      {
        pid: 2,
        id: 0,
        type: EntityType.PLAYER,
        rotation: 64,
        state: 1,
        startX: 500,
        startY: 600,
        endX: 500,
        endY: 600,
        extra: 0,
      },
    ]);

    world.update(16);

    const other = world.entities.get(2, 0)!;
    expect(other.angle).toBeGreaterThan(0);
    expect(other.angle).toBeLessThan(Math.PI / 2);
  });

  it('clock transitions on day/night threshold', () => {
    const world = new WorldState();
    world.clock.sync(10000, 4900, false); // Just before half = 5000

    world.update(200); // Crosses to 5100 -> night
    expect(world.clock.isNight).toBe(true);
  });

  it('clock.remainingMs counts down to the next half switch in either half', () => {
    const world = new WorldState();
    world.clock.sync(240000, 30000, false); // 30 s into a 2 min day
    expect(world.clock.remainingMs()).toBe(90000);

    world.clock.sync(240000, 200000, true); // 80 s into the night
    expect(world.clock.remainingMs()).toBe(40000);

    world.clock.sync(240000, 120000, true); // the first ms of night: a full half left
    expect(world.clock.remainingMs()).toBe(120000);
  });
});

describe('WorldState blocked players', () => {
  it('BLOCKED_PLAYERS replaces the whole set; a new session starts with none', () => {
    const world = new WorldState();
    const bus = new NetEventBus();
    world.attachBus(bus);
    const handshake = {
      ownGuid: 1,
      unitsPerPlayer: 12,
      playerCount: 1,
      modeId: 0,
      players: [],
    };
    bus.emit('handshake', handshake);
    bus.emit('blockedPlayers', { guids: [4, 9] });
    expect([...world.blocked]).toEqual([4, 9]);
    bus.emit('blockedPlayers', { guids: [9] });
    expect([...world.blocked]).toEqual([9]);
    bus.emit('handshake', handshake);
    expect(world.blocked.size).toBe(0);
  });
});

describe('WorldState roster', () => {
  function handshake(players: { guid: number; team: number }[]) {
    return {
      ownGuid: 1,
      unitsPerPlayer: 12,
      playerCount: 255,
      modeId: 0,
      players: players.map((p) => ({
        ...p,
        repellent: 0,
        withdrawal: 0,
        ghoul: 0,
        tokenId: 1000 + p.guid,
        score: 0,
      })),
    };
  }

  it('keeps nicknames that NICKNAMES / PLAYER_INFO delivered before the handshake', () => {
    const world = new WorldState();
    const bus = new NetEventBus();
    world.attachBus(bus);

    bus.emit('nicknames', { names: [null, 'AdminTest2', 'DecodeBot'], sessionToken: 't' });
    bus.emit('playerInfo', {
      guid: 1,
      tokenId: 1001,
      skin: 0,
      ghoul: 0,
      name: 'AdminTest2',
      groupId: 0,
      verified: false,
    });
    bus.emit(
      'handshake',
      handshake([
        { guid: 1, team: 50 },
        { guid: 2, team: 50 },
      ]),
    );

    expect(world.players.get(1)?.nickname).toBe('AdminTest2');
    expect(world.players.get(2)?.nickname).toBe('DecodeBot');
  });

  it('keeps groupId/verified that PLAYER_INFO delivered before the handshake', () => {
    const world = new WorldState();
    const bus = new NetEventBus();
    world.attachBus(bus);

    bus.emit('playerInfo', {
      guid: 1,
      tokenId: 1001,
      skin: 0,
      ghoul: 0,
      name: 'AdminTest2',
      groupId: 4,
      verified: true,
    });
    bus.emit('handshake', handshake([{ guid: 1, team: 50 }]));

    expect(world.players.get(1)).toMatchObject({ groupId: 4, verified: true });
  });

  it('decodes the handshake team byte: 50 = none, 0..17 = member, 51+ = leader of (byte - 51)', () => {
    const world = new WorldState();
    const bus = new NetEventBus();
    world.attachBus(bus);

    bus.emit(
      'handshake',
      handshake([
        { guid: 1, team: 50 },
        { guid: 2, team: 3 },
        { guid: 3, team: 54 },
      ]),
    );

    expect(world.players.get(1)).toMatchObject({ team: -1, teamLeader: false });
    expect(world.players.get(2)).toMatchObject({ team: 3, teamLeader: false });
    expect(world.players.get(3)).toMatchObject({ team: 3, teamLeader: true });
  });

  it('stores city and house tile positions for the minimap', () => {
    const world = new WorldState();
    const bus = new NetEventBus();
    world.attachBus(bus);

    bus.emit('citiesLocation', { cities: [{ x: 68, y: 104 }], houses: [{ x: 101, y: 20 }] });
    expect(world.cities).toEqual([{ x: 68, y: 104 }]);
    expect(world.houses).toEqual([{ x: 101, y: 20 }]);
  });
});

describe('WorldState drug state (old client repellent / withdrawal timers)', () => {
  function handshakeWith(p: { guid: number; repellent: number; withdrawal: number }) {
    return {
      ownGuid: 1,
      unitsPerPlayer: 12,
      playerCount: 255,
      modeId: 0,
      players: [{ ...p, team: 50, ghoul: 0, tokenId: 1000 + p.guid, score: 0 }],
    };
  }

  it('seeds the timers from the handshake: repellent x2000 ms, withdrawal x1000 ms', () => {
    const world = new WorldState();
    const bus = new NetEventBus();
    world.attachBus(bus);

    bus.emit('handshake', handshakeWith({ guid: 2, repellent: 3, withdrawal: 5 }));
    expect(world.players.get(2)).toMatchObject({
      repellentMs: 6000,
      withdrawalMs: 5000,
      withdrawn: false,
    });
  });

  it('keeps a guest who joined without a name nameless: no "Player N" stand-in', () => {
    const world = new WorldState();
    const bus = new NetEventBus();
    world.attachBus(bus);
    bus.emit('playerInfo', {
      guid: 9,
      tokenId: 2,
      skin: 0,
      ghoul: 0,
      name: '',
      groupId: 1,
      verified: false,
    });
    expect(world.players.get(9)!.nickname).toBe('');
  });

  it('REPELLENT / LAPADOINE set the timers, which count down with the world clock', () => {
    const world = new WorldState();
    const bus = new NetEventBus();
    world.attachBus(bus);
    bus.emit('playerInfo', {
      guid: 2,
      tokenId: 1,
      skin: 0,
      ghoul: 0,
      name: 'B',
      groupId: 0,
      verified: false,
    });

    bus.emit('drug', { kind: 'repellent', a: 2, b: 2 });
    bus.emit('drug', { kind: 'lapadoine', a: 2, b: 1 });
    expect(world.players.get(2)).toMatchObject({ repellentMs: 4000, withdrawalMs: 1000 });

    world.update(600);
    expect(world.players.get(2)).toMatchObject({ repellentMs: 3400, withdrawalMs: 400 });

    // A withdrawal timer that runs out leaves the player withdrawn (old client:
    // PLAYER.withdrawal stays > 0 after it expires).
    world.update(600);
    expect(world.players.get(2)).toMatchObject({ withdrawalMs: 0, withdrawn: true });
    expect(world.players.get(2)?.repellentMs).toBe(2800);
  });

  it('RESET_DRUG clears both timers and states the withdrawn marker', () => {
    const world = new WorldState();
    const bus = new NetEventBus();
    world.attachBus(bus);
    bus.emit('playerInfo', {
      guid: 2,
      tokenId: 1,
      skin: 0,
      ghoul: 0,
      name: 'B',
      groupId: 0,
      verified: false,
    });
    bus.emit('drug', { kind: 'repellent', a: 2, b: 2 });
    bus.emit('drug', { kind: 'lapadoine', a: 2, b: 4 });

    bus.emit('drug', { kind: 'reset', a: 2, b: 1 });
    expect(world.players.get(2)).toMatchObject({
      repellentMs: 0,
      withdrawalMs: 0,
      withdrawn: true,
    });

    bus.emit('drug', { kind: 'reset', a: 2, b: 0 });
    expect(world.players.get(2)?.withdrawn).toBe(false);
  });

  it('a (re)joining player starts clean (old client onNewPlayer)', () => {
    const world = new WorldState();
    const bus = new NetEventBus();
    world.attachBus(bus);
    bus.emit('playerInfo', {
      guid: 2,
      tokenId: 1,
      skin: 0,
      ghoul: 0,
      name: 'B',
      groupId: 0,
      verified: false,
    });
    bus.emit('drug', { kind: 'repellent', a: 2, b: 2 });
    bus.emit('drug', { kind: 'reset', a: 2, b: 1 });

    bus.emit('playerInfo', {
      guid: 2,
      tokenId: 2,
      skin: 0,
      ghoul: 0,
      name: 'B',
      groupId: 0,
      verified: false,
    });
    expect(world.players.get(2)).toMatchObject({
      repellentMs: 0,
      withdrawalMs: 0,
      withdrawn: false,
    });
  });

  it('drugSkinIndex follows the old client skin table', () => {
    const base = newPlayerInfo(2, 'B');
    const info = (o: Partial<PlayerInfo>) => ({ ...base, ...o });
    expect(drugSkinIndex(info({}))).toBe(0);
    expect(drugSkinIndex(info({ repellentMs: 10 }))).toBe(1);
    expect(drugSkinIndex(info({ withdrawalMs: 10 }))).toBe(2);
    expect(drugSkinIndex(info({ repellentMs: 10, withdrawalMs: 10 }))).toBe(3);
    expect(drugSkinIndex(info({ withdrawn: true }))).toBe(4);
    expect(drugSkinIndex(info({ repellentMs: 10, withdrawn: true }))).toBe(5);
    // Active withdrawal outranks the withdrawn marker.
    expect(drugSkinIndex(info({ withdrawalMs: 10, withdrawn: true }))).toBe(2);
    expect(drugSkinIndex(info({ repellentMs: 10, withdrawalMs: 10, withdrawn: true }))).toBe(3);
  });
});

describe('WorldState bad-karma marker (old client badKarma / badKarmaDelay)', () => {
  it('records the worst player at their map position for 14 s, tracking a visible entity', () => {
    const world = new WorldState();
    const bus = new NetEventBus();
    world.attachBus(bus);
    world.ownGuid = 1;
    bus.emit('mapSize', { width: 100, height: 200 });

    bus.emit('badKarma', { guid: 7, x: 0.5, y: 0.25, karma: 4 });
    expect(world.badKarma).toEqual({ guid: 7, x: 5000, y: 5000, karma: 4, remainingMs: 14000 });

    world.update(4000);
    expect(world.badKarma?.remainingMs).toBe(10000);

    // The tracked player walks into view: the marker follows the live entity.
    bus.emit('units', {
      isFullReset: false,
      units: [
        {
          pid: 7,
          id: 0,
          type: EntityType.PLAYER,
          rotation: 0,
          state: 1,
          startX: 6100,
          startY: 4200,
          endX: 6100,
          endY: 4200,
          extra: 0,
        },
      ],
    });
    world.update(16);
    expect(world.badKarma).toMatchObject({ x: 6100, y: 4200 });

    world.update(10000);
    expect(world.badKarma).toBeNull();
  });

  it('never marks ourselves and drops the marker when that player dies', () => {
    const world = new WorldState();
    const bus = new NetEventBus();
    world.attachBus(bus);
    world.ownGuid = 1;

    bus.emit('badKarma', { guid: 1, x: 0.5, y: 0.5, karma: 5 });
    expect(world.badKarma).toBeNull();

    bus.emit('badKarma', { guid: 9, x: 0.5, y: 0.5, karma: 5 });
    expect(world.badKarma?.guid).toBe(9);
    bus.emit('otherDie', { pid: 9 });
    expect(world.badKarma).toBeNull();
  });
});
