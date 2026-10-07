// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { NetEventBus } from '../../net/events';
import { ClanStore } from '../../world/clan-store';
import { WorldState } from '../../world/world-state';
import { HudInvitation } from './hud-invitation';

function setup() {
  const world = new WorldState();
  const bus = new NetEventBus();
  world.attachBus(bus);
  const clans = new ClanStore(world);
  clans.attachBus(bus);
  bus.emit('nicknames', { names: [null, 'Me', 'Bob', 'Zed'], sessionToken: '' });
  bus.emit('teamNames', { names: ['', ''] });
  bus.emit('handshake', {
    ownGuid: 1,
    unitsPerPlayer: 12,
    playerCount: 255,
    modeId: 0,
    players: [
      { guid: 1, team: 51 },
      { guid: 2, team: 50 },
      { guid: 3, team: 50 },
    ].map((p) => ({
      ...p,
      repellent: 0,
      withdrawal: 0,
      ghoul: 0,
      tokenId: 1000 + p.guid,
      score: 0,
    })),
  });
  const root = document.createElement('div');
  const onAccept = vi.fn();
  const onAcceptInvite = vi.fn();
  const card = new HudInvitation();
  card.mount(root, { onAccept, onAcceptInvite });
  return { world, bus, clans, root, card, onAccept, onAcceptInvite };
}

describe('HudInvitation (GameUI.invitation)', () => {
  it('is hidden until the leader has a pending request, then shows name, +N waiting, Accept / Decline', () => {
    const { bus, clans, root, card, onAccept } = setup();
    card.update(clans);
    expect(root.hidden).toBe(true);

    bus.emit('joinTeam', { pid: 2 });
    bus.emit('joinTeam', { pid: 3 });
    card.update(clans);
    expect(root.hidden).toBe(false);
    expect(root.querySelector('.dv-invite-name')!.textContent).toBe('Bob');
    expect(root.querySelector('.dv-invite-waiting')!.textContent).toBe('+1 waiting');

    root.querySelector<HTMLButtonElement>('button.dv-invite-accept')!.click();
    expect(onAccept).toHaveBeenCalledWith(2);
    card.update(clans);
    expect(root.querySelector('.dv-invite-name')!.textContent).toBe('Zed');
    expect(root.querySelector('.dv-invite-waiting')!.textContent).toBe('');

    root.querySelector<HTMLButtonElement>('button.dv-invite-decline')!.click();
    card.update(clans);
    expect(root.hidden).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('shows an invitation to a player with no clan: clan name, who invites, Accept sends it, Decline drops it', () => {
    const { bus, clans, root, card, onAcceptInvite } = setup();
    bus.emit('kickedTeam', { pid: 1 });
    bus.emit('teamCreated', { clanId: 1, leaderGuid: 2, name: 'WOLF' });
    bus.emit('teamInvite', { clanId: 1, inviterGuid: 2 });
    card.update(clans);
    expect(root.hidden).toBe(false);
    expect(root.querySelector('.dv-invite-head .dv-label')!.textContent).toBe('Clan invitation');
    expect(root.querySelector('.dv-invite-name')!.textContent).toBe('WOLF');
    expect(root.querySelector('.dv-invite-sub')!.textContent).toBe('Bob invites you to join');
    root.querySelector<HTMLButtonElement>('button.dv-invite-accept')!.click();
    expect(onAcceptInvite).toHaveBeenCalledWith(1);
    card.update(clans);
    expect(root.hidden).toBe(true);

    bus.emit('teamInvite', { clanId: 1, inviterGuid: 2 });
    card.update(clans);
    root.querySelector<HTMLButtonElement>('button.dv-invite-decline')!.click();
    card.update(clans);
    expect(root.hidden).toBe(true);
    expect(onAcceptInvite).toHaveBeenCalledTimes(1);
  });

  it('never shows for a non-leader', () => {
    const { bus, clans, root, card } = setup();
    bus.emit('kickedTeam', { pid: 1 });
    bus.emit('joinTeam', { pid: 2 });
    card.update(clans);
    expect(root.hidden).toBe(true);
  });
});
