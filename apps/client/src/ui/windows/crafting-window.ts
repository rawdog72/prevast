// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/windows/crafting-window.ts
// One compact window: category sprites across the top, location controls,
// then a recipe grid beside the selected item's details. Categories contain
// crafting and unlocks together; the selected item's state determines its action.
// Borders and sprite shading distinguish learned, available and locked skills.
// Station queue and fuel controls appear only while a station is open.
//
// Everything is a view over ContentStore + InventoryStore; the buttons only
// send the old client's packets and the server decides. Time-driven parts
// (progress fills, queue timers, the fuel burn-down) are kept elements
// written every frame; the DOM is only rebuilt when what it shows changes.

import { itemIconUrl } from '../../assets/asset-loader';
import type { ContentStore } from '../../content/store';
import type { StationInReach } from '../../game/input-manager';
import {
  HAND_AREA,
  canCraft,
  craftAreas,
  craftDurationMs,
  craftRecipes,
  fuelEstimateMs,
  needsUnlock,
  skillCostOf,
  skillState,
  skillTabs,
  stationFuel,
  tabHasAffordable,
  type CraftRecipe,
  type SkillContext,
  type SkillTab,
  type StationFuel,
} from '../../world/craft-model';
import type { InventoryStore } from '../../world/inventory-store';
import { icon } from '../dom/icons';
import { itemTooltip } from '../hud/hud-item-tooltip';
import type { WindowHead } from './clan-window';

export type { StationInReach };

export interface CraftingWindowCallbacks {
  onCraft: (iid: number, areaId: number) => void;
  onCancel: () => void;
  onUnlock: (iid: number) => void;
  onAddFuel: (amount: number) => void;
  /** A station tab in the WHERE group: what E sends for that building. */
  onOpenStation: (station: StationInReach) => void;
  /** By hand while a station is open: CLOSE_CONTAINER (old client releaseBuilding). */
  onLeaveStation: () => void;
  /** A queue slot: TAKE_FROM_STATION -- the yield when done, a refund otherwise. */
  onTakeFromStation: (slot: number) => void;
  stationsInReach: () => StationInReach[];
}

export interface CraftingClock {
  now: () => number;
}

const CRAFT_TAB = 'craft';
const HAND_ICON = 'own-button';
const QUEUE_SIZE = 4;
/** Ease the capacity bar; the clock always shows the latest server countdown. */
const FUEL_EASE_MS = 250;

/** MathUtils.Ease.inOutQuad, what the old craft gauge ran its ratio through. */
function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function formatSeconds(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s >= 10 ? `${Math.ceil(s)} s` : `${s.toFixed(1)} s`;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
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
  if (iconName) {
    node.style.setProperty('--icon', `url(${itemIconUrl(iconName)})`);
  } else {
    node.style.removeProperty('--icon');
  }
}

/** A category/location button using the original game's artwork. */
function tabButton(iconName: string, name: string, extraClass: string): HTMLButtonElement {
  const btn = el('button', `dv-tab ${extraClass}`);
  btn.type = 'button';
  btn.title = name;
  btn.setAttribute('aria-label', name);
  const glyph = el('span', 'dv-tab-icon');
  glyph.style.backgroundImage = `url(${itemIconUrl(iconName)})`;
  glyph.setAttribute('aria-hidden', 'true');
  btn.append(glyph, el('span', 'dv-tab-name', name));
  return btn;
}

interface WhereTab {
  areaId: number;
  name: string;
  icon: string;
  /** Set for a station in reach that is not the open one. */
  station?: StationInReach;
}

interface ProgressUi {
  fill: HTMLElement;
  text: HTMLElement;
  totalMs: number;
  startedAt: number;
}

interface QueueSlotUi {
  root: HTMLElement;
  fill: HTMLElement | null;
  label: HTMLElement;
  totalMs: number;
}

interface FuelUi {
  root: HTMLElement;
  areaId: number;
  fill: HTMLElement;
  preview: HTMLElement;
  track: HTMLElement;
  cycle: HTMLElement;
  status: HTMLElement;
  text: HTMLElement;
  slider: HTMLInputElement;
  decrease: HTMLButtonElement;
  increase: HTMLButtonElement;
  max: HTMLButtonElement;
  add: HTMLButtonElement;
  amountText: HTMLElement;
  bagText: HTMLElement;
  fuel: StationFuel;
  shownMs: number;
  lastTick: number;
}

export class CraftingWindow {
  /** CRAFT_TAB or a skill tab key. */
  tab = CRAFT_TAB;
  selectedIid = 0;

