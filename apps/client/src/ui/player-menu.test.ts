// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import { NetEventBus } from '../net/events';
import { ClanStore } from '../world/clan-store';
import { WorldState } from '../world/world-state';
import { playerMenuEntries, type PlayerMenuActions } from './player-menu';

// team byte: 50 = no clan, 50 + id + 1 = leader of clan id, id = member of clan id.
function setup(players: { guid: number; team: number; ghoul?: number }[]) {
  const world = new WorldState();
  const bus = new NetEventBus();
  world.attachBus(bus);
  const clans = new ClanStore(world);
  clans.attachBus(bus);
  bus.emit('nicknames', { names: [null, 'Me', 'Bob', 'Zed'], sessionToken: '' });
  bus.emit('teamNames', { names: ['', 'WOLF', ''] });
  bus.emit('handshake', {
    ownGuid: 1,
    unitsPerPlayer: 12,
    playerCount: 255,
    modeId: 0,
    players: players.map((p) => ({
      ghoul: 0,
      ...p,
      repellent: 0,
      withdrawal: 0,
      tokenId: 1000 + p.guid,
      score: 0,
    })),
  });
  const actions: PlayerMenuActions = {
    message: vi.fn(),
    invite: vi.fn(),
    askToJoin: vi.fn(),
    block: vi.fn(),
  };
  const entries = (pid: number, now = 100000) =>
    playerMenuEntries(pid, world, clans, actions, { now, clanDelayMs: 2000 });
  const labels = (pid: number, now?: number) => entries(pid, now).map((e) => e.label);
  return { world, bus, clans, actions, entries, labels };
}

describe('playerMenuEntries (right-click on a player)', () => {
  it('offers a private message and Block; nothing at all on ourselves', () => {
    const { actions, entries, labels } = setup([
      { guid: 1, team: 50 },
      { guid: 2, team: 50 },
    ]);
    expect(labels(1)).toEqual([]);
    expect(labels(2)).toEqual(['Private message', 'Block']);
    entries(2)[0]!.action();
    expect(actions.message).toHaveBeenCalledWith(2);
    entries(2)[1]!.action();
    expect(actions.block).toHaveBeenCalledWith(2, true);
  });

  it('turns Block into Unblock for a player the server says we blocked', () => {
    const { bus, actions, entries, labels } = setup([
      { guid: 1, team: 50 },
      { guid: 2, team: 50 },
    ]);
    bus.emit('blockedPlayers', { guids: [2] });
    expect(labels(2)).toEqual(['Private message', 'Unblock']);
    entries(2)[1]!.action();
    expect(actions.block).toHaveBeenCalledWith(2, false);
  });

  it('a clan leader may invite a player with no clan, but not a clan member or a ghoul', () => {
    const { clans, actions, entries, labels } = setup([
      { guid: 1, team: 52 }, // we lead WOLF
      { guid: 2, team: 50 },
      { guid: 3, team: 1 },
    ]);
    expect(clans.isLeader).toBe(true);
    expect(labels(2)).toEqual(['Private message', 'Invite to WOLF', 'Block']);
    expect(labels(3)).toEqual(['Private message', 'Block']);
    entries(2)[1]!.action();
    expect(actions.invite).toHaveBeenCalledWith(2);
    // The server's clan delay: greyed out right after, back once it has passed.
    expect(entries(2, 100500)[1]!.disabled).toBe(true);
    expect(entries(2, 102500)[1]!.disabled).toBe(false);

    const ghoul = setup([
      { guid: 1, team: 52 },
      { guid: 2, team: 50, ghoul: 1 },
    ]);
    expect(ghoul.labels(2)).toEqual(['Private message', 'Block']);
  });

  it('with no clan, a click on an open clan leader asks to join; a locked clan offers nothing', () => {
    const { bus, actions, entries, labels } = setup([
      { guid: 1, team: 50 },
      { guid: 2, team: 52 }, // Bob leads WOLF
      { guid: 3, team: 1 }, // Zed is a WOLF member
    ]);
    expect(labels(2)).toEqual(['Private message', 'Ask to join WOLF', 'Block']);
    expect(labels(3)).toEqual(['Private message', 'Block']);
    entries(2)[1]!.action();
    expect(actions.askToJoin).toHaveBeenCalledWith(1);
    expect(entries(2, 100500)[1]!.disabled).toBe(true);

    bus.emit('teamLocked', { clanId: 1, locked: true });
    expect(labels(2)).toEqual(['Private message', 'Block']);
  });

  it('a ghoul gets no clan entries (the server refuses a ghoul every team opcode)', () => {
    const { labels } = setup([
      { guid: 1, team: 50, ghoul: 1 },
      { guid: 2, team: 52 },
    ]);
    expect(labels(2)).toEqual(['Private message', 'Block']);
  });
});
