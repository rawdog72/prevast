// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/context-menu.ts
// The right-click menu: on an inventory or container item (Look, Trade with…,
// Drop / Take) and on things in the world (Look, Open, Talk…). What Look finds
// is not shown here but on the status line over the hotbar (hud-status-line.ts).

import type { ContentStore } from '../content/store';
import type { InventoryItem } from '../world/inventory-store';
import type { FittedMod } from '../world/weapon-mods';
import { magazine, rotStage } from './hud/hud-hotbar';
import { itemTooltip } from './hud/hud-item-tooltip';

export interface ContextMenuEntry {
  label: string;
  action: () => void;
  disabled?: boolean;
  /**
   * Re-read while the menu stays open (update()), for an entry that depends on
   * where the player is: "Open — move closer" becomes "Open" on arrival.
   */
  refresh?: () => { label: string; disabled: boolean };
}

function withArticle(name: string): string {
  return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
}

/** Look at an item, Tibia style: "You see an Orange (x3). Juicy. Freshness 80%." */
export function itemLookText(
  item: InventoryItem,
  content: ContentStore,
  mods: readonly FittedMod[] = [],
): string {
  const info = itemTooltip(content, item.iid);
  const parts = [
    `You see ${withArticle(info?.name ?? `item ${item.iid}`)}${item.count > 1 ? ` (x${item.count})` : ''}.`,
  ];
  if (info?.description)
    parts.push(/[.!?]$/.test(info.description) ? info.description : `${info.description}.`);
  if (info?.stat && info.stat !== 'Cannot be equipped') parts.push(`${info.stat}.`);
  const mag = magazine(item, content, mods);
  if (mag) parts.push(`Ammo ${mag.ammo}/${mag.size}.`);
  else if (rotStage(item, content) >= 0)
    parts.push(`Freshness ${Math.round((item.ammo / 255) * 100)}%.`);
  const fitted = mods
    .map((m) => content.byId('items', m.iid)?.name)
    .filter((n): n is string => !!n);
  if (fitted.length) parts.push(`Fitted: ${fitted.join(', ')}.`);
  return parts.join(' ');
}

export class ContextMenu {
  private readonly root = document.createElement('div');
  private live: { entry: ContextMenuEntry; button: HTMLButtonElement }[] = [];
  private readonly dismiss = (event: PointerEvent) => {
    if (!this.root.contains(event.target as Node)) this.close();
  };

  constructor() {
    this.root.className = 'dv-player-menu dv-context-menu';
    this.root.hidden = true;
    this.root.setAttribute('role', 'menu');
    document.body.append(this.root);
    document.addEventListener('pointerdown', this.dismiss);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(title: string, entries: ContextMenuEntry[], x: number, y: number): void {
    const name = document.createElement('strong');
    name.textContent = title;
    this.root.replaceChildren(name);
    this.live = [];
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = entry.label;
      button.setAttribute('role', 'menuitem');
      button.disabled = !!entry.disabled;
      button.addEventListener('click', () => {
        this.close();
        entry.action();
      });
      this.root.append(button);
      if (entry.refresh) this.live.push({ entry, button });
    }
    this.root.hidden = false;
    const rect = this.root.getBoundingClientRect();
    this.root.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    this.root.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    this.root.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  /** Called every frame; only entries with `refresh` are re-read, and only changes are written. */
  update(): void {
    if (this.root.hidden) return;
    for (const { entry, button } of this.live) {
      const next = entry.refresh!();
      if (button.textContent !== next.label) button.textContent = next.label;
      if (button.disabled !== next.disabled) button.disabled = next.disabled;
    }
  }

  close(): void {
    this.root.hidden = true;
    this.live = [];
  }

  destroy(): void {
    document.removeEventListener('pointerdown', this.dismiss);
    this.root.remove();
  }
}
