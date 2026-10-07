// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeSelect } from './home-select';

let picker: HomeSelect;
afterEach(() => picker?.close());

function build() {
  document.body.innerHTML = `<main><label for="mode">Game mode</label><select id="mode">
    <option value="a" data-detail="First world">Alpha</option>
    <option value="b" disabled>Bravo</option>
    <option value="c">Charlie</option><option value="d">Delta</option>
  </select><button id="outside">Next</button></main>`;
  const select = document.querySelector('select')!;
  const changed = vi.fn();
  select.addEventListener('change', changed);
  picker = new HomeSelect(select, document.querySelector('main')!);
  const menu = document.querySelector<HTMLElement>('[role="listbox"]')!;
  const key = (key: string) =>
    picker.trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  const active = () =>
    document.getElementById(picker.trigger.getAttribute('aria-activedescendant') ?? '');
  return { select, changed, menu, key, active };
}

describe('HomeSelect', () => {
  it('browses with arrows, skips disabled options and only commits on Enter', () => {
    const { select, changed, key, active } = build();
    picker.trigger.focus();
    key('ArrowDown');
    expect(picker.isOpen).toBe(true);
    key('ArrowDown');
    expect(active()?.textContent).toContain('Charlie');
    expect(select.value).toBe('a');
    key('Enter');
    expect(select.value).toBe('c');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(picker.isOpen).toBe(false);
    expect(document.activeElement).toBe(picker.trigger);
    expect(picker.trigger.textContent).toContain('Charlie');
  });

  it('cancels on Escape, closes on Tab and outside focus without committing', () => {
    const { select, changed, key } = build();
    picker.open();
    key('End');
    key('Escape');
    expect(picker.isOpen).toBe(false);
    expect(select.value).toBe('a');
    picker.open();
    key('Tab');
    expect(picker.isOpen).toBe(false);
    picker.open();
    document.querySelector<HTMLButtonElement>('#outside')!.focus();
    expect(picker.isOpen).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it('supports typeahead and Home/End, and ignores disabled mouse choices', () => {
    const { select, key, active, changed } = build();
    key('c');
    expect(active()?.textContent).toContain('Charlie');
    key('End');
    expect(active()?.textContent).toContain('Delta');
    key('Home');
    expect(active()?.textContent).toContain('Alpha');
    document.querySelector<HTMLElement>('[aria-disabled="true"]')!.click();
    expect(select.value).toBe('a');
    expect(changed).not.toHaveBeenCalled();
    key('End');
    active()!.click();
    expect(select.value).toBe('d');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('keeps row identity and keyboard position during updates, then handles removal and reordering', () => {
    const { select, key, active, menu } = build();
    picker.open();
    key('End');
    const row = active();
    select.options[3].dataset.detail = '12/40 players';
    picker.sync();
    expect(active()).toBe(row);
    expect(row?.textContent).toContain('12/40 players');
    select.prepend(select.options[3]);
    picker.sync();
    expect(menu.querySelector('[role="option"]')).toBe(row);
    select.options[0].remove();
    picker.sync();
    expect(active()?.textContent).toContain('Alpha');
    expect(row?.isConnected).toBe(false);
  });

  it('closes when disabled and can reopen an empty list safely', () => {
    const { select, menu, key } = build();
    picker.open();
    select.disabled = true;
    picker.sync();
    expect(picker.trigger.disabled).toBe(true);
    expect(picker.isOpen).toBe(false);
    expect(menu.inert).toBe(true);
    picker.open();
    expect(picker.isOpen).toBe(false);
    select.disabled = false;
    select.replaceChildren();
    picker.sync();
    key('ArrowDown');
    key('Enter');
    expect(picker.trigger.hasAttribute('aria-activedescendant')).toBe(false);
    expect(menu.textContent).toContain('No options available');
  });

  it('dismisses on an outside pointer and closes and reopens immediately', () => {
    const { menu } = build();
    picker.trigger.click();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(picker.isOpen).toBe(false);
    picker.trigger.click();
    expect(picker.isOpen).toBe(true);
    expect(menu.getAttribute('aria-hidden')).toBe('false');
    expect(picker.trigger.getAttribute('aria-expanded')).toBe('true');
  });
});
