// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, it } from 'vitest';
import { NetEventBus } from '../events';
import { dispatchServerMessage } from '../dispatcher';
import { ServerOpcode } from '../opcodes';
import { WorldState, newPlayerInfo } from '../../world/world-state';
import { ClanStore } from '../../world/clan-store';
import { nameplateFor } from '../../render/nameplates';
import { EntityType, type WorldEntity } from '../../world/entity-types';
import { clanShieldColor } from '../../../../../shared/typescript/account-community';
const frame = (opcode: number, payload: unknown) => {
  const body = new TextEncoder().encode(JSON.stringify(payload)),
    out = new Uint8Array(body.length + 3);
  out[0] = opcode;
  new DataView(out.buffer).setUint16(1, body.length, true);
  out.set(body, 3);
  return out;
};
describe('account community packets', () => {
  it('updates and clears ranked shields without changing temporary teams or their permissions', () => {
    const bus = new NetEventBus(),
      world = new WorldState();
    world.attachBus(bus);
    world.ownGuid = 1;
    world.players.set(1, { ...newPlayerInfo(1, 'Alice'), verified: true, team: 2, teamUid: 1 });
    const clans = new ClanStore(world);
    clans.clans[2] = { id: 2, uid: 1, name: 'TEMP', leaderGuid: 1 };
    const clan = { id: 700, name: 'Wolves', tag: 'WOLF', rank: 1 };
    dispatchServerMessage(frame(ServerOpcode.ACCOUNT_CLANS, { players: [{ pid: 1, clan }] }), bus);
    const entity = {
      pid: 1,
      id: 0,
      type: EntityType.PLAYER,
      extra: 0,
      removed: false,
    } as WorldEntity;
    expect(nameplateFor(entity, world, clans)).toMatchObject({
      tag: '[TEMP]',
      accountTag: 'WOLF',
      shieldColor: clanShieldColor(1),
    });
    expect(world.players.get(1)!.team).toBe(2);
    dispatchServerMessage(
      frame(ServerOpcode.ACCOUNT_CLANS, { players: [{ pid: 1, clan: { ...clan, rank: 2 } }] }),
      bus,
    );
    expect(nameplateFor(entity, world, clans)?.shieldColor).toBe(clanShieldColor(2));
    dispatchServerMessage(
      frame(ServerOpcode.ACCOUNT_CLANS, { players: [{ pid: 1, clan: null }] }),
      bus,
    );
    expect(nameplateFor(entity, world, clans)?.accountTag).toBeUndefined();
    expect(world.players.get(1)!.team).toBe(2);
  });
  it('drops corrupt, truncated and out-of-range data as a whole', () => {
    const bus = new NetEventBus(),
      world = new WorldState();
    world.attachBus(bus);
    world.players.set(1, newPlayerInfo(1, 'Alice'));
    let updates = 0;
    bus.on('accountClans', () => updates++);
    const valid = frame(ServerOpcode.ACCOUNT_CLANS, { players: [{ pid: 1, clan: null }] });
    dispatchServerMessage(valid.slice(0, -1), bus);
    dispatchServerMessage(
      frame(ServerOpcode.ACCOUNT_CLANS, { players: [{ pid: 256, clan: null }] }),
      bus,
    );
    dispatchServerMessage(new Uint8Array([...valid, 0]), bus);
    dispatchServerMessage(frame(ServerOpcode.ACCOUNT_RUN, { scoreCaps: -1 }), bus);
    expect(updates).toBe(0);
    expect(world.ownRun).toBeNull();
  });
  it('uses the server run identity and preserves it until a new handshake', () => {
    const bus = new NetEventBus(),
      world = new WorldState();
    world.attachBus(bus);
    const run = {
      runId: 'life-1',
      earnedScore: 99000,
      scorePerCap: 10000,
      scoreCaps: 9,
      rewardCaps: 2,
      survivedSeconds: 500,
      bestScore: 20000,
      clanContribution: 10000,
      ranked: true,
    };
    dispatchServerMessage(frame(ServerOpcode.ACCOUNT_RUN, run), bus);
    expect(world.ownRun).toEqual(run);
    dispatchServerMessage(
      frame(ServerOpcode.ACCOUNT_RUN, { ...run, earnedScore: 100000, scoreCaps: 10 }),
      bus,
    );
    expect(world.ownRun?.runId).toBe('life-1');
    bus.emit('handshake', {
      ownGuid: 1,
      unitsPerPlayer: 12,
      playerCount: 1,
      modeId: 0,
      players: [],
    });
    expect(world.ownRun).toBeNull();
  });
});
