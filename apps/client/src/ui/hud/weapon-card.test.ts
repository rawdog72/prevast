// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODS_IID, modsContent } from '../../world/weapon-mods.fixtures';
import { hoverCard, itemCard, renderItemCard } from './weapon-card';

describe('itemCard', () => {
  const content = modsContent();

  it('shows a modded gun`s resolved stats and what is fitted, in slot order', () => {
    const card = itemCard(content, {
      iid: MODS_IID.gun,
      ammo: 12,
      count: 1,
      mods: [
        { slot: 1, iid: MODS_IID.scope },
        { slot: 0, iid: MODS_IID.mag40 },
      ],
    })!;
    expect(card.name).toBe('SMG Tactical');
    expect(card.stat).toBe('');
    expect(card.lines).toEqual([
      'Damage 18 · 600 rpm · Magazine 12/40',
      'Spread 4.6° · Range 900',
      'Magazine: SMG 40-round magazine',
      'Optic: Tube scope',
    ]);
  });

  it('leaves items that take no mods as they were', () => {
    const card = itemCard(content, { iid: MODS_IID.bandage, ammo: 0, count: 2, mods: [] })!;
    expect(card.lines).toEqual([]);
  });
});

describe('renderItemCard and hoverCard', () => {
  it('renders the lines under the name', () => {
    const el = document.createElement('div');
    renderItemCard(el, {
      name: 'SMG Tactical',
      description: 'Mods.',
      stat: '',
      lines: ['Optic: Tube scope'],
    });
    expect(el.querySelector('.hud-item-tooltip-name')!.textContent).toBe('SMG Tactical');
    expect([...el.querySelectorAll('.hud-item-tooltip-line')].map((n) => n.textContent)).toEqual([
      'Optic: Tube scope',
    ]);
  });

  it('shows over a hovered slot and hides when the pointer leaves', () => {
    const content = modsContent();
    const slot = document.createElement('div');
    document.body.append(slot);
    hoverCard().attach(slot, content, () => ({
      iid: MODS_IID.gun,
      ammo: 0,
      count: 1,
      mods: [],
    }));
    slot.dispatchEvent(new Event('pointerenter'));
    const card = document.querySelector<HTMLElement>('.dv-hover-card')!;
    expect(card.hidden).toBe(false);
    expect(card.textContent).toContain('SMG Tactical');
    slot.dispatchEvent(new Event('pointerleave'));
    expect(card.hidden).toBe(true);
  });
});

describe('card styles', () => {
  // jsdom computes no styles from linked sheets, so this reads the rules from the source.
  const css = readFileSync('apps/client/public/css/hud.css', 'utf8');
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('gives the body-level hover card the text context .hud-root gives the hotbar card', () => {
    const card = rule('.dv-hover-card');
    expect(card).toContain('color: var(--dv-text)');
    expect(card).toContain('font: 13px/1.35 var(--dv-font)');
    expect(card).toContain('box-sizing: border-box');
    expect(rule('.dv-hover-card *')).toContain('box-sizing: border-box');
  });

  it('lets the lines wrap inside the fixed-width card', () => {
    expect(rule('.hud-item-tooltip-line')).not.toContain('nowrap');
    expect(rule('.hud-item-tooltip')).toContain('width: 220px');
  });
});