  private head!: WindowHead;
  private whereEl!: HTMLElement;
  private unlockEl!: HTMLElement;
  private categoryEl!: HTMLElement;
  private pillEl!: HTMLElement;
  private gridEl!: HTMLElement;
  private sideEl!: HTMLElement;
  private stripEl!: HTMLElement;
  private stripRevealEl!: HTMLElement;
  private recipes: CraftRecipe[] = [];
  private tabs: SkillTab[] = [];
  private lastListSignature = '';
  private lastStateSignature = '';
  private lastRailBadges = '';
  private cells = new Map<number, HTMLElement>();
  private tabButtons = new Map<string, HTMLElement>();
  private progress: ProgressUi | null = null;
  private queueUi: QueueSlotUi[] = [];
  private fuelUi: FuelUi | null = null;
  private fuelAmounts = new Map<number, number>();

  mount(
    body: HTMLElement,
    head: WindowHead,
    content: ContentStore,
    inventory: InventoryStore,
    callbacks: CraftingWindowCallbacks,
    clock: CraftingClock = { now: () => Date.now() },
  ): void {
    this.head = head;
    body.innerHTML = '';
    this.recipes = craftRecipes(content);
    this.tabs = skillTabs(content, this.recipes);
    this.lastListSignature = '';
    this.lastStateSignature = '';
    this.lastRailBadges = '';
    this.cells.clear();
    this.tabButtons.clear();
    this.progress = null;
    this.queueUi = [];
    this.fuelUi = null;

    const layout = el('div', 'dv-craft');
    const toolbar = el('div', 'dv-craft-toolbar');
    this.unlockEl = el('nav', 'dv-craft-unlock-tabs dv-tabs');
    this.unlockEl.setAttribute('aria-label', 'Crafting categories');
    const context = el('div', 'dv-craft-context');
    this.categoryEl = el('span', 'dv-craft-category');
    this.whereEl = el('div', 'dv-craft-where dv-tabs');
    this.whereEl.setAttribute('aria-label', 'Crafting location');
    this.pillEl = el('div', 'dv-craft-points');
    context.append(this.categoryEl, this.whereEl, this.pillEl);
    toolbar.append(this.unlockEl, context);
    const main = el('div', 'dv-craft-main');
    this.gridEl = el('div', 'dv-craft-grid');
    main.appendChild(this.gridEl);
    this.sideEl = el('aside', 'dv-craft-side');
    const sideWrap = el('div', 'dv-craft-side-wrap');
    sideWrap.appendChild(this.sideEl);
    layout.append(main, sideWrap);
    this.stripEl = el('div', 'dv-craft-station');
    this.stripRevealEl = el('div', 'dv-craft-station-reveal');
    const stripClip = el('div', 'dv-craft-station-clip');
    stripClip.appendChild(this.stripEl);
    this.stripRevealEl.appendChild(stripClip);
    body.append(toolbar, layout, this.stripRevealEl);

    this.refresh(content, inventory, callbacks, clock);
  }

  /** K key: open straight onto the first skill tab (old client skill box). */
  showSkills(): void {
    const first = this.tabs[0];
    if (first) {
      this.tab = first.key;
      this.selectedIid = 0;
      this.lastListSignature = '';
    }
  }

