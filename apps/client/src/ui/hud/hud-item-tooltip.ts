// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-item-tooltip.ts
// The old client's "dark box" over the selected hotbar slot (itemstatsfunc):
// the item's name, its description, and one stat line -- a weapon's damage, a
// consumable's food / heal / energy, a building piece's life, or "Cannot be
// equipped". All of it read from the content tables, nothing hardcoded.

import type { ContentStore } from '../../content/store';

export interface ItemTooltip {
  name: string;
  description: string;
  stat: string;
}

/** The equipable key the old client used for every placeable building item. */
const PLACE_OBJECT_KEY = 'place_object';

export function itemTooltip(content: ContentStore, iid: number): ItemTooltip | null {
  if (!content.has('items')) return null;
  const item = content.byId('items', iid);
  if (!item) return null;
  const name = item.name || item.key;
  const description = item.client?.description ?? '';

  let stat = 'Cannot be equipped';
  if (item.wearable) {
    stat = '';
  } else if (item.equipable) {
    const equipKey = item.equipable.key;
    if (equipKey === PLACE_OBJECT_KEY) {
      const object = content.has('objects') ? content.byKey('objects', item.key) : undefined;
      stat = object ? `Life: ${object.healthMax}` : '';
    } else {
      const equipable = content.has('equipables')
        ? content.byKey('equipables', equipKey)
        : undefined;
      if (equipable?.damage) {
        stat = `Damage: ${equipable.damage.amount}`;
      } else if (equipable?.consumable) {
        // Old client order: food, then heal / damage, then energy.
        const amount = (type: string) =>
          equipable.consumable!.effect.find((e) => e.type === type)?.amount ?? 0;
        const food = amount('food');
        const heal = amount('heal');
        const energy = amount('energy');
        const parts: string[] = [];
        if (food !== 0) parts.push(`Food: ${food}`);
        if (heal < 0) parts.push(`Damage: ${heal}`);
        else if (heal > 0) parts.push(`Heal: ${heal}`);
        if (energy !== 0) parts.push(`Energy: ${energy}`);
        stat = parts.join(' ');
      } else {
        stat = '';
      }
    }
  }
  return { name, description, stat };
}
