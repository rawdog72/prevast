// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/windows/death-window.ts
// The old client's generated death window (GameUI.death): "You died", three
// stat tiles (Level / Score / Kills, the middle one highlighted), the items
// carried at death with "Respawn level" beside them, then Play again (which
// reconnects) and Main menu. The server closed the socket after PLAYER_DIE,
// so this window owns the session until one of the two is pressed.

import { itemIconUrl } from '../../assets/asset-loader';
import type { ContentStore } from '../../content/store';
import type { InventoryStore } from '../../world/inventory-store';
import type { WorldState } from '../../world/world-state';
import { simplifyNumber } from '../hud/hud-leaderboard';

export interface DeathWindowCallbacks {
  onPlayAgain: () => void;
  onMainMenu: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class DeathWindow {
  private playBtn!: HTMLButtonElement;
  private errorEl!: HTMLElement;

  mount(
    body: HTMLElement,
    inventory: InventoryStore,
    world: WorldState,
    content: ContentStore,
    callbacks: DeathWindowCallbacks,
  ): void {
    body.innerHTML = '';

    const tiles = el('div', 'dv-death-tiles');
    const stats: [string, string][] = [
      ['Level', String(inventory.level)],
      ['Score', simplifyNumber(world.ownScore)],
      ['Kills', String(inventory.kills)],
    ];
    stats.forEach(([label, value], i) => {
      const tile = el('div', 'dv-death-tile dv-slot');
      if (i === 1) tile.classList.add('is-active');
      tile.appendChild(el('div', 'dv-label', label));
      tile.appendChild(el('div', i === 1 ? 'value is-big' : 'value', value));
      tiles.appendChild(tile);
    });
    body.appendChild(tiles);
    const run = world.ownRun;
    if (run) {
      const recap = el('section', 'dv-run-recap');
      const minutes = Math.floor(run.survivedSeconds / 60);
      recap.append(el('p', undefined, 'Survived ' + minutes + 'm ' + run.survivedSeconds % 60 + 's'),
        el('p', undefined, run.earnedScore.toLocaleString() + ' eligible score · ' + run.scoreCaps + ' score golden caps'),
        el('p', 'dv-muted', run.clanContribution.toLocaleString() + ' score contributed to clans'));
      if (run.rewardCaps) recap.append(el('p', undefined, run.rewardCaps + ' achievement / event caps reported'));
      if (world.ownScore > run.bestScore) recap.append(el('p', 'dv-record', 'New personal best!'));
      recap.append(el('p', 'dv-muted', 'Rewards sync to your account. Unfinished cap progress resets with this life.'));
      body.append(recap);
    }

    const row = el('div', 'dv-death-row');
    row.appendChild(
      el('div', 'dv-death-items-label', inventory.deathItems.length ? 'Your items' : ''),
    );
    row.appendChild(
      el('div', 'dv-death-respawn dv-muted', `Respawn level ${Math.floor(inventory.level / 2)}`),
    );
    body.appendChild(row);

    if (inventory.deathItems.length) {
      const items = el('div', 'dv-death-items');
      for (const item of inventory.deathItems) {
        const slot = el('div', 'dv-item-slot');
        const iconName = content.has('items')
          ? content.byId('items', item.iid)?.client?.icon
          : undefined;
        slot.classList.toggle('has-item', !!iconName);
        if (iconName)
          slot.style.setProperty('--icon', `url(${itemIconUrl(iconName)})`);
        slot.appendChild(el('span', 'count', item.count > 1 ? String(item.count) : ''));
        items.appendChild(slot);
      }
      body.appendChild(items);
    }

    const actions = el('div', 'dv-death-actions');
    this.playBtn = el('button', 'dv-btn is-primary dv-death-play', 'Play again');
    this.playBtn.type = 'button';
    this.playBtn.addEventListener('click', () => {
      this.playBtn.disabled = true;
      this.playBtn.textContent = 'Connecting…';
      this.errorEl.textContent = '';
      callbacks.onPlayAgain();
    });
    const menu = el('button', 'dv-btn dv-death-menu', 'Main menu');
    menu.type = 'button';
    menu.addEventListener('click', () => callbacks.onMainMenu());
    actions.append(this.playBtn, menu);
    body.appendChild(actions);

    this.errorEl = el('div', 'dv-death-error');
    body.appendChild(this.errorEl);
  }

  /** A refused reconnect (server full, closed, ...): show why and let them try again. */
  setError(message: string): void {
    this.errorEl.textContent = message;
    this.playBtn.disabled = false;
    this.playBtn.textContent = 'Play again';
  }
}