  refresh(
    content: ContentStore,
    inventory: InventoryStore,
    callbacks: CraftingWindowCallbacks,
    clock: CraftingClock = { now: () => Date.now() },
  ): void {
    const now = clock.now();
    const areaId = inventory.isStationOpen ? inventory.stationArea : HAND_AREA;
    const areas = craftAreas(content);
    const area = areas.find((a) => a.id === areaId) ?? areas[0]!;
    const skillTab = this.tabs.find((t) => t.key === this.tab);
    if (this.tab !== CRAFT_TAB && !skillTab) this.tab = CRAFT_TAB;

    const list =
      this.tab === CRAFT_TAB
        ? this.recipes.filter((r) => r.stations.some((s) => s.areaId === areaId))
        : (skillTab?.recipes ?? []);
    if (!list.some((r) => r.iid === this.selectedIid)) this.selectedIid = list[0]?.iid ?? 0;
    const selected = list.find((r) => r.iid === this.selectedIid);
    const points = inventory.skillPointsLeft(skillCostOf(this.recipes));
    const skillCtx: SkillContext = {
      level: inventory.level,
      points,
      unlocked: inventory.unlockedSkills,
    };
    const fuel = stationFuel(content, areaId);

    // One window: the title names the area whichever tab is up (the skill
    // tabs are part of crafting, as the old _Craft drew them above the box).
    this.head.title.textContent = area.id === HAND_AREA ? 'Crafting' : area.name;
    this.head.sub.textContent = '';
    this.categoryEl.textContent = skillTab?.name ?? 'All recipes';

    // Keep nearby stations in their reach order so switching location does
    // not move the tab under the pointer. Include an open station if absent.
    const where: WhereTab[] = [{ areaId: HAND_AREA, name: 'By hand', icon: HAND_ICON }];
    for (const station of callbacks.stationsInReach()) {
      if (where.some((w) => w.areaId === station.areaId)) continue;
      const name = areas.find((a) => a.id === station.areaId)?.name ?? `Station ${station.areaId}`;
      where.push({
        areaId: station.areaId,
        name,
        icon: this.stationIcon(content, station.areaId),
        station: inventory.isStationOpen && station.areaId === areaId ? undefined : station,
      });
    }
    if (inventory.isStationOpen && !where.some((w) => w.areaId === areaId))
      where.push({ areaId, name: area.name, icon: this.stationIcon(content, areaId) });

    // Navigation + grid only change with the tab, area, nearby stations or list.
    const listSignature = [
      this.tab,
      areaId,
      where.map((w) => `${w.areaId}:${w.station?.entity.id ?? 'open'}`).join(','),
      list.map((r) => r.iid).join(','),
    ].join('|');
    if (listSignature !== this.lastListSignature) {
      this.lastListSignature = listSignature;
      this.renderRail(where, areaId, content, inventory, callbacks, clock);
      this.renderGrid(list, content, inventory, callbacks, clock);
      this.lastStateSignature = '';
    }
    this.renderRailBadges(points, skillCtx);

    // Cell states, the detail card and the strip's structure follow the inventory.
    const states = list.map((r) => skillState(r, skillCtx));
    const crafting = inventory.crafting;
    const fuelHave = fuel ? inventory.getItemCount(fuel.itemIid) : 0;
    const stateSignature = [
      this.selectedIid,
      states.map((s, i) => `${s.state}:${canCraft(list[i]!, inventory)}`).join(','),
      crafting ? `${crafting.iid}:${crafting.startedAt}` : '',
      inventory.stationQueue.join(','),
      inventory.stationActiveSlot,
      inventory.stationStatedAt,
      inventory.fuel,
      fuelHave,
      inventory.level,
      points,
      // The card's have/need counts: taking or dropping an ingredient moves
      // them without always flipping a cell's state.
      selected?.ingredients.map((ing) => inventory.getItemCount(ing.iid)).join(',') ?? '',
    ].join('|');
    if (stateSignature !== this.lastStateSignature) {
      this.lastStateSignature = stateSignature;
      list.forEach((r, i) => {
        const cell = this.cells.get(r.iid);
        if (!cell) return;
        cell.classList.toggle('is-selected', r.iid === this.selectedIid);
        const state = states[i]!;
        const missing = state.state === 'unlocked' && !canCraft(r, inventory);
        cell.classList.toggle('is-off', missing);
        cell.classList.toggle('is-locked', state.state === 'locked');
        cell.classList.toggle('is-available', state.state === 'available');
        cell.classList.toggle('is-unlocked', state.state === 'unlocked');
        cell.setAttribute('aria-pressed', String(r.iid === this.selectedIid));
        const status =
          state.state === 'locked'
            ? `Locked. ${state.reasons.join('. ')}`
            : state.state === 'available'
              ? `Ready to unlock. ${r.skillCost} skill point${r.skillCost === 1 ? '' : 's'}`
              : missing
                ? 'Unlocked. Missing ingredients'
                : 'Unlocked';
        cell.title = `${r.name} — ${status}`;
        cell.setAttribute('aria-label', cell.title);
      });
      this.renderSide(selected, areaId, content, inventory, callbacks, skillCtx, fuel);
      this.renderStrip(areaId, content, inventory, callbacks, fuel, now);
    }

    this.tick(inventory, fuel, now);
  }

