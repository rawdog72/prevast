// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/weapon-card.ts
// What a hovered item says: the dark box over the hotbar, and the same box
// over chest and trade slots. A moddable gun adds its stats with the fitted
// mods resolved and the fitted list, so a trade partner can inspect a gun
// before accepting it. Everything else reads as it always did.

import type { ContentStore } from '../../content/store';
import {
  SLOT_LABELS,
  resolveWeapon,
  slotName,
  statRows,
  takesMods,
  type FittedMod,
} from '../../world/weapon-mods';
import { itemTooltip } from './hud-item-tooltip';

export interface CardItem {
  iid: number;
  ammo: number;
  count: number;
  mods: readonly FittedMod[];
}

export interface ItemCard {
  name: string;
  description: string;
  stat: string;
  lines: string[];
}

export function itemCard(content: ContentStore, item: CardItem): ItemCard | null {
  const info = itemTooltip(content, item.iid);
  if (!info) return null;
  const stats = takesMods(content, item.iid) ? resolveWeapon(content, item.iid, item.mods) : null;
  if (!stats) return { ...info, lines: [] };
  const rows = statRows(stats, undefined, item.ammo);
  const row = (key: string) => rows.find((r) => r.key === key)!;
  const lines = [
    `Damage ${row('damage').value} · ${row('fireDelayMs').value} · Magazine ${row('magazineSize').value}`,
    `Spread ${row('spread').value} · Range ${row('range').value}`,
  ];
  for (const fitted of [...item.mods].sort((a, b) => a.slot - b.slot)) {
    const slot = slotName(fitted.slot);
    const name = content.byId('items', fitted.iid)?.name ?? `Item ${fitted.iid}`;
    if (slot) lines.push(`${SLOT_LABELS[slot]}: ${name}`);
  }
  // The resolved damage is in the lines; the unmodded "Damage: 18" would contradict it.
  return { ...info, stat: '', lines };
}

/** Changes whenever anything the card shows could. */
export function cardKey(item: CardItem): string {
  return `${item.iid}:${item.ammo}:${item.count}:${item.mods.map((m) => `${m.slot}.${m.iid}`).join(',')}`;
}

export function renderItemCard(target: HTMLElement, card: ItemCard): void {
  const part = (className: string, text: string) => {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    return el;
  };
  target.replaceChildren(
    part('hud-item-tooltip-name', card.name),
    part('hud-item-tooltip-desc', card.description),
  );
  if (card.stat) target.append(part('hud-item-tooltip-stat', card.stat));
  for (const line of card.lines) target.append(part('hud-item-tooltip-line', line));
}

/** One floating card for chest and trade slots, placed above whatever it describes. */
export class HoverCard {
  readonly el = document.createElement('div');

  constructor() {
    this.el.className = 'hud-item-tooltip dv-panel dv-hover-card';
    this.el.hidden = true;
    document.body.append(this.el);
  }

  attach(target: HTMLElement, content: ContentStore, get: () => CardItem | null): void {
    target.addEventListener('pointerenter', () => {
      const item = get();
      const card = item && item.iid > 0 ? itemCard(content, item) : null;
      if (!card) return;
      renderItemCard(this.el, card);
      this.el.hidden = false;
      const rect = target.getBoundingClientRect();
      const half = this.el.offsetWidth / 2;
      const x = Math.max(
        8 + half,
        Math.min(window.innerWidth - 8 - half, rect.left + rect.width / 2),
      );
      this.el.style.left = `${x}px`;
      this.el.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    });
    target.addEventListener('pointerleave', () => this.hide());
  }

  hide(): void {
    this.el.hidden = true;
  }
}

let shared: HoverCard | null = null;
export function hoverCard(): HoverCard {
  shared ??= new HoverCard();
  return shared;
}
