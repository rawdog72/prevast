// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/windows/upgrade-window.ts
// The upgrade window (Ctrl+right-click a building > Upgrade): what it is,
// what it becomes, the materials it takes and one action. Built from the
// crafting window's own pieces -- the preview card, the ingredient slots and
// the action that turns into its progress gauge -- so it reads as part of
// the same system.
//
// A view over InventoryStore.upgrade (UPGRADE_STATE) and the content tables.
// The button only sends START_UPGRADE / CANCEL_UPGRADE; the server checks the
// unlock and the materials again and decides. The countdown is the server's
// remaining time run down locally, written every frame without a rebuild.

import { itemIconUrl } from '../../assets/asset-loader';
import type { ContentStore } from '../../content/store';
import {
  canCraft,
  craftRecipes,
  skillCostOf,
  skillState,
  type CraftRecipe,
} from '../../world/craft-model';
import type { InventoryStore } from '../../world/inventory-store';
import { icon } from '../dom/icons';
import type { WindowHead } from './clan-window';

export interface UpgradeWindowCallbacks {
  onStart: () => void;
  onCancel: () => void;
}

export interface UpgradeClock {
  now: () => number;
}

/** MathUtils.Ease.inOutQuad, the curve the craft gauge fills on. */
function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function formatUpgradeTime(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s >= 60) {
    const m = Math.floor(Math.ceil(s) / 60);
    const rest = Math.ceil(s) % 60;
    return `${m}:${rest < 10 ? '0' : ''}${rest}`;
  }
  return s >= 10 ? `${Math.ceil(s)} s` : `${s.toFixed(1)} s`;
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

function setSprite(node: HTMLElement, iconName: string | undefined): void {
  node.classList.toggle('has-item', !!iconName);
  if (iconName) node.style.setProperty('--icon', `url(${itemIconUrl(iconName)})`);
  else node.style.removeProperty('--icon');
}

interface ProgressUi {
  fill: HTMLElement;
  text: HTMLElement;
}

export class UpgradeWindow {
  private head!: WindowHead;
  private root!: HTMLElement;
  private recipes: CraftRecipe[] = [];
  private signature = '';
  private progress: ProgressUi | null = null;

  mount(
    body: HTMLElement,
    head: WindowHead,
    content: ContentStore,
    inventory: InventoryStore,
    callbacks: UpgradeWindowCallbacks,
    clock: UpgradeClock = { now: () => Date.now() },
  ): void {
    this.head = head;
    body.innerHTML = '';
    this.root = el('div', 'dv-upgrade');
    body.appendChild(this.root);
    this.recipes = craftRecipes(content);
    this.signature = '';
    this.progress = null;
    this.refresh(content, inventory, callbacks, clock);
  }

  refresh(
    content: ContentStore,
    inventory: InventoryStore,
    callbacks: UpgradeWindowCallbacks,
    clock: UpgradeClock = { now: () => Date.now() },
  ): void {
    const state = inventory.upgrade;
    if (!state) return;
    const recipe = this.recipes.find((r) => r.iid === state.targetIid);
    const points = inventory.skillPointsLeft(skillCostOf(this.recipes));
    const skill = recipe
      ? skillState(recipe, { level: inventory.level, points, unlocked: inventory.unlockedSkills })
      : undefined;
    // Rebuilt only when what it shows changes; the countdown is tick()'s.
    const signature = [
      state.entityId,
      state.iid,
      state.targetIid,
      state.running,
      state.durationMs,
      state.running ? state.statedAt : 0,
      skill?.state ?? '',
      inventory.level,
      recipe?.ingredients.map((ing) => inventory.getItemCount(ing.iid)).join(',') ?? '',
    ].join('|');
    if (signature !== this.signature) {
      this.signature = signature;
      this.render(
        content,
        inventory,
        callbacks,
        recipe,
        skill?.state === 'unlocked',
        skill?.reasons ?? [],
      );
    }
    this.tick(inventory, clock.now());
  }

  private tick(inventory: InventoryStore, now: number): void {
    const p = this.progress;
    const state = inventory.upgrade;
    if (!p || !state?.running) return;
    const left = Math.max(0, state.remainingMs - Math.max(0, now - state.statedAt));
    const ratio = state.durationMs > 0 ? clamp01(1 - left / state.durationMs) : 1;
    p.fill.style.setProperty('--val', `${(easeInOutQuad(ratio) * 100).toFixed(1)}%`);
    p.text.textContent = left > 0 ? `Stop · ${formatUpgradeTime(left)}` : 'Finishing…';
  }