  /** The kept, time-driven elements: written every frame, no DOM rebuilt. */
  private tick(inventory: InventoryStore, fuel: StationFuel | undefined, now: number): void {
    const p = this.progress;
    if (p) {
      const elapsed = now - p.startedAt;
      if (p.totalMs > 0 && elapsed >= p.totalMs) {
        // The old client zeroed `crafting` when its clock ran out; the server
        // completes it on its own and the next frame draws the Craft button.
        inventory.crafting = null;
      } else {
        const ratio = p.totalMs > 0 ? clamp01(elapsed / p.totalMs) : 0;
        p.fill.style.setProperty('--val', `${(easeInOutQuad(ratio) * 100).toFixed(1)}%`);
        p.text.textContent =
          p.totalMs > 0 ? `Cancel · ${formatSeconds(p.totalMs - elapsed)}` : 'Cancel crafting';
      }
    }

    const remainingMs = fuelEstimateMs(inventory.fuelMs, inventory.fuelStatedAt, now);
    const stalled = !!fuel && (inventory.fuel <= 0 || remainingMs <= 0);
    const running =
      inventory.isStationOpen &&
      (fuel ? !stalled : (inventory.stationQueue[inventory.stationActiveSlot] ?? 0) > 0);
    this.stripEl.classList.toggle('is-running', running);
    this.queueUi.forEach((slot, i) => {
      if (!slot.fill) return;
      const stated = inventory.stationProgress / 255;
      const extra =
        slot.totalMs > 0 && !stalled ? (now - inventory.stationStatedAt) / slot.totalMs : 0;
      const ratio = clamp01(stated + extra);
      slot.fill.style.setProperty('--val', `${(ratio * 100).toFixed(1)}%`);
      if (stalled) slot.label.textContent = 'No fuel';
      else if (ratio >= 1) slot.label.textContent = '…';
      else slot.label.textContent = formatSeconds((1 - ratio) * slot.totalMs);
      slot.root.classList.toggle('is-stalled', stalled && i === inventory.stationActiveSlot);
    });

    const f = this.fuelUi;
    if (f && inventory.isStationOpen && fuel) {
      const estimate = remainingMs;
      const dt = Math.max(0, now - f.lastTick);
      f.lastTick = now;
      f.shownMs += (estimate - f.shownMs) * Math.min(1, dt / FUEL_EASE_MS);
      if (Math.abs(estimate - f.shownMs) < 1) f.shownMs = estimate;
      const capacityMs = f.fuel.maxUnits * f.fuel.burnMs;
      f.fill.style.setProperty('--val', `${(clamp01(f.shownMs / capacityMs) * 100).toFixed(2)}%`);
      // A click of fuel is a few percent of the 254-unit cap: keep it visible.
      f.fill.classList.toggle('is-some', f.shownMs > 0);
      const units = Math.min(f.fuel.maxUnits, inventory.fuel);
      f.text.textContent = `${units} / ${f.fuel.maxUnits} · ${formatClock(estimate)}`;
      f.status.textContent = running ? '' : 'Empty';
      f.status.hidden = running;
      // The full tank can be mostly empty while this ring still clearly shows
      // the current unit burning. Exact multiples start with a full ring.
      const cycleMs =
        estimate > 0 && f.fuel.burnMs > 0 ? estimate % f.fuel.burnMs || f.fuel.burnMs : 0;
      f.cycle.style.setProperty(
        '--burn-angle',
        `${(clamp01(cycleMs / f.fuel.burnMs) * 360).toFixed(1)}deg`,
      );
      f.cycle.title = running ? `${formatSeconds(cycleMs)} left in this fuel unit` : 'No fuel';
      f.track.setAttribute('aria-valuenow', String(Math.round(estimate / 1000)));
      f.track.setAttribute(
        'aria-valuetext',
        `${units} fuel units; ${formatClock(estimate)} remaining`,
      );
    }
  }

  private stationIcon(content: ContentStore, areaId: number): string {
    const object = content.stationForArea(areaId);
    const item =
      object && content.has('items')
        ? content.byKey('items', object.itemKey ?? object.key)
        : undefined;
    return item?.client?.icon ?? HAND_ICON;
  }

  private renderRail(
    where: WhereTab[],
    areaId: number,
    content: ContentStore,
    inventory: InventoryStore,
    callbacks: CraftingWindowCallbacks,
    clock: CraftingClock,
  ): void {
    this.whereEl.innerHTML = '';
    this.unlockEl.innerHTML = '';
    this.tabButtons.clear();
    this.lastRailBadges = '';

    const all = tabButton('craftbox-button', 'All recipes', 'is-category');
    all.classList.toggle('is-active', this.tab === CRAFT_TAB);
    all.setAttribute('aria-pressed', String(this.tab === CRAFT_TAB));
    all.addEventListener('click', () => {
      this.tab = CRAFT_TAB;
      this.selectedIid = 0;
      this.refresh(content, inventory, callbacks, clock);
    });
    this.unlockEl.appendChild(all);

    for (const w of where) {
      const btn = tabButton(w.icon, w.name, 'is-where');
      btn.dataset.area = String(w.areaId);
      btn.classList.toggle('is-active', w.areaId === areaId);
      btn.setAttribute('aria-pressed', String(w.areaId === areaId));
      btn.classList.toggle('is-open', w.areaId === areaId && areaId !== HAND_AREA);
      btn.addEventListener('click', () => {
        if (w.station) callbacks.onOpenStation(w.station);
        else if (w.areaId === HAND_AREA && inventory.isStationOpen) callbacks.onLeaveStation();
        this.refresh(content, inventory, callbacks, clock);
      });
      this.whereEl.appendChild(btn);
    }

    for (const t of this.tabs) {
      const btn = tabButton(t.icon, t.name, 'is-category is-skill');
      btn.dataset.tab = t.key;
      btn.classList.toggle('is-active', t.key === this.tab);
      btn.setAttribute('aria-pressed', String(t.key === this.tab));
      btn.addEventListener('click', () => {
        this.tab = t.key;
        this.selectedIid = 0;
        this.refresh(content, inventory, callbacks, clock);
      });
      this.unlockEl.appendChild(btn);
      this.tabButtons.set(t.key, btn);
    }
  }

