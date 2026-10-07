// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { NetEventBus } from '../../net/events';
import { ClanStore } from '../../world/clan-store';
import { WorldState } from '../../world/world-state';
import { ClanWindow, type ClanWindowCallbacks } from './clan-window';

function setup(own = 1) {
  const world = new WorldState();
  const bus = new NetEventBus();
  world.attachBus(bus);
  const clans = new ClanStore(world);
  clans.attachBus(bus);
  bus.emit('nicknames', { names: [null, 'Me', 'Bob', 'Zed'], sessionToken: '' });
  bus.emit('teamNames', { names: ['', 'WOLF', '', '', '', '', '', ''] });
  bus.emit('handshake', {
    ownGuid: own,
    unitsPerPlayer: 12,
    playerCount: 255,
    modeId: 0,
    players: [1, 2, 3].map((guid) => ({
      guid,
      team: 50,
      repellent: 0,
      withdrawal: 0,
      ghoul: 0,
      tokenId: 1000 + guid,
      score: 0,
    })),
  });
  bus.emit('teamCreated', { clanId: 1, leaderGuid: 2, name: 'WOLF' });
  bus.emit('acceptedTeam', { pid: 2, clanId: 1 });

  const callbacks: ClanWindowCallbacks = {
    onCreate: vi.fn(),
    onRequest: vi.fn(),
    onKick: vi.fn(),
    onLock: vi.fn(),
    onUnlock: vi.fn(),
    onDelete: vi.fn(),
    onLeave: vi.fn(),
  };
  const body = document.createElement('div');
  const head = { title: document.createElement('h2'), sub: document.createElement('div') };
  const win = new ClanWindow();
  const rules = { nameMaxLength: 5, actionDelayMs: 2000, now: () => 100000 };
  return { world, bus, clans, callbacks, body, head, win, rules };
}

describe('ClanWindow (GameUI.clan)', () => {
  it('browse mode: name input + Create, and a Request button per listed clan', () => {
    const { clans, callbacks, body, head, win, rules } = setup();
    win.mount(body, head, clans, rules, callbacks);

    expect(head.title.textContent).toBe('Teams & clan');
    const input = body.querySelector<HTMLInputElement>('input.dv-clan-name')!;
    const create = body.querySelector<HTMLButtonElement>('button.dv-clan-create')!;
    expect(create.disabled).toBe(true); // empty name

    input.value = 'fox';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(create.disabled).toBe(false);
    create.click();
    expect(callbacks.onCreate).toHaveBeenCalledWith('fox');

    input.value = 'wolf'; // taken (case-insensitive)
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(create.disabled).toBe(true);

    const rows = body.querySelectorAll('.dv-clan-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.name')!.textContent).toBe('WOLF');
    rows[0].querySelector<HTMLButtonElement>('button')!.click();
    expect(callbacks.onRequest).toHaveBeenCalledWith(1);
  });

  it('browse mode: a locked clan reads Invite only and takes no request', () => {
    const { bus, clans, callbacks, body, head, win, rules } = setup();
    bus.emit('teamLocked', { clanId: 1, locked: true });
    win.mount(body, head, clans, rules, callbacks);
    const request = body.querySelector<HTMLButtonElement>('.dv-clan-row button')!;
    expect(request.textContent).toBe('Invite only');
    expect(request.disabled).toBe(true);

    bus.emit('teamLocked', { clanId: 1, locked: false });
    win.refresh(clans, rules, callbacks);
    const reopened = body.querySelector<HTMLButtonElement>('.dv-clan-row button')!;
    expect(reopened.textContent).toBe('Request');
    expect(reopened.disabled).toBe(false);
  });

  it('member mode: clan name as title, owner card, member cards, Leave for a member', () => {
    const { bus, clans, callbacks, body, head, win, rules } = setup();
    bus.emit('acceptedTeam', { pid: 1, clanId: 1 });
    bus.emit('acceptedTeam', { pid: 3, clanId: 1 });
    win.mount(body, head, clans, rules, callbacks);

    expect(head.title.textContent).toBe('WOLF');
    expect(head.sub.textContent).toBe('3 members');
    expect(body.querySelector('.dv-clan-owner .name')!.textContent).toBe('Bob');
    const cards = Array.from(body.querySelectorAll('.dv-clan-member'));
    expect(cards.map((c) => c.querySelector('.name')!.textContent)).toEqual(['Me', 'Zed']);
    expect(cards[0].querySelector('.role')!.textContent).toBe('You');
    expect(body.querySelector('.dv-clan-kick')).toBeNull();
    expect(body.querySelector('.dv-clan-delete')).toBeNull();
    body.querySelector<HTMLButtonElement>('button.dv-clan-leave')!.click();
    expect(callbacks.onLeave).toHaveBeenCalled();
  });

  it('leader mode: OWNER / YOU, Remove per member, lock toggle with hint, Delete clan', () => {
    const { bus, clans, callbacks, body, head, win, rules } = setup(2);
    bus.emit('acceptedTeam', { pid: 3, clanId: 1 });
    win.mount(body, head, clans, rules, callbacks);

    expect(body.querySelector('.dv-clan-owner .role')!.textContent).toContain('YOU');
    expect(body.querySelector('.dv-clan-status')!.textContent).toBe('Open to requests');
    const kick = body.querySelector<HTMLButtonElement>('.dv-clan-member button.dv-clan-kick')!;
    kick.click();
    expect(callbacks.onKick).toHaveBeenCalledWith(3);

    const lock = body.querySelector<HTMLButtonElement>('button.dv-clan-lock')!;
    expect(lock.getAttribute('data-hint')).toBe('Lock team');
    lock.click();
    expect(callbacks.onLock).toHaveBeenCalled();
    clans.setLocked(true);
    win.refresh(clans, rules, callbacks);
    expect(body.querySelector('.dv-clan-status')!.textContent).toBe('Invite only');
    expect(
      body.querySelector<HTMLButtonElement>('button.dv-clan-lock')!.getAttribute('data-hint'),
    ).toBe('Unlock team');

    body.querySelector<HTMLButtonElement>('button.dv-clan-delete')!.click();
    expect(callbacks.onDelete).toHaveBeenCalled();
    expect(body.querySelector('.dv-clan-leave')).toBeNull();
  });

  it('greys Request out during the request delay, and Remove / lock during the manage delay', () => {
    const { clans, callbacks, body, head, win, rules } = setup();
    clans.markRequest(99500);
    win.mount(body, head, clans, rules, callbacks);
    expect(body.querySelector<HTMLButtonElement>('.dv-clan-row button')!.disabled).toBe(true);

    const leader = setup(2);
    leader.bus.emit('acceptedTeam', { pid: 3, clanId: 1 });
    leader.clans.markManage(99500);
    leader.win.mount(leader.body, leader.head, leader.clans, leader.rules, leader.callbacks);
    expect(leader.body.querySelector<HTMLButtonElement>('button.dv-clan-kick')!.disabled).toBe(
      true,
    );
    expect(leader.body.querySelector<HTMLButtonElement>('button.dv-clan-lock')!.disabled).toBe(
      true,
    );
  });
});
