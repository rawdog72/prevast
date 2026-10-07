// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import { BinaryWriter } from './binary-stream';
import { dispatchServerMessage } from './dispatcher';
import { NetEventBus } from './events';
import { DisconnectReason, GaugeDirection, ServerOpcode } from './opcodes';

describe('dispatchServerMessage', () => {
  it('decodes DISCONNECT_REASON as [99][u8 reason][str detail]', () => {
    const bus = new NetEventBus();
    const listener = vi.fn();
    bus.on('disconnectReason', listener);
    const packet = new BinaryWriter()
      .u8(ServerOpcode.DISCONNECT_REASON)
      .u8(DisconnectReason.IP_BANNED)
      .str('Permanent. Banned by Admin.')
      .build();
    dispatchServerMessage(packet, bus);
    expect(ServerOpcode.DISCONNECT_REASON).toBe(99);
    expect(listener).toHaveBeenCalledWith({ reason: 7, detail: 'Permanent. Banned by Admin.' });
  });

  it('dispatches MAP_SIZE and WORLD_TIME correctly', () => {
    const bus = new NetEventBus();
    const mapListener = vi.fn();
    const timeListener = vi.fn();
    bus.on('mapSize', mapListener);
    bus.on('worldTime', timeListener);

    // MAP_SIZE: [74][pad][width u16][height u16]
    const mapPacket = new BinaryWriter().u8(ServerOpcode.MAP_SIZE).u8(0).u16(150).u16(150).build();
    dispatchServerMessage(mapPacket, bus);
    expect(mapListener).toHaveBeenCalledWith({ width: 150, height: 150 });

    // WORLD_TIME: [85][cycleMs u32][phaseMs u32]
    const timePacket = new BinaryWriter()
      .u8(ServerOpcode.WORLD_TIME)
      .u32(960000)
      .u32(500000)
      .build();
    dispatchServerMessage(timePacket, bus);
    expect(timeListener).toHaveBeenCalledWith({ cycleMs: 960000, phaseMs: 500000, isNight: true });
  });

  it('dispatches GAUGES as five raw bytes (no padding, no u16 widening)', () => {
    const bus = new NetEventBus();
    const gaugesListener = vi.fn();
    bus.on('gauges', gaugesListener);

    // GAUGES: [12][life u8][food u8][warmth u8][stamina u8][radiation u8] -- ProtocolGame::sendGauges
    const packet = new BinaryWriter()
      .u8(ServerOpcode.GAUGES)
      .u8(200)
      .u8(180)
      .u8(40)
      .u8(255)
      .u8(10)
      .build();
    expect(packet.length).toBe(6);

    dispatchServerMessage(packet, bus);
    expect(gaugesListener).toHaveBeenCalledWith({
      life: 200,
      food: 180,
      warmth: 40,
      stamina: 255,
      radiation: 10,
    });
  });

  it('dispatches GAUGE_STATE with bit-unpacked directions', () => {
    const bus = new NetEventBus();
    const stateListener = vi.fn();
    bus.on('gaugeState', stateListener);

    // GAUGE_STATE: [83][packed u16]
    // Slot 0 (life): RISE (1) -> (1 << 0)
    // Slot 1 (food): FALL (2) -> (2 << 2) = 8
    // Slot 2 (warmth): HOLD (0)
    // Slot 3 (stamina): RISE (1) -> (1 << 6) = 64
    // Slot 4 (radiation): FALL (2) -> (2 << 8) = 512
    const packed = 1 | (2 << 2) | (0 << 4) | (1 << 6) | (2 << 8);
    const packet = new BinaryWriter().u8(ServerOpcode.GAUGE_STATE).u16(packed).build();

    dispatchServerMessage(packet, bus);
    expect(stateListener).toHaveBeenCalledWith({
      life: GaugeDirection.RISE,
      food: GaugeDirection.FALL,
      warmth: GaugeDirection.HOLD,
      stamina: GaugeDirection.RISE,
      radiation: GaugeDirection.FALL,
    });
  });

  it('dispatches INVENTORY_SLOT and FULL_INVENTORY', () => {
    const bus = new NetEventBus();
    const slotListener = vi.fn();
    const fullListener = vi.fn();
    bus.on('inventorySlot', slotListener);
    bus.on('fullInventory', fullListener);

    // INVENTORY_SLOT: [84][uid u8][iid u16][count u8][ammo u8]
    const slotPacket = new BinaryWriter()
      .u8(ServerOpcode.INVENTORY_SLOT)
      .u8(3)
      .u16(18)
      .u8(1)
      .u8(0)
      .build();
    dispatchServerMessage(slotPacket, bus);
    expect(slotListener).toHaveBeenCalledWith({ uid: 3, iid: 18, count: 1, ammo: 0 });

    // FULL_INVENTORY: [15] then 2 slots: [iid u16][count u8][uid u8][ammo u8]
    const fullPacket = new BinaryWriter()
      .u8(ServerOpcode.FULL_INVENTORY)
      .u16(1)
      .u8(10)
      .u8(0)
      .u8(0)
      .u16(2)
      .u8(5)
      .u8(1)
      .u8(0)
      .build();
    dispatchServerMessage(fullPacket, bus);
    expect(fullListener).toHaveBeenCalledWith({
      slots: [
        { iid: 1, count: 10, uid: 0, ammo: 0 },
        { iid: 2, count: 5, uid: 1, ammo: 0 },
      ],
    });
  });

  it('dispatches UNITS with 24-bit id and record layout', () => {
    const bus = new NetEventBus();
    const unitsListener = vi.fn();
    bus.on('units', unitsListener);

    // UNITS: [0][loginFlag u8]
    // 1 record (18 bytes):
    // pid 5, idHigh 0x01, rotation 45, type 0, state 100, idLow 0x2345, startX 100, startY 200, endX 110, endY 210, extra 3
    // Full id = 0x012345 = 74565
    const packet = new BinaryWriter()
      .u8(ServerOpcode.UNITS)
      .u8(1) // isFullReset
      .u8(5) // pid
      .u8(0x01) // idHigh
      .u8(45) // rotation
      .u8(0) // type
      .u16(100) // state
      .u16(0x2345) // idLow
      .u16(100) // startX
      .u16(200) // startY
      .u16(110) // endX
      .u16(210) // endY
      .u16(3) // extra
      .build();

    dispatchServerMessage(packet, bus);
    expect(unitsListener).toHaveBeenCalledWith({
      isFullReset: true,
      units: [
        {
          pid: 5,
          id: 0x012345,
          rotation: 45,
          type: 0,
          state: 100,
          startX: 100,
          startY: 200,
          endX: 110,
          endY: 210,
          extra: 3,
        },
      ],
    });
  });

  it('dispatches CHAT_CHANNEL, SERVER_LOG, CHAT_ACCESS, ALERT, and NICKNAMES', () => {
    const bus = new NetEventBus();
    const chatListener = vi.fn();
    const alertListener = vi.fn();
    const nickListener = vi.fn();
    bus.on('chat', chatListener);
    bus.on('alert', alertListener);
    bus.on('nicknames', nickListener);

    // CHAT_CHANNEL: [90][channel u8][from u8][peer u8][flags u8][str text]
    const chatPacket = new BinaryWriter()
      .u8(ServerOpcode.CHAT_CHANNEL)
      .u8(4)
      .u8(4)
      .u8(7)
      .u8(1)
      .str('team recruit')
      .build();
    dispatchServerMessage(chatPacket, bus);
    expect(chatListener).toHaveBeenCalledWith({ channel: 4, pid: 4, peer: 7, flags: 1, text: 'team recruit' });

    // SERVER_LOG: [91][kind u8][a u8][b u8][str text]
    const logListener = vi.fn();
    bus.on('serverLog', logListener);
    dispatchServerMessage(new BinaryWriter().u8(ServerOpcode.SERVER_LOG).u8(2).u8(4).u8(255).str('').build(), bus);
    expect(logListener).toHaveBeenCalledWith({ kind: 2, a: 4, b: 255, text: '' });

    // CHAT_ACCESS: [92][mask u8]
    const accessListener = vi.fn();
    bus.on('chatAccess', accessListener);
    dispatchServerMessage(new Uint8Array([ServerOpcode.CHAT_ACCESS, 0x1f]), bus);
    expect(accessListener).toHaveBeenCalledWith({ mask: 0x1f });

    // ALERT: [79][str text]
    const alertPacket = new BinaryWriter().u8(ServerOpcode.ALERT).str('Server restarting').build();
    dispatchServerMessage(alertPacket, bus);
    expect(alertListener).toHaveBeenCalledWith({ text: 'Server restarting' });

    // NICKNAMES: [78][count u16][str name]*count [str sessionToken]
    const nickPacket = new BinaryWriter()
      .u8(ServerOpcode.NICKNAMES)
      .u16(2)
      .str('') // slot 0 empty
      .str('Alice') // slot 1
      .str('session-token-xyz')
      .build();
    dispatchServerMessage(nickPacket, bus);
    expect(nickListener).toHaveBeenCalledWith({
      names: [null, 'Alice'],
      sessionToken: 'session-token-xyz',
    });
  });

  it('dispatches DAMAGE_INDICATOR and PONG', () => {
    const bus = new NetEventBus();
    const dmgListener = vi.fn();
    const pongListener = vi.fn();
    bus.on('damageIndicator', dmgListener);
    bus.on('pong', pongListener);

    // DAMAGE_INDICATOR: [86][x u16][y u16][amount i16][pct u8]
    const dmgPacket = new BinaryWriter()
      .u8(ServerOpcode.DAMAGE_INDICATOR)
      .u16(500)
      .u16(600)
      .i16(-26)
      .u8(90)
      .build();
    dispatchServerMessage(dmgPacket, bus);
    expect(dmgListener).toHaveBeenCalledWith({ x: 500, y: 600, amount: -26, pct: 90 });

    // PONG: [82]
    dispatchServerMessage(new Uint8Array([ServerOpcode.PONG]), bus);
    expect(pongListener).toHaveBeenCalled();
  });
  it('dispatches LEADERBOARD as ten [guid][karma][deflated score u16] slots after a pad byte', () => {
    const bus = new NetEventBus();
    const listener = vi.fn();
    bus.on('leaderboard', listener);

    // Game::buildLeaderboardMessage: [8][0] then per slot [guid u8][karma u8][score u16 LE].
    // deflateNumber: n >= 1e6 -> n/1000 + 20000; n >= 1e4 -> n/100 + 10000.
    const w = new BinaryWriter().u8(ServerOpcode.LEADERBOARD).u8(0);
    w.u8(3).u8(2).u16(1506); // plain
    w.u8(7).u8(0).u16(10123); // 12,300 deflated
    w.u8(9).u8(4).u16(22000); // 2,000,000 deflated
    for (let i = 3; i < 10; i++) w.u8(0).u8(0).u16(0); // empty slots
    dispatchServerMessage(w.build(), bus);

    expect(listener).toHaveBeenCalledWith({
      entries: [
        { guid: 3, karma: 2, score: 1506 },
        { guid: 7, karma: 0, score: 12300 },
        { guid: 9, karma: 4, score: 2000000 },
      ],
    });
  });

  it('dispatches SCORE as [pad][high u16][low u16]', () => {
    const bus = new NetEventBus();
    const listener = vi.fn();
    bus.on('score', listener);
    // ProtocolGame::sendScore: pad, then the high and low halves as u16 LE each.
    const packet = new BinaryWriter().u8(ServerOpcode.SCORE).u8(0).u16(1).u16(2).build();
    dispatchServerMessage(packet, bus);
    expect(listener).toHaveBeenCalledWith({ score: 65538 });
  });

  it('dispatches PLAYER_XP_SKILL as [level][xp u32 BE][unlocked iids...]', () => {
    const bus = new NetEventBus();
    const listener = vi.fn();
    bus.on('playerXpSkill', listener);
    const packet = new Uint8Array([ServerOpcode.PLAYER_XP_SKILL, 7, 0, 0, 1, 44, 27, 50]);
    dispatchServerMessage(packet, bus);
    expect(listener).toHaveBeenCalledWith({ level: 7, xp: 300, skills: [27, 50] });
  });

  it('dispatches the clan membership packets with the player ids they carry', () => {
    const bus = new NetEventBus();
    const accepted = vi.fn();
    const kicked = vi.fn();
    const join = vi.fn();
    bus.on('acceptedTeam', accepted);
    bus.on('kickedTeam', kicked);
    bus.on('joinTeam', join);

    dispatchServerMessage(new Uint8Array([ServerOpcode.ACCEPTED_TEAM, 5, 2]), bus);
    expect(accepted).toHaveBeenCalledWith({ pid: 5, clanId: 2 });
    dispatchServerMessage(new Uint8Array([ServerOpcode.KICKED_TEAM, 5]), bus);
    expect(kicked).toHaveBeenCalledWith({ pid: 5 });
    dispatchServerMessage(new Uint8Array([ServerOpcode.JOIN_TEAM, 9]), bus);
    expect(join).toHaveBeenCalledWith({ pid: 9 });
  });

  it('dispatches TEAM_INVITE, TEAM_LOCKED and BLOCKED_PLAYERS', () => {
    const bus = new NetEventBus();
    const invite = vi.fn();
    const locked = vi.fn();
    const blocked = vi.fn();
    bus.on('teamInvite', invite);
    bus.on('teamLocked', locked);
    bus.on('blockedPlayers', blocked);

    dispatchServerMessage(new Uint8Array([ServerOpcode.TEAM_INVITE, 3, 7]), bus);
    expect(invite).toHaveBeenCalledWith({ clanId: 3, inviterGuid: 7 });
    dispatchServerMessage(new Uint8Array([ServerOpcode.TEAM_LOCKED, 3, 1]), bus);
    expect(locked).toHaveBeenCalledWith({ clanId: 3, locked: true });
    dispatchServerMessage(new Uint8Array([ServerOpcode.TEAM_LOCKED, 3, 0]), bus);
    expect(locked).toHaveBeenLastCalledWith({ clanId: 3, locked: false });
    dispatchServerMessage(new Uint8Array([ServerOpcode.BLOCKED_PLAYERS, 2, 4, 9]), bus);
    expect(blocked).toHaveBeenCalledWith({ guids: [4, 9] });
    dispatchServerMessage(new Uint8Array([ServerOpcode.BLOCKED_PLAYERS, 0]), bus);
    expect(blocked).toHaveBeenLastCalledWith({ guids: [] });
  });

  it('dispatches TEAM_POSITION as [x/255 u8][y/255 u8][guid u8] triples', () => {
    const bus = new NetEventBus();
    const listener = vi.fn();
    bus.on('teamPosition', listener);
    dispatchServerMessage(new Uint8Array([ServerOpcode.TEAM_POSITION, 0, 255, 4, 128, 64, 6]), bus);
    expect(listener).toHaveBeenCalledWith({
      positions: [
        { guid: 4, x: 0, y: 255 },
        { guid: 6, x: 128, y: 64 },
      ],
    });
  });
});