  /**
   * Keep the point balance visible, including zero; a warm category edge
   * indicates it contains a skill the player can currently learn.
   */
  private renderRailBadges(points: number, ctx: SkillContext): void {
    const dots = this.tabs.map((t) => (tabHasAffordable(t, ctx) ? '1' : '0')).join('');
    const key = `${points}|${dots}`;
    if (key === this.lastRailBadges) return;
    this.lastRailBadges = key;
    this.pillEl.textContent = `${points} skill point${points === 1 ? '' : 's'}`;
    this.pillEl.classList.toggle('is-empty', points <= 0);
    this.tabs.forEach((t, i) => {
      const btn = this.tabButtons.get(t.key);
      btn?.classList.toggle('has-available', dots[i] === '1');
      if (btn) {
        btn.title = dots[i] === '1' ? `${t.name} — skills available to unlock` : t.name;
        btn.setAttribute('aria-label', btn.title);
      }
    });
  }

  private renderGrid(
    list: CraftRecipe[],
    content: ContentStore,
    inventory: InventoryStore,
    callbacks: CraftingWindowCallbacks,
    clock: CraftingClock,
  ): void {
    this.gridEl.innerHTML = '';
    this.cells.clear();
    if (list.length === 0) {
      this.gridEl.appendChild(
        el(
          'div',
          'dv-muted dv-craft-empty',
          this.tab === CRAFT_TAB ? 'Nothing to craft here' : 'Nothing to unlock',
        ),
      );
      return;
    }
    for (const r of list) {
      const cell = el('button', 'dv-craft-cell dv-slot');
      cell.type = 'button';
      cell.dataset.iid = String(r.iid);
      cell.title = r.name;
      setSprite(cell, r.icon);
      cell.addEventListener('click', () => {
        this.selectedIid = r.iid;
        this.refresh(content, inventory, callbacks, clock);
      });
      this.gridEl.appendChild(cell);
      this.cells.set(r.iid, cell);
    }
  }

