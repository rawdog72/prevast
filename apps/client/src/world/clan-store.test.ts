// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { NetEventBus } from '../net/events';
import { ClanStore } from './clan-store';
import { WorldState } from './world-state';

function setup() {
  const world = new WorldState();
  const bus = new NetEventBus();
  world.attachBus(bus);
  const clans = new ClanStore(world);
  clans.attachBus(bus);
  const roster = (players: { guid: number; team: number }[]) => ({
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
  });
  bus.emit('nicknames', { names: [null, 'Me', 'Bob', 'Zed', 'alice'], sessionToken: '' });
  bus.emit('teamNames', { names: ['', 'WOLF', ''] });
  return { world, bus, clans, roster };
}

describe('ClanStore (old client World.teams / World.PLAYER team state)', () => {
  it('allocates clan slots from TEAM_NAMES and reads membership + leadership from the handshake', () => {
    const { bus, clans, roster } = setup();
    expect(clans.clans).toHaveLength(3);
    expect(clans.clans[1].name).toBe('WOLF');

    bus.emit(
      'handshake',
      roster([
        { guid: 1, team: 50 },
        { guid: 2, team: 52 },
        { guid: 3, team: 1 },
      ]),
    );
    expect(clans.clans[1].leaderGuid).toBe(2);
    expect(clans.teamId).toBe(-1);
    expect(clans.members(1).map((p) => p.guid)).toEqual([2, 3]);
    expect(clans.listed().map((c) => c.id)).toEqual([1]);
  });

  it('TEAM_CREATED names the clan and seats its leader; TEAM_MEMBER_JOINED adds members and sets our own clan only for us', () => {
    const { bus, clans, roster } = setup();
    bus.emit(
      'handshake',
      roster([
        { guid: 1, team: 50 },
        { guid: 2, team: 50 },
        { guid: 3, team: 50 },
      ]),
    );

    bus.emit('teamCreated', { clanId: 0, leaderGuid: 1, name: 'ME' });
    bus.emit('acceptedTeam', { pid: 1, clanId: 0 });
    expect(clans.teamId).toBe(0);
    expect(clans.isLeader).toBe(true);
    expect(clans.locked).toBe(false);

    bus.emit('acceptedTeam', { pid: 3, clanId: 0 });
    expect(clans.teamId).toBe(0);
    expect(clans.members(0).map((p) => p.guid)).toEqual([1, 3]);

    bus.emit('teamCreated', { clanId: 2, leaderGuid: 2, name: 'BOB' });
    bus.emit('acceptedTeam', { pid: 2, clanId: 2 });
    expect(clans.teamId).toBe(0);
    expect(clans.members(2).map((p) => p.guid)).toEqual([2]);
  });

  it('members sort leader first, then by name (natural order), and drop players whose clan slot was recycled', () => {
    const { bus, clans, roster } = setup();
    bus.emit(
      'handshake',
      roster([
        { guid: 1, team: 1 },
        { guid: 2, team: 52 },
        { guid: 3, team: 1 },
        { guid: 4, team: 1 },
      ]),
    );
    expect(clans.members(1).map((p) => p.guid)).toEqual([2, 4, 1, 3]); // Bob (leader), alice, Me, Zed

    bus.emit('deleteTeam', { clanId: 1 });
    expect(clans.teamId).toBe(-1);
    expect(clans.members(1)).toEqual([]);
    expect(clans.listed()).toEqual([]);

    // A new clan in the recycled slot does not inherit the old members.
    bus.emit('teamCreated', { clanId: 1, leaderGuid: 2, name: 'NEW' });
    expect(clans.members(1).map((p) => p.guid)).toEqual([2]);
  });

  it('TEAM_MEMBER_LEFT removes that player; for us it also clears leadership and pending requests', () => {
    const { bus, clans, roster } = setup();
    bus.emit(
      'handshake',
      roster([
        { guid: 1, team: 51 },
        { guid: 3, team: 0 },
      ]),
    );
    bus.emit('joinTeam', { pid: 2 });
    expect(clans.isLeader).toBe(true);

    bus.emit('kickedTeam', { pid: 3 });
    expect(clans.members(0).map((p) => p.guid)).toEqual([1]);

    bus.emit('kickedTeam', { pid: 1 });
    expect(clans.teamId).toBe(-1);
    expect(clans.isLeader).toBe(false);
    expect(clans.joinRequest).toBe(0);
  });

  it('queues TEAM_JOIN_REQUEST requests five deep behind the one being shown; nextInvitation pops the queue', () => {
    const { bus, clans, roster } = setup();
    bus.emit('handshake', roster([{ guid: 1, team: 51 }]));
    for (const pid of [2, 3, 4, 5, 6, 7, 8]) bus.emit('joinTeam', { pid });
    expect(clans.joinRequest).toBe(2);
    expect(clans.pendingCount()).toBe(5); // 8 dropped: queue full
    clans.nextInvitation();
    expect(clans.joinRequest).toBe(3);
    expect(clans.pendingCount()).toBe(4);
    for (let i = 0; i < 5; i++) clans.nextInvitation();
    expect(clans.joinRequest).toBe(0);
  });

  it('tracks the create / request action delays and the client-side lock flag', () => {
    const { clans } = setup();
    expect(clans.canRequest(1000, 2000)).toBe(true);
    clans.markRequest(1000);
    expect(clans.canRequest(2500, 2000)).toBe(false);
    expect(clans.canRequest(3001, 2000)).toBe(true);
    clans.markCreate(1000);
    expect(clans.canCreate(2000, 2000)).toBe(false);
    clans.setLocked(true);
    expect(clans.locked).toBe(true);
  });

  it('TEAM_LOCKED says which clans take no requests; ours follows it, a deleted or reused slot forgets it', () => {
    const { bus, clans, roster } = setup();
    bus.emit('handshake', roster([{ guid: 1, team: 50 }, { guid: 2, team: 52 }]));
    expect(clans.isLocked(1)).toBe(false);
    expect(clans.canAskToJoin(1)).toBe(true);

    bus.emit('teamLocked', { clanId: 1, locked: true });
    expect(clans.isLocked(1)).toBe(true);
    expect(clans.canAskToJoin(1)).toBe(false);
    expect(clans.locked).toBe(false); // not our clan

    bus.emit('deleteTeam', { clanId: 1 });
    expect(clans.isLocked(1)).toBe(false);
    expect(clans.canAskToJoin(1)).toBe(false); // nothing there any more

    bus.emit('teamCreated', { clanId: 0, leaderGuid: 1, name: 'ME' });
    bus.emit('teamLocked', { clanId: 0, locked: true });
    expect(clans.locked).toBe(true);
    expect(clans.canAskToJoin(0)).toBe(false); // already in a clan
    bus.emit('teamLocked', { clanId: 0, locked: false });
    expect(clans.locked).toBe(false);
  });

  it('TEAM_INVITE holds one invitation until it is answered, we join a clan, or the clan goes', () => {
    const { bus, clans, roster } = setup();
    bus.emit('handshake', roster([{ guid: 1, team: 50 }, { guid: 2, team: 52 }]));
    bus.emit('teamInvite', { clanId: 1, inviterGuid: 2 });
    expect(clans.invite).toEqual({ clanId: 1, inviterGuid: 2 });
    clans.clearInvite();
    expect(clans.invite).toBeNull();

    bus.emit('teamInvite', { clanId: 1, inviterGuid: 2 });
    bus.emit('deleteTeam', { clanId: 1 });
    expect(clans.invite).toBeNull();

    bus.emit('teamCreated', { clanId: 2, leaderGuid: 3, name: 'ZED' });
    bus.emit('teamInvite', { clanId: 2, inviterGuid: 3 });
    bus.emit('acceptedTeam', { pid: 1, clanId: 2 });
    expect(clans.teamId).toBe(2);
    expect(clans.invite).toBeNull();
    // In a clan: a further invitation is no use to us.
    bus.emit('teamInvite', { clanId: 0, inviterGuid: 3 });
    expect(clans.invite).toBeNull();
  });

  it('validates a clan name the way the server does: 1..max alphanumerics, unique (case-insensitive)', () => {
    const { bus, clans } = setup();
    expect(clans.nameProblem('', 5)).toBe('empty');
    expect(clans.nameProblem('wolf', 5)).toBe('taken');
    expect(clans.nameProblem('W-LF', 5)).toBe('invalid');
    expect(clans.nameProblem('LONGER', 5)).toBe('invalid');
    expect(clans.nameProblem('Fox1', 5)).toBeNull();
    bus.emit('teamCreated', { clanId: 0, leaderGuid: 2, name: 'FOX1' });
    expect(clans.nameProblem('fox1', 5)).toBe('taken');
  });
});