describe('CITIES_LOCATION', () => {
  it('splits the (y, x) tile pairs into cityCount cities and the remaining houses', () => {
    const bus = new NetEventBus();
    const listener = vi.fn();
    bus.on('citiesLocation', listener);

    // [66][pad u8][cityCount u16] then (y u16, x u16) tile pairs -- ProtocolGame::sendCitiesLocation
    const packet = new BinaryWriter()
      .u8(ServerOpcode.CITIES_LOCATION)
      .u8(0)
      .u16(1)
      .u16(104)
      .u16(68) // city at tile x=68, y=104
      .u16(20)
      .u16(101) // house
      .u16(22)
      .u16(24) // house
      .build();
    dispatchServerMessage(packet, bus);
    expect(listener).toHaveBeenCalledWith({
      cities: [{ x: 68, y: 104 }],
      houses: [
        { x: 101, y: 20 },
        { x: 24, y: 22 },
      ],
    });
  });
});

describe('NOTIFICATION', () => {
  it('decodes [11][pid][(type << 2) | level] into the gauge alert type and level', () => {
    const bus = new NetEventBus();
    const listener = vi.fn();
    bus.on('notification', listener);
    dispatchServerMessage(new Uint8Array([ServerOpcode.NOTIFICATION, 7, (3 << 2) | 2]), bus);
    expect(listener).toHaveBeenCalledWith({ pid: 7, type: 3, level: 2 });
  });
});

