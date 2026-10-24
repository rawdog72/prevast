// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ContentStore } from '../../content/store';
import { NetEventBus } from '../../net/events';
import { InventoryStore } from '../../world/inventory-store';
import { UpgradeWindow, formatUpgradeTime, type UpgradeWindowCallbacks } from './upgrade-window';

function content(): ContentStore {
  const store = new ContentStore();
  store.load({
    name: 'items',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      stone: { key: 'stone', id: 2, clientItemId: 2, name: 'Stone', properties: { stack: 255 } },
      wood_wall: {
        key: 'wood_wall',
        id: 27,
        clientItemId: 27,
        name: 'Wooden Wall',
        properties: { stack: 255 },
        skill: { type: 'building' },
        crafting: {
          recipe: { ingredient: [{ itemKey: 'wood', amount: 20 }] },
          stations: { station: [{ key: 'workbench', timeMs: 10000 }] },
        },
        client: { icon: 'inv-wood-wall' },
      },
      stone_wall: {
        key: 'stone_wall',
        id: 28,
        clientItemId: 28,
        name: 'Stone Wall',
        properties: { stack: 255 },
        skill: { type: 'building', requiredLevel: 3, skillCost: 1 },
        crafting: {
          recipe: { ingredient: [{ itemKey: 'stone', amount: 20 }] },
          stations: { station: [{ key: 'workbench', timeMs: 15000 }] },
        },
        client: { icon: 'inv-stone-wall' },
      },
    },
  });
  store.load({
    name: 'objects',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      wood_wall: {
        key: 'wood_wall',
        category: 'wall',
        healthMax: 3000,
        layer: 'top',
        upgrade: { to: 'stone_wall', durationMs: 30000 },
      },
      stone_wall: { key: 'stone_wall', category: 'wall', healthMax: 7000, layer: 'top' },
    },
  });
  return store;
}

function setup(opts: { stone?: number; unlocked?: boolean; level?: number } = {}) {
  const store = content();
  const inventory = new InventoryStore();
  const bus = new NetEventBus();
  inventory.attachBus(bus);
  inventory.level = opts.level ?? 3;
  if (opts.unlocked ?? true) inventory.unlockedSkills.add(28);
  inventory.setAllSlots([{ iid: 2, count: opts.stone ?? 25, uid: 1, ammo: 0 }]);
  const state = (running: boolean, remainingMs = 0, firstOpen = false) =>
    bus.emit('upgradeState', {
      firstOpen,
      entityId: 77,
      iid: 27,
      targetIid: 28,
      running,
      durationMs: 30000,
      remainingMs,
    });
  state(false, 0, true);
  const callbacks: UpgradeWindowCallbacks = { onStart: vi.fn(), onCancel: vi.fn() };
  const body = document.createElement('div');
  const head = { title: document.createElement('h2'), sub: document.createElement('div') };
  const win = new UpgradeWindow();
  let now = Date.now();
  win.mount(body, head, store, inventory, callbacks, { now: () => now });
  const at = (t: number) => {
    now = t;
    win.refresh(store, inventory, callbacks, { now: () => now });
  };
  const button = () => body.querySelector<HTMLButtonElement>('.dv-craft-actions .dv-btn')!;
  return { store, inventory, bus, callbacks, body, head, win, state, at, button, now: () => now };
}

describe('UpgradeWindow', () => {
  it('shows what it is, what it becomes and the target recipe as the cost', () => {
    const { body, head, button } = setup();
    expect(head.title.textContent).toBe('Upgrade');
    const names = Array.from(body.querySelectorAll('.dv-upgrade-piece .name')).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(['Wooden Wall', 'Stone Wall']);
    const meta = Array.from(body.querySelectorAll('.dv-upgrade-piece .dv-craft-preview-meta')).map(
      (n) => n.textContent,
    );
    expect(meta).toEqual(['Life: 3000', 'Life: 7000']);
    expect(body.querySelector('.dv-craft-ing-count')!.textContent).toBe('25/20');
    expect(button().textContent).toBe('Upgrade · 30 s');
    expect(button().disabled).toBe(false);
  });

  it('sends START_UPGRADE from the button', () => {
    const { button, callbacks } = setup();
    button().click();
    expect(callbacks.onStart).toHaveBeenCalledTimes(1);
  });

  it('greys the button out when the materials are short', () => {
    const { body, button } = setup({ stone: 5 });
    expect(button().disabled).toBe(true);
    expect(body.querySelector('.dv-craft-ing')!.classList.contains('is-short')).toBe(true);
    expect(body.querySelector('.dv-craft-reason')!.textContent).toBe('Missing materials');
  });

  it('needs the target tier unlocked, like crafting it would', () => {
    const { body, button } = setup({ unlocked: false, level: 1 });
    expect(button().disabled).toBe(true);
    const reasons = Array.from(body.querySelectorAll('.dv-craft-reason')).map((r) => r.textContent);
    expect(reasons).toEqual(['Unlock Stone Wall first', 'Require level 3 or higher']);
  });

  it('turns the action into a stop gauge counting down while it runs', () => {
    const { state, at, button, callbacks, inventory } = setup();
    const t0 = 1_000_000;
    state(true, 20000);
    inventory.upgrade!.statedAt = t0;
    at(t0 + 5000);
    expect(button().classList.contains('dv-craft-progress')).toBe(true);
    expect(button().disabled).toBe(false);
    expect(button().querySelector('.dv-craft-progress-text')!.textContent).toBe('Stop · 15 s');
    button().click();
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
    at(t0 + 25000);
    expect(button().querySelector('.dv-craft-progress-text')!.textContent).toBe('Finishing…');
  });

  it('is cleared when the server takes the window away', () => {
    const { bus, inventory } = setup();
    expect(inventory.upgrade).not.toBeNull();
    bus.emit('lostBuilding', undefined as unknown as void);
    expect(inventory.upgrade).toBeNull();
  });

  it('ignores an update for a window already closed', () => {
    const { inventory, state } = setup();
    inventory.closeContainers();
    state(true, 1000);
    expect(inventory.upgrade).toBeNull();
  });

  it('formats times like the craft window, minutes past a minute', () => {
    expect(formatUpgradeTime(4500)).toBe('4.5 s');
    expect(formatUpgradeTime(30000)).toBe('30 s');
    expect(formatUpgradeTime(80000)).toBe('1:20');
  });
});