  private render(
    content: ContentStore,
    inventory: InventoryStore,
    callbacks: UpgradeWindowCallbacks,
    recipe: CraftRecipe | undefined,
    unlocked: boolean,
    reasons: string[],
  ): void {
    const state = inventory.upgrade!;
    this.progress = null;
    this.root.innerHTML = '';
    const items = content.has('items') ? content : undefined;
    const from = items?.byId('items', state.iid);
    const to = items?.byId('items', state.targetIid);
    const fromName = from?.name || from?.key || 'Building';
    const toName = to?.name || to?.key || 'Upgrade';

    this.head.title.textContent = 'Upgrade';
    this.head.sub.textContent = '';

    // What it is -> what it becomes, each with the health it stands at.
    const pieces = el('div', 'dv-upgrade-pieces');
    pieces.append(
      this.piece(content, state.iid, fromName),
      this.arrow(),
      this.piece(content, state.targetIid, toName),
    );
    this.root.appendChild(pieces);

    // The materials: the target's own recipe, the crafting window's slots.
    const label = el('div', 'dv-label dv-craft-ingredients-label', 'Materials');
    this.root.appendChild(label);
    const ings = el('div', 'dv-craft-ings');
    for (const ing of recipe?.ingredients ?? []) {
      const have = inventory.getItemCount(ing.iid);
      const slot = el('div', 'dv-craft-ing dv-slot');
      // A running upgrade has already been paid for.
      slot.classList.toggle('is-short', !state.running && have < ing.amount);
      slot.tabIndex = 0;
      slot.setAttribute('role', 'img');
      slot.title = ing.name;
      slot.setAttribute('aria-label', `${ing.name}: ${have}/${ing.amount}`);
      slot.addEventListener('mouseenter', () => (label.textContent = ing.name));
      slot.addEventListener('mouseleave', () => (label.textContent = 'Materials'));
      const chip = el('span', 'dv-craft-ing-icon');
      chip.setAttribute('aria-hidden', 'true');
      const ingIcon = items?.byId('items', ing.iid)?.client?.icon;
      if (ingIcon) chip.style.backgroundImage = `url(${itemIconUrl(ingIcon)})`;
      else chip.textContent = ing.name.slice(0, 2);
      slot.append(
        chip,
        el('span', 'dv-craft-ing-count', state.running ? `${ing.amount}` : `${have}/${ing.amount}`),
      );
      ings.appendChild(slot);
    }
    if (!recipe) ings.appendChild(el('div', 'dv-craft-ing-empty', 'Nothing to upgrade into'));
    this.root.appendChild(ings);

    const actions = el('div', 'dv-craft-actions');
    const requirements = el('div', 'dv-craft-requirements');
    actions.appendChild(requirements);

    if (state.running) {
      // The action becomes the gauge, as a running craft's does. Anyone with
      // the window open can stop it -- the owner or a raider.
      const stop = el('button', 'dv-btn dv-craft-cancel dv-craft-progress');
      stop.type = 'button';
      stop.title = `Stop upgrading to ${toName} — the materials drop at your feet`;
      stop.setAttribute('aria-label', stop.title);
      const fill = el('span', 'dv-craft-progress-fill');
      fill.setAttribute('aria-hidden', 'true');
      const text = el('span', 'dv-craft-progress-text');
      stop.append(fill, text);
      this.progress = { fill, text };
      stop.addEventListener('click', () => callbacks.onCancel());
      actions.appendChild(stop);
      requirements.appendChild(el('div', 'dv-upgrade-note', 'Upgrading. It finishes on its own.'));
    } else {
      const have = recipe ? canCraft(recipe, inventory) : false;
      const go = el(
        'button',
        'dv-btn is-primary dv-craft-go',
        state.durationMs > 0 ? `Upgrade · ${formatUpgradeTime(state.durationMs)}` : 'Upgrade',
      );
      go.type = 'button';
      go.disabled = !recipe || !unlocked || !have;
      go.addEventListener('click', () => callbacks.onStart());
      actions.appendChild(go);
      if (recipe && !unlocked) {
        requirements.appendChild(el('div', 'dv-craft-reason', `Unlock ${toName} first`));
        for (const reason of reasons) {
          // The skill tab shows the point cost; here only what blocks it.
          if (reason.startsWith('Cost ')) continue;
          requirements.appendChild(el('div', 'dv-craft-reason', reason));
        }
      } else if (recipe && !have) {
        requirements.appendChild(el('div', 'dv-craft-reason', 'Missing materials'));
      }
    }
    this.root.appendChild(actions);
  }

  private piece(content: ContentStore, iid: number, name: string): HTMLElement {
    const box = el('div', 'dv-craft-preview dv-upgrade-piece');
    const sprite = el('div', 'dv-craft-preview-sprite dv-slot');
    const item = content.has('items') ? content.byId('items', iid) : undefined;
    setSprite(sprite, item?.client?.icon);
    const text = el('div', 'dv-craft-preview-text');
    text.appendChild(el('div', 'name', name));
    const object = content.has('objects') && item ? content.byKey('objects', item.key) : undefined;
    if (object) text.appendChild(el('div', 'dv-craft-preview-meta', `Life: ${object.healthMax}`));
    box.append(sprite, text);
    return box;
  }

  private arrow(): HTMLElement {
    const arrow = el('span', 'dv-upgrade-arrow');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.innerHTML = icon('arrow_right');
    return arrow;
  }
}