describe('FULL_CHEST', () => {
  it('decodes [53][firstOpen] then [iid u16][count u8][ammo u8][mods] per storage slot', () => {
    const bus = new NetEventBus();
    const listener = vi.fn();
    bus.on('fullChest', listener);
    // Each storage slot: [iid u16][count][ammo][n = 0 mods].
    const slot = (iid: number, count: number, ammo: number) => [
      iid & 0xff,
      iid >> 8,
      count,
      ammo,
      0,
    ];
    dispatchServerMessage(
      new Uint8Array([
        ServerOpcode.FULL_CHEST,
        1,
        ...slot(2, 20, 0),
        ...slot(0, 0, 0),
        ...slot(15, 1, 7),
        ...slot(0, 0, 0),
      ]),
      bus,
    );
    expect(listener).toHaveBeenCalledWith({
      firstOpen: true,
      slots: 4,
      items: [
        { iid: 2, count: 20, ammo: 0, mods: [] },
        { iid: 0, count: 0, ammo: 0, mods: [] },
        { iid: 15, count: 1, ammo: 7, mods: [] },
        { iid: 0, count: 0, ammo: 0, mods: [] },
      ],
    });
  });
});

describe('BAD_KARMA', () => {
  it('decodes [60][guid][x/255][y/255][karma icon] (Game::broadcastBadKarma)', () => {
    const bus = new NetEventBus();
    const listener = vi.fn();
    bus.on('badKarma', listener);

    dispatchServerMessage(
      new BinaryWriter().u8(ServerOpcode.BAD_KARMA).u8(7).u8(51).u8(204).u8(4).build(),
      bus,
    );
    expect(listener).toHaveBeenCalledWith({ guid: 7, x: 51 / 255, y: 204 / 255, karma: 4 });
  });
});

describe('SELECTED_ITEM', () => {
  it('decodes the iid big-endian, as the server writes it ([20][high][low])', () => {
    const bus = new NetEventBus();
    const listener = vi.fn();
    bus.on('selectedItem', listener);
    dispatchServerMessage(
      new BinaryWriter().u8(ServerOpcode.SELECTED_ITEM).u8(0).u8(113).build(),
      bus,
    );
    expect(listener).toHaveBeenCalledWith({ iid: 113 });
    dispatchServerMessage(
      new BinaryWriter().u8(ServerOpcode.SELECTED_ITEM).u8(1).u8(2).build(),
      bus,
    );
    expect(listener).toHaveBeenLastCalledWith({ iid: 258 });
  });
});
