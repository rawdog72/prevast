// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ContentStore } from '../../content/store';
import { InventoryStore } from '../../world/inventory-store';
import { WorldState } from '../../world/world-state';
import { DeathWindow } from './death-window';

function setup(items = true) {
  const inventory = new InventoryStore();
  inventory.level = 7;
  inventory.kills = 3;
  inventory.isDead = true;
  inventory.deathItems = items
    ? [
        { iid: 15, count: 1, uid: 4, ammo: 0 },
        { iid: 2, count: 20, uid: 5, ammo: 0 },
      ]
    : [];
  const world = new WorldState();
  world.ownScore = 12345;
  const content = new ContentStore();
  content.load({
    name: 'items',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      stone: {
        key: 'stone',
        id: 2,
        clientItemId: 2,
        name: 'Stone',
        properties: { stack: 255 },
        client: { icon: 'inv-stone' },
      },
      hatchet: {
        key: 'hatchet',
        id: 15,
        clientItemId: 15,
        name: 'Hatchet',
        properties: { stack: 1 },
        client: { icon: 'inv-hachet' },
      },
    },
  });
  const callbacks = { onPlayAgain: vi.fn(), onMainMenu: vi.fn() };
  const body = document.createElement('div');
  const win = new DeathWindow();
  win.mount(body, inventory, world, content, callbacks);
  return { body, callbacks, win, inventory, world, content };
}

describe('DeathWindow (GameUI.death)', () => {
  it('shows Level / Score / Kills tiles, the items carried at death, and the respawn level', () => {
    const { body } = setup();
    const tiles = Array.from(body.querySelectorAll('.dv-death-tile'));
    expect(tiles.map((t) => t.querySelector('.dv-label')!.textContent)).toEqual([
      'Level',
      'Score',
      'Kills',
    ]);
    expect(tiles.map((t) => t.querySelector('.value')!.textContent)).toEqual(['7', '12.3k', '3']);
    expect(tiles[1].classList.contains('is-active')).toBe(true);
    expect(body.querySelectorAll('.dv-death-items .dv-item-slot')).toHaveLength(2);
    expect(body.querySelector('.dv-death-respawn')!.textContent).toBe('Respawn level 3');
  });

  it('Play again and Main menu call back; Play again shows Connecting while pending; an error line can be set', () => {
    const { body, callbacks, win } = setup(false);
    expect(body.querySelector('.dv-death-items')).toBeNull();
    const play = body.querySelector<HTMLButtonElement>('button.dv-death-play')!;
    play.click();
    expect(callbacks.onPlayAgain).toHaveBeenCalled();
    expect(play.textContent).toBe('Connecting…');
    expect(play.disabled).toBe(true);
    body.querySelector<HTMLButtonElement>('button.dv-death-menu')!.click();
    expect(callbacks.onMainMenu).toHaveBeenCalled();
    win.setError('Server full');
    expect(body.querySelector('.dv-death-error')!.textContent).toBe('Server full');
    expect(play.disabled).toBe(false);
  });
});
