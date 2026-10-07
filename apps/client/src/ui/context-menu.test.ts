// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ContentStore } from '../content/store';
import { MODS_IID, modsContent } from '../world/weapon-mods.fixtures';
import { ContextMenu, itemLookText } from './context-menu';
import { HudStatusLine } from './hud/hud-status-line';

function content(): ContentStore {
  const store = new ContentStore();
  store.load({
    name: 'items',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      orange: {
        key: 'orange',
        id: 10,
        clientItemId: 10,
        name: 'Orange',
        properties: { stack: 10 },
        decay: { transformTo: 'rotten_orange', timeMs: 840000 },
        client: { icon: 'inv-orange', description: 'Juicy' },
      },
      stone: {
        key: 'stone',
        id: 2,
        clientItemId: 2,
        name: 'Stone',
        properties: { stack: 255 },
        client: { icon: 'inv-stone', description: 'Find it on the ground.' },
      },
    },
  });
  return store;
}

describe('itemLookText', () => {
  it('reads like a Tibia look: article, stack, description and freshness', () => {
    expect(itemLookText({ iid: 10, uid: 1, count: 3, ammo: 128 }, content())).toBe(
      'You see an Orange (x3). Juicy. Freshness 50%.',
    );
    expect(itemLookText({ iid: 2, uid: 2, count: 1, ammo: 0 }, content())).toBe(
      'You see a Stone. Find it on the ground.',
    );
  });
});

describe('itemLookText with mods', () => {
  it('names what is fitted', () => {
    expect(
      itemLookText({ iid: MODS_IID.gun, uid: 7, count: 1, ammo: 12 }, modsContent(), [
        { slot: 0, iid: MODS_IID.mag30 },
        { slot: 1, iid: MODS_IID.scope },
      ]),
    ).toBe(
      'You see a SMG Tactical. SMG Tactical. Damage: 18. Ammo 12/30. Fitted: SMG 30-round magazine, Tube scope.',
    );
  });
});

describe('ContextMenu', () => {
  it('runs an entry, keeps disabled ones inert and closes on a click outside', () => {
    const menu = new ContextMenu(),
      look = vi.fn(),
      open = vi.fn();
    menu.open(
      'Wooden Door',
      [
        { label: 'Look', action: look },
        { label: 'Open — move closer', action: open, disabled: true },
      ],
      20,
      20,
    );
    const buttons = document.querySelectorAll<HTMLButtonElement>('.dv-context-menu button');
    expect(buttons[1].disabled).toBe(true);
    buttons[0].click();
    expect(look).toHaveBeenCalledOnce();
    expect(menu.isOpen).toBe(false);

    // An entry that depends on reach follows the player while the menu is open.
    let near = false;
    const reach = () => ({ label: near ? 'Open' : 'Open — move closer', disabled: !near });
    menu.open('Wooden Door', [{ ...reach(), refresh: reach, action: open }], 20, 20);
    const live = document.querySelector<HTMLButtonElement>('.dv-context-menu button')!;
    expect(live.disabled).toBe(true);
    near = true;
    menu.update();
    expect(live.textContent).toBe('Open');
    expect(live.disabled).toBe(false);
    live.click();
    expect(open).toHaveBeenCalledOnce();

    menu.open('Wooden Door', [{ label: 'Look', action: look }], 20, 20);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menu.isOpen).toBe(false);

    menu.destroy();
    expect(document.querySelector('.dv-context-menu')).toBeNull();
  });
});

describe('HudStatusLine', () => {
  it('shows the newest line and fades it after a few seconds', () => {
    vi.useFakeTimers();
    const parent = document.createElement('div'),
      line = new HudStatusLine();
    line.mount(parent);
    line.show('You see a wooden wall.');
    line.show('You see a tree.');
    expect(line.text).toBe('You see a tree.');
    vi.advanceTimersByTime(3999);
    expect(line.text).toBe('You see a tree.');
    vi.advanceTimersByTime(1);
    expect(line.text).toBe('');
    line.show('It is locked.', true);
    expect(parent.querySelector('.hud-status-line')!.classList.contains('is-failure')).toBe(true);
    line.destroy();
    vi.useRealTimers();
  });
});
