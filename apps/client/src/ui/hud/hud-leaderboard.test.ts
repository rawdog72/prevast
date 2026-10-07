// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { NetEventBus } from '../../net/events';
import { WorldState, newPlayerInfo } from '../../world/world-state';
import { HudLeaderboard, simplifyNumber } from './hud-leaderboard';

function worldWith(
  names: Record<number, string>,
  own: number,
): { world: WorldState; bus: NetEventBus } {
  const world = new WorldState();
  const bus = new NetEventBus();
  world.attachBus(bus);
  world.ownGuid = own;
  for (const [guid, name] of Object.entries(names)) {
    world.players.set(Number(guid), newPlayerInfo(Number(guid), name));
  }
  return { world, bus };
}

describe('HudLeaderboard (old client _Leaderboard)', () => {
  it('lists the server order, not a local sort, with rank, name, score and karma badge', () => {
    const { world, bus } = worldWith({ 1: 'Alice', 2: 'Bob', 3: 'Carol' }, 2);
    bus.emit('leaderboard', {
      entries: [
        { guid: 3, karma: 0, score: 40 },
        { guid: 1, karma: 3, score: 12345 },
        { guid: 2, karma: 5, score: 7 },
        { guid: 0, karma: 0, score: 0 },
      ],
    });
    const root = document.createElement('div');
    const lb = new HudLeaderboard();
    lb.mount(root);
    lb.update(world, true);

    const rows = Array.from(root.querySelectorAll('.hud-leaderboard-row'));
    expect(rows.map((r) => r.querySelector('.name')!.textContent)).toEqual([
      'Carol',
      'Alice',
      'Bob',
    ]);
    expect(rows.map((r) => r.querySelector('.rank')!.textContent)).toEqual(['1', '2', '3']);
    expect(rows.map((r) => r.querySelector('.score')!.textContent)).toEqual(['40', '12.3k', '7']);
    expect(rows[1].querySelector<HTMLElement>('.karma')!.style.backgroundImage).toContain('karma1');
    expect(rows[2].classList.contains('is-me')).toBe(true);
    expect(root.querySelector('.hud-leaderboard-own')).toBeNull();
  });

  it('lists a guest without a name with a blank name, keeping score and karma', () => {
    const { world, bus } = worldWith({ 1: 'Alice', 2: '' }, 1);
    bus.emit('leaderboard', {
      entries: [
        { guid: 2, karma: 3, score: 900 },
        { guid: 1, karma: 0, score: 10 },
      ],
    });
    const root = document.createElement('div');
    const lb = new HudLeaderboard();
    lb.mount(root);
    lb.update(world, true);
    const rows = Array.from(root.querySelectorAll('.hud-leaderboard-row'));
    expect(rows.map((r) => r.querySelector('.name')!.textContent)).toEqual(['', 'Alice']);
    expect(rows[0].querySelector('.score')!.textContent).toBe('900');
    expect(rows[0].querySelector<HTMLElement>('.karma')!.style.backgroundImage).toContain('karma');
  });

  it('appends our own row (own score + karma) when we are outside the top list', () => {
    const { world, bus } = worldWith({ 1: 'Alice', 2: 'Me' }, 2);
    bus.emit('leaderboard', { entries: [{ guid: 1, karma: 0, score: 500 }] });
    bus.emit('score', { score: 1250 });
    bus.emit('karma', { clientIcon: 2 });
    const root = document.createElement('div');
    const lb = new HudLeaderboard();
    lb.mount(root);
    lb.update(world, true);

    const own = root.querySelector<HTMLElement>('.hud-leaderboard-own')!;
    expect(own).not.toBeNull();
    expect(own.querySelector('.name')!.textContent).toBe('Me');
    expect(own.querySelector('.score')!.textContent).toBe('1250');
    expect(own.querySelector<HTMLElement>('.karma')!.style.backgroundImage).toContain('karma2');
    expect(own.classList.contains('is-me')).toBe(true);
  });

  it('hides while empty or toggled off, and re-renders when the list changes', () => {
    const { world, bus } = worldWith({ 1: 'Alice' }, 1);
    const root = document.createElement('div');
    const lb = new HudLeaderboard();
    lb.mount(root);
    lb.update(world, true);
    expect(root.hidden).toBe(true);

    bus.emit('leaderboard', { entries: [{ guid: 1, karma: 0, score: 1 }] });
    lb.update(world, true);
    expect(root.hidden).toBe(false);
    lb.update(world, false);
    expect(root.hidden).toBe(true);
  });

  it('is titled with the server we are on, falling back to "Leaderboard" until one is set', () => {
    const { world, bus } = worldWith({ 1: 'Alice' }, 1);
    bus.emit('leaderboard', { entries: [{ guid: 1, karma: 0, score: 1 }] });
    const root = document.createElement('div');
    const lb = new HudLeaderboard();
    lb.mount(root);
    lb.update(world, true);
    expect(root.querySelector('.hud-leaderboard-title')!.textContent).toBe('Leaderboard');
    lb.setTitle('Europe #2');
    lb.update(world, true);
    expect(root.querySelector('.hud-leaderboard-title')!.textContent).toBe('Europe #2');
  });

  it('simplifyNumber matches the old client', () => {
    expect(simplifyNumber(1250)).toBe('1250');
    expect(simplifyNumber(12345)).toBe('12.3k');
    expect(simplifyNumber(123456)).toBe('123k');
    expect(simplifyNumber(10000)).toBe('10k');
    expect(simplifyNumber(1500000)).toBe('1500k');
  });

  it('lets go of its permanent root on unmount, so the next game takes it over alone', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div data-guid="7"><span class="name">Zed</span></div>';
    const first = new HudLeaderboard();
    const second = new HudLeaderboard();
    first.onPlayerDoubleClick = vi.fn();
    second.onPlayerDoubleClick = vi.fn();
    first.mount(root);
    first.unmount();
    second.mount(root);
    root.querySelector('.name')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(first.onPlayerDoubleClick).not.toHaveBeenCalled();
    expect(second.onPlayerDoubleClick).toHaveBeenCalledWith(7);
  });
});