  private renderSide(
    selected: CraftRecipe | undefined,
    areaId: number,
    content: ContentStore,
    inventory: InventoryStore,
    callbacks: CraftingWindowCallbacks,
    skillCtx: SkillContext,
    fuel: StationFuel | undefined,
  ): void {
    this.sideEl.innerHTML = '';
    this.progress = null;
    if (!selected) return;
    const details = el('div', 'dv-craft-details');
    this.sideEl.appendChild(details);
    const state = skillState(selected, skillCtx);
    const areaNames = new Map(craftAreas(content).map((a) => [a.id, a.name]));
    const madeAt = selected.stations.filter((s) => areaNames.has(s.areaId));

    // Preview: sprite, name, the old dark-box stat line and blurb.
    const info = itemTooltip(content, selected.iid);
    const preview = el('div', 'dv-craft-preview');
    const sprite = el('div', 'dv-craft-preview-sprite dv-slot');
    setSprite(sprite, selected.icon);
    const text = el('div', 'dv-craft-preview-text');
    const yieldText = selected.yieldRange
      ? ` ×${selected.yieldRange[0]}–${selected.yieldRange[1]}`
      : selected.yield > 1
        ? ` ×${selected.yield}`
        : '';
    text.appendChild(el('div', 'name', selected.name + yieldText));
    const tabName = this.tabs.find((t) => t.key === selected.category)?.name ?? '';
    const meta: string[] = madeAt.length === 0 && tabName ? [tabName] : [];
    if (info?.stat && info.stat !== 'Cannot be equipped') meta.push(info.stat);
    if (meta.length) text.appendChild(el('div', 'dv-craft-preview-meta', meta.join(' · ')));
    if (madeAt.length > 0) {
      const stations = el('div', 'dv-craft-stations');
      stations.appendChild(document.createTextNode('Made at: '));
      madeAt.forEach((s, i) => {
        if (i > 0) stations.appendChild(document.createTextNode(' · '));
        const name = el('span', 'dv-craft-station-chip', areaNames.get(s.areaId)!);
        name.classList.toggle('is-here', s.areaId === areaId);
        stations.appendChild(name);
      });
      text.appendChild(stations);
    }
    text.appendChild(
      el(
        'div',
        `dv-craft-preview-state is-${state.state}`,
        state.state === 'unlocked'
          ? 'Unlocked'
          : state.state === 'available'
            ? 'Ready to unlock'
            : 'Locked',
      ),
    );
    preview.append(sprite, text);
    details.appendChild(preview);
    if (info?.description) {
      details.appendChild(el('p', 'dv-craft-desc', info.description));
    }

    // Compact ingredient slots: counts overlay the artwork; hover/focus names
    // the ingredient in the existing heading without adding another row.
    if (selected.kind !== 'perk') {
      const ingredientLabel = el('div', 'dv-label dv-craft-ingredients-label', 'Ingredients');
      details.appendChild(ingredientLabel);
      const ings = el('div', 'dv-craft-ings');
      let hoveredIngredient: string | null = null;
      let focusedIngredient: string | null = null;
      const describeIngredient = () => {
        ingredientLabel.textContent = hoveredIngredient ?? focusedIngredient ?? 'Ingredients';
        ingredientLabel.title = ingredientLabel.textContent;
      };
      if (selected.ingredients.length === 0)
        ings.appendChild(el('div', 'dv-craft-ing-empty', 'Nothing needed'));
      for (const ing of selected.ingredients) {
        const have = inventory.getItemCount(ing.iid);
        const slot = el('div', 'dv-craft-ing dv-slot');
        slot.classList.toggle('is-short', have < ing.amount);
        slot.tabIndex = 0;
        slot.setAttribute('role', 'img');
        slot.setAttribute(
          'aria-label',
          `${ing.name}: ${have}/${ing.amount}${have < ing.amount ? ' — missing ingredients' : ''}`,
        );
        slot.addEventListener('mouseenter', () => {
          hoveredIngredient = ing.name;
          describeIngredient();
        });
        slot.addEventListener('mouseleave', () => {
          hoveredIngredient = null;
          describeIngredient();
        });
        slot.addEventListener('focus', () => {
          focusedIngredient = ing.name;
          describeIngredient();
        });
        slot.addEventListener('blur', () => {
          focusedIngredient = null;
          describeIngredient();
        });
        const chip = el('span', 'dv-craft-ing-icon');
        chip.setAttribute('aria-hidden', 'true');
        const ingIcon = content.has('items')
          ? content.byId('items', ing.iid)?.client?.icon
          : undefined;
        if (ingIcon) chip.style.backgroundImage = `url(${itemIconUrl(ingIcon)})`;
        else chip.textContent = ing.name.slice(0, 2);
        slot.append(chip, el('span', 'dv-craft-ing-count', `${have}/${ing.amount}`));
        ings.appendChild(slot);
      }
      details.appendChild(ings);
    }

    const actions = el('div', 'dv-craft-actions');
    // Reasons sit above the one fixed-height action, never below it. Keep
    // the footer anchored when moving between recipes with different blockers.
    const requirements = el('div', 'dv-craft-requirements');
    for (const reason of state.reasons) {
      // The unlock button already shows the skill-point cost.
      if (reason.startsWith('Cost ')) continue;
      requirements.appendChild(el('div', 'dv-craft-reason', reason));
    }
    actions.appendChild(requirements);
    const crafting = inventory.crafting;
    if (crafting && areaId === HAND_AREA) {
      // The action itself becomes the progress gauge and cancel target. It
      // stays available even while inspecting a different (or locked) recipe.
      const making = this.recipes.find((r) => r.iid === crafting.iid);
      const totalMs = making ? craftDurationMs(content, making, HAND_AREA) : 0;
      const cancel = el('button', 'dv-btn dv-craft-cancel dv-craft-progress');
      cancel.type = 'button';
      cancel.title = `Cancel crafting ${making?.name ?? 'item'}`;
      cancel.setAttribute('aria-label', cancel.title);
      const fill = el('span', 'dv-craft-progress-fill');
      fill.setAttribute('aria-hidden', 'true');
      const label = el('span', 'dv-craft-progress-text');
      cancel.append(fill, label);
      this.progress = { fill, text: label, totalMs, startedAt: crafting.startedAt };
      cancel.addEventListener('click', () => {
        inventory.cancelCraft();
        callbacks.onCancel();
        this.refresh(content, inventory, callbacks);
      });
      actions.appendChild(cancel);
    } else if (state.state === 'unlocked' && selected.kind !== 'perk') {
      const here = selected.stations.some((s) => s.areaId === areaId);
      const duration = craftDurationMs(content, selected, areaId);
      const go = el(
        'button',
        'dv-btn is-primary dv-craft-go',
        here && duration > 0 ? `Craft · ${formatSeconds(duration)}` : 'Craft',
      );
      go.type = 'button';
      const fuelOk = !fuel || inventory.fuel > 0;
      const queueFree = areaId === HAND_AREA || inventory.stationQueue.some((q) => q === 0);
      const have = canCraft(selected, inventory);
      go.disabled = !here || !have || !fuelOk || !queueFree;
      go.addEventListener('click', () => callbacks.onCraft(selected.iid, areaId));
      actions.appendChild(go);
      if (!here)
        requirements.appendChild(
          el(
            'div',
            'dv-craft-reason',
            `Use ${madeAt.map((s) => areaNames.get(s.areaId)).join(' or ')}`,
          ),
        );
      else if (!have) requirements.appendChild(el('div', 'dv-craft-reason', 'Missing ingredients'));
      else if (!fuelOk) requirements.appendChild(el('div', 'dv-craft-reason', 'Needs fuel'));
      else if (!queueFree) requirements.appendChild(el('div', 'dv-craft-reason', 'Queue is full'));
    } else {
      const cost = `${selected.skillCost} skill point${selected.skillCost === 1 ? '' : 's'}`;
      const unlock = el(
        'button',
        'dv-btn is-primary dv-craft-unlock',
        state.state !== 'unlocked'
          ? `Unlock · ${cost}`
          : needsUnlock(selected)
            ? 'Unlocked'
            : 'No unlock needed',
      );
      unlock.type = 'button';
      unlock.disabled = state.state !== 'available';
      unlock.addEventListener('click', () => callbacks.onUnlock(selected.iid));
      actions.appendChild(unlock);
    }
    this.sideEl.appendChild(actions);
  }

  private renderStrip(
    areaId: number,
    content: ContentStore,
    inventory: InventoryStore,
    callbacks: CraftingWindowCallbacks,
    fuel: StationFuel | undefined,
    now: number,
  ): void {
    const inStation = inventory.isStationOpen && areaId !== HAND_AREA;
    this.stripRevealEl.classList.toggle('is-open', inStation);
    this.stripRevealEl.inert = !inStation;
    this.stripRevealEl.setAttribute('aria-hidden', String(!inStation));
    if (!inStation) {
      // Keep the content during collapse. Inert removes its controls from
      // keyboard/mouse interaction immediately, including rapid tab changes.
      this.queueUi = [];
      return;
    }
    this.stripEl.querySelector('.dv-craft-queue')?.remove();
    this.queueUi = [];

    // Queue: four slots, each what the server said it holds and how far it is.
    const queue = el('div', 'dv-craft-queue');
    queue.appendChild(el('span', 'dv-label', 'Queue'));
    for (let i = 0; i < QUEUE_SIZE; i++) {
      const iid = inventory.stationQueue[i] ?? 0;
      const slot = el('div', 'dv-item-slot dv-craft-queue-slot');
      slot.dataset.slot = String(i);
      const recipe = iid > 0 ? this.recipes.find((r) => r.iid === iid) : undefined;
      const iconName =
        iid > 0 && content.has('items') ? content.byId('items', iid)?.client?.icon : undefined;
      setSprite(slot, iconName);
      const label = el('span', 'dv-craft-queue-label');
      let fill: HTMLElement | null = null;
      if (iid > 0) {
        const name = recipe?.name ?? 'item';
        if (i < inventory.stationActiveSlot) {
          slot.classList.add('is-ready');
          label.innerHTML = icon('check');
          slot.title = `Take ${name}`;
        } else if (i === inventory.stationActiveSlot) {
          slot.classList.add('is-active');
          fill = el('div', 'dv-craft-queue-fill');
          slot.appendChild(fill);
          slot.title = `Cancel ${name} — ingredients drop at your feet`;
        } else {
          slot.classList.add('is-queued');
          label.textContent = 'queued';
          slot.title = `Cancel ${name} — ingredients drop at your feet`;
        }
        const x = el('span', 'dv-craft-queue-x');
        x.innerHTML = icon('close');
        slot.appendChild(x);
        slot.addEventListener('click', () => callbacks.onTakeFromStation(i));
      }
      slot.appendChild(label);
      queue.appendChild(slot);
      this.queueUi.push({
        root: slot,
        fill,
        label,
        totalMs: recipe ? craftDurationMs(content, recipe, areaId) : 0,
      });
    }
    this.stripEl.prepend(queue);

    if (!fuel) {
      this.fuelUi?.root.remove();
      this.fuelUi = null;
      return;
    }
    // Keep the amount control mounted while inventory, queue and recipe state
    // change, so a fuel update cannot interrupt a drag or keyboard adjustment.
    if (this.fuelUi?.areaId === areaId && this.fuelUi.fuel.itemIid === fuel.itemIid) {
      this.updateFuelControls(inventory);
      return;
    }
    this.fuelUi?.root.remove();
    const box = el('div', 'dv-craft-fuel');
    const header = el('div', 'dv-craft-fuel-header');
    const identity = el('div', 'dv-craft-fuel-identity');
    const cycle = el('div', 'dv-craft-fuel-cycle');
    cycle.setAttribute('aria-hidden', 'true');
    const label = el('span', 'dv-label');
    const sprite = el('span', 'dv-craft-fuel-icon');
    sprite.setAttribute('aria-hidden', 'true');
    const fuelIcon = content.has('items')
      ? content.byId('items', fuel.itemIid)?.client?.icon
      : undefined;
    if (fuelIcon) sprite.style.backgroundImage = `url(${itemIconUrl(fuelIcon)})`;
    cycle.appendChild(sprite);
    label.textContent = fuel.itemName;
    const name = el('div', 'dv-craft-fuel-name');
    const status = el('span', 'dv-craft-fuel-status');
    name.append(label, status);
    identity.append(cycle, name);
    const track = el('div', 'dv-craft-fuel-track');
    track.setAttribute('role', 'meter');
    track.setAttribute('aria-label', `${fuel.itemName} remaining time`);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(Math.round((fuel.maxUnits * fuel.burnMs) / 1000)));
    const preview = el('div', 'dv-craft-fuel-preview');
    const fill = el('div', 'dv-craft-fuel-fill');
    track.append(preview, fill);
    const text = el('span', 'dv-craft-fuel-text');
    header.append(identity, text);
    const controls = el('div', 'dv-craft-fuel-controls');
    const decrease = el('button', 'dv-btn dv-craft-fuel-step', '−');
    const increase = el('button', 'dv-btn dv-craft-fuel-step', '+');
    const max = el('button', 'dv-btn dv-craft-fuel-max', 'Max');
    decrease.setAttribute('aria-label', 'Decrease fuel amount');
    increase.setAttribute('aria-label', 'Increase fuel amount');
    max.setAttribute('aria-label', 'Select maximum fuel amount');
    for (const button of [decrease, increase, max]) button.type = 'button';
    const slider = el('input', 'dv-range dv-craft-fuel-amount');
    slider.type = 'range';
    slider.step = '1';
    slider.setAttribute('aria-label', `${fuel.itemName} to add`);
    const selectAmount = (amount: number) => {
      this.fuelAmounts.set(areaId, amount);
      this.updateFuelControls(inventory);
    };
    slider.addEventListener('input', () => selectAmount(Number(slider.value)));
    decrease.addEventListener('click', () => selectAmount(Number(slider.value) - 1));
    increase.addEventListener('click', () => selectAmount(Number(slider.value) + 1));
    max.addEventListener('click', () => selectAmount(Number(slider.max)));
    const add = el('button', 'dv-btn is-primary dv-craft-fuel-add');
    add.type = 'button';
    const amountText = el('span', 'dv-craft-fuel-add-amount');
    const bagText = el('span', 'dv-craft-fuel-add-bag');
    add.append(amountText, bagText);
    add.addEventListener('click', () => {
      if (!inventory.isStationOpen || inventory.stationArea !== areaId) return;
      this.updateFuelControls(inventory);
      if (!add.disabled) callbacks.onAddFuel(Number(slider.value));
    });
    controls.append(decrease, slider, increase, max, add);
    box.append(header, track, controls);
    this.stripEl.appendChild(box);
    this.fuelUi = {
      root: box,
      areaId,
      fill,
      preview,
      track,
      cycle,
      status,
      text,
      slider,
      decrease,
      increase,
      max,
      add,
      amountText,
      bagText,
      fuel,
      shownMs: fuelEstimateMs(inventory.fuelMs, inventory.fuelStatedAt, now),
      lastTick: now,
    };
    this.updateFuelControls(inventory);
  }

  private updateFuelControls(inventory: InventoryStore): void {
    const ui = this.fuelUi;
    if (!ui) return;
    const have = inventory.getItemCount(ui.fuel.itemIid);
    const capacity = Math.max(0, ui.fuel.maxUnits - inventory.fuel);
    const limit = Math.min(254, have, capacity);
    const preferred = this.fuelAmounts.get(ui.areaId) ?? ui.fuel.addAmount;
    const amount = limit > 0 ? Math.min(limit, Math.max(1, Math.floor(preferred))) : 0;
    ui.slider.min = limit > 0 ? '1' : '0';
    ui.slider.max = String(Math.max(1, limit));
    ui.slider.value = String(amount);
    ui.slider.disabled = limit <= 1;
    ui.slider.setAttribute('aria-valuetext', `${amount} ${ui.fuel.itemName}, ${have} in bag`);
    ui.decrease.disabled = amount <= 1;
    ui.increase.disabled = amount >= limit;
    ui.max.disabled = amount >= limit;
    ui.add.disabled = amount === 0;
    ui.amountText.textContent = capacity === 0 ? 'Full' : `Add ${amount} / ${have}`;
    ui.bagText.textContent = capacity === 0 ? `${have} in bag` : 'in bag';
    ui.add.setAttribute(
      'aria-label',
      capacity === 0
        ? `Fuel full; ${have} ${ui.fuel.itemName} in bag`
        : `Add ${amount} ${ui.fuel.itemName}; ${have} in bag`,
    );
    ui.add.title =
      amount > 0
        ? `Adds ${formatClock(amount * ui.fuel.burnMs)} of run time`
        : capacity === 0
          ? 'Fuel is full'
          : `No ${ui.fuel.itemName.toLowerCase()} in your bag`;
    ui.preview.style.setProperty(
      '--val',
      `${(clamp01((inventory.fuel + amount) / ui.fuel.maxUnits) * 100).toFixed(2)}%`,
    );
    ui.preview.hidden = amount === 0;
    ui.track.title =
      amount > 0
        ? `After adding: ${inventory.fuel + amount} / ${ui.fuel.maxUnits}`
        : `${inventory.fuel} / ${ui.fuel.maxUnits}`;
  }
}
