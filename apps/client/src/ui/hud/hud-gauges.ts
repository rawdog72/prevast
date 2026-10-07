// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-gauges.ts
// Compact vitality panel: life, labeled needs, world conditions, and XP.
// Values use the GaugeModel's eased
// numbers; unchanged frames leave the DOM alone.

import { icon, type IconName } from '../dom/icons';
import type { GaugeModel } from '../../world/gauge-model';
import type { InventoryStore } from '../../world/inventory-store';
import { GaugeDirection, type GaugeSlotName } from '../../net/opcodes';
import type { WorldClock } from '../../world/world-state';

interface TileConfig {
  id: GaugeSlotName;
  label: string;
  icon: IconName;
  color: string;
  /** Below this fraction the tile pulses. */
  criticalBelow: number;
}

const LIFE_CRITICAL_BELOW = 0.25;

const TILES: TileConfig[] = [
  { id: 'food', label: 'Food', icon: 'food', color: 'var(--dv-food)', criticalBelow: 0.2 },
  {
    id: 'warmth',
    label: 'Warmth',
    icon: 'warm_blooded',
    color: 'var(--dv-cold)',
    criticalBelow: 0.2,
  },
  // Stamina drains to zero in normal play; that is never an emergency.
  {
    id: 'stamina',
    label: 'Stamina',
    icon: 'lightning',
    color: 'var(--dv-stamina)',
    criticalBelow: 0,
  },
];

const DIR_NAME: Record<GaugeDirection, string> = {
  [GaugeDirection.HOLD]: 'hold',
  [GaugeDirection.RISE]: 'rise',
  [GaugeDirection.FALL]: 'fall',
};

const DIR_LABEL: Record<GaugeDirection, string> = {
  [GaugeDirection.HOLD]: 'steady',
  [GaugeDirection.RISE]: 'increasing',
  [GaugeDirection.FALL]: 'decreasing',
};

/** Irradiation at which the dial goes amber, then red (the top-centre alert fires near 0.47). */
const RAD_WARN = 0.35;
const RAD_CRITICAL = 0.5;

// Radiation dial geometry: a 220-degree arc, pivot (32, 34), radius 24, open at
// the bottom so the percent can sit in the gap. Sweep runs -110..+110 degrees
// from 12 o'clock.
const RAD_SWEEP = 220;
const RAD_PIVOT = '32 34';
const RAD_ARC = 'M 9.45 42.21 A 24 24 0 1 1 54.55 42.21';
const RAD_TICKS = [-110, -55, 0, 55, 110]
  .map((a) => `<line x1="32" y1="4.5" x2="32" y2="7.5" transform="rotate(${a} ${RAD_PIVOT})"/>`)
  .join('');

const RAD_SVG =
  `<svg class="hud-rad-svg" viewBox="0 0 64 64" aria-hidden="true">` +
  `<g class="hud-rad-ticks">${RAD_TICKS}</g>` +
  `<path class="hud-rad-track" d="${RAD_ARC}"/>` +
  `<path class="hud-rad-arc" d="${RAD_ARC}" pathLength="100"/>` +
  `<line class="hud-rad-needle" x1="32" y1="17" x2="32" y2="6" transform="rotate(-110 ${RAD_PIVOT})"/>` +
  `</svg>`;

// Clock ring: centre (32, 32), radius 26. Day arc 12 -> 6 o'clock, night arc
// 6 -> 12; the marker starts at 12 o'clock and is rotated round the centre.
const CLOCK_PIVOT = '32 32';
const CLOCK_SVG =
  `<svg class="hud-clock-svg" viewBox="0 0 64 64" aria-hidden="true">` +
  `<path class="hud-clock-day" d="M 32 6 A 26 26 0 0 1 32 58"/>` +
  `<path class="hud-clock-night" d="M 32 58 A 26 26 0 0 1 32 6"/>` +
  `<g class="hud-clock-sun" transform="translate(20 20)"><circle cx="12" cy="12" r="4"/>` +
  `<path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></g>` +
  `<g class="hud-clock-moon" transform="translate(20 20)"><path d="M14 3a8 8 0 1 0 7 11.5A7 7 0 0 1 14 3Z"/></g>` +
  `<circle class="hud-clock-marker" cx="32" cy="6" r="4" transform="rotate(0 ${CLOCK_PIVOT})"/>` +
  `</svg>`;

/** Remembers the last value written per (element, slot) so an unchanged frame costs no DOM work. */
class WriteCache {
  private readonly last = new Map<string, string>();

  private changed(key: string, value: string): boolean {
    if (this.last.get(key) === value) return false;
    this.last.set(key, value);
    return true;
  }

  text(el: Element, key: string, value: string): void {
    if (this.changed(key, value)) el.textContent = value;
  }

  cssVar(el: HTMLElement, key: string, name: string, value: string): void {
    if (this.changed(key, value)) el.style.setProperty(name, value);
  }

  attr(el: Element, key: string, name: string, value: string): void {
    if (this.changed(key, value)) el.setAttribute(name, value);
  }
}

/** Life lost stays visible as a pale trail this long, then drains at TRAIL_DRAIN per second. */
const TRAIL_HOLD_MS = 450;
const TRAIL_DRAIN = 0.9;
/** The bar flashes this long when life starts falling. */
const HIT_FLASH_MS = 220;

export interface LifeTrail {
  /** Fraction the trail shows (>= the life fraction). */
  value: number;
  /** When the trail may start draining. */
  holdUntil: number;
}

/**
 * The damage trail behind the life bar: jumps up with healing, and after a hit
 * holds where life was for a moment before draining down to it.
 */
export function stepLifeTrail(
  trail: LifeTrail,
  life: number,
  now: number,
  dtMs: number,
): LifeTrail {
  if (life >= trail.value) return { value: life, holdUntil: now };
  if (now < trail.holdUntil) return trail;
  return {
    value: Math.max(life, trail.value - (TRAIL_DRAIN * dtMs) / 1000),
    holdUntil: trail.holdUntil,
  };
}

function formatCountdown(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function labelMeter(el: HTMLElement, label: string): void {
  el.setAttribute('role', 'meter');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '100');
  el.setAttribute('aria-valuenow', '100');
}

export class HudGauges {
  private mounted = false;
  private readonly cache = new WriteCache();

  private lifeEl!: HTMLElement;
  private lifeFill!: HTMLElement;
  private lifeVal!: HTMLElement;
  private lifeTrailEl!: HTMLElement;
  private trail: LifeTrail = { value: 1, holdUntil: 0 };
  private lastLife = 1;
  private falling = false;
  private lastTick = 0;
  private flashUntil = 0;

  private readonly tiles = new Map<GaugeSlotName, HTMLElement>();
  private readonly tileFills = new Map<GaugeSlotName, HTMLElement>();
  private readonly tileVals = new Map<GaugeSlotName, HTMLElement>();

  private radEl!: HTMLElement;
  private radNeedle!: Element;
  private radVal!: HTMLElement;

  private timePhase!: HTMLElement;
  private timeLeft!: HTMLElement;
  private timeUntil!: HTMLElement;
  private clockEl!: HTMLElement;
  private clockMarker!: Element;

  private levelEl!: HTMLElement;
  private xpFill!: HTMLElement;
  private xpText!: HTMLElement;

  mount(root: HTMLElement): void {
    if (this.mounted) return;
    this.mounted = true;
    root.innerHTML = '';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Player vitals');

    // Level and XP share a quiet footer below the survival gauges.
    const xp = document.createElement('div');
    xp.className = 'hud-xp';
    xp.title = 'Experience';
    xp.innerHTML =
      `<span class="hud-level-badge"><span class="hud-level-label">LV</span><span class="hud-level"></span></span>` +
      `<span class="hud-xp-body"><span class="hud-xp-text"></span>` +
      `<span class="hud-xp-track"><span class="hud-xp-fill"></span></span></span>`;
    this.levelEl = xp.querySelector('.hud-level')!;
    this.xpFill = xp.querySelector('.hud-xp-fill')!;
    this.xpText = xp.querySelector('.hud-xp-text')!;

    // Life: the hero bar.
    const life = document.createElement('div');
    life.className = 'hud-life';
    life.dataset.gauge = 'life';
    life.title = 'Life';
    labelMeter(life, 'Life');
    life.innerHTML =
      `<span class="hud-life-icon" aria-hidden="true">${icon('heart')}</span>` +
      `<span class="hud-life-body"><span class="hud-life-heading"><span class="hud-life-label">Life</span>` +
      `<span class="hud-life-value"><span class="hud-life-val"></span><span class="hud-gauge-unit">%</span></span></span>` +
      `<span class="hud-life-track"><span class="hud-life-trail"></span><span class="hud-life-fill"></span></span></span>`;
    root.appendChild(life);
    this.lifeEl = life;
    this.lifeFill = life.querySelector('.hud-life-fill')!;
    this.lifeVal = life.querySelector('.hud-life-val')!;
    this.lifeTrailEl = life.querySelector('.hud-life-trail')!;

    // Each need has a persistent label, a track, and the server's trend.
    const tiles = document.createElement('div');
    tiles.className = 'hud-tiles';
    for (const t of TILES) {
      const tile = document.createElement('div');
      tile.className = 'hud-tile';
      tile.dataset.gauge = t.id;
      tile.dataset.dir = 'hold';
      tile.style.setProperty('--c', t.color);
      tile.title = t.label;
      labelMeter(tile, t.label);
      tile.innerHTML =
        `<span class="hud-tile-icon" aria-hidden="true">${icon(t.icon)}</span>` +
        `<span class="hud-tile-label">${t.label}</span>` +
        `<span class="hud-tile-value"><span class="hud-tile-val"></span><span class="hud-gauge-unit">%</span>` +
        `<span class="hud-tile-dir" aria-hidden="true"></span></span>` +
        `<span class="hud-tile-track"><span class="hud-tile-fill"></span></span>`;
      tiles.appendChild(tile);
      this.tiles.set(t.id, tile);
      this.tileFills.set(t.id, tile.querySelector('.hud-tile-fill')!);
      this.tileVals.set(t.id, tile.querySelector('.hud-tile-val')!);
    }
    root.appendChild(tiles);

    // Quiet, paired instruments below the immediate survival needs.
    const environment = document.createElement('div');
    environment.className = 'hud-vit-environment';
    environment.innerHTML =
      `<div class="hud-time"><div class="hud-clock" title="Time of day">${CLOCK_SVG}</div>` +
      `<span class="hud-time-body"><span class="hud-time-phase"></span>` +
      `<span class="hud-time-countdown"><span class="hud-time-left"></span> <span class="hud-time-until"></span></span></span></div>` +
      `<div class="hud-rad" title="Radiation exposure" style="--p:0"><span class="hud-rad-dial">${RAD_SVG}` +
      `<span class="hud-rad-icon">${icon('radiation')}</span></span>` +
      `<span class="hud-rad-body"><span class="hud-rad-label">Radiation</span><span class="hud-rad-val"></span></span></div>`;
    root.appendChild(environment);
    this.radEl = environment.querySelector('.hud-rad')!;
    labelMeter(this.radEl, 'Radiation exposure');
    this.radEl.setAttribute('aria-valuenow', '0');
    this.radNeedle = environment.querySelector('.hud-rad-needle')!;
    this.radVal = environment.querySelector('.hud-rad-val')!;
    this.timePhase = environment.querySelector('.hud-time-phase')!;
    this.timeLeft = environment.querySelector('.hud-time-left')!;
    this.timeUntil = environment.querySelector('.hud-time-until')!;
    this.clockEl = environment.querySelector('.hud-clock')!;
    this.clockMarker = environment.querySelector('.hud-clock-marker')!;
    root.appendChild(xp);
  }

  update(model: GaugeModel, inventory: InventoryStore, clock: WorldClock): void {
    const c = this.cache;

    const life = model.fraction('life');
    const lifePct = Math.round(life * 100);
    c.cssVar(this.lifeFill, 'life.val', '--val', `${lifePct}%`);
    c.text(this.lifeVal, 'life.text', String(lifePct));
    c.attr(this.lifeEl, 'life.aria', 'aria-valuenow', String(lifePct));
    this.lifeEl.classList.toggle('is-critical', life < LIFE_CRITICAL_BELOW);
    const now = performance.now();
    const dt = this.lastTick ? Math.min(100, now - this.lastTick) : 0;
    if (!this.lastTick) {
      // First frame: start the trail at whatever life we joined with.
      this.lastLife = life;
      this.trail = { value: life, holdUntil: now };
    }
    this.lastTick = now;
    // While life is still falling (the model eases it down), the trail holds
    // where it was; it starts draining TRAIL_HOLD_MS after the fall stops.
    const falling = life < this.lastLife - 1e-4;
    if (falling) this.trail = { value: this.trail.value, holdUntil: now + TRAIL_HOLD_MS };
    if (falling && !this.falling) this.flashUntil = now + HIT_FLASH_MS;
    this.falling = falling;
    this.lastLife = life;
    this.trail = stepLifeTrail(this.trail, life, now, dt);
    c.cssVar(this.lifeTrailEl, 'life.trail', '--val', `${(this.trail.value * 100).toFixed(1)}%`);
    this.lifeEl.classList.toggle('is-hit', now < this.flashUntil);

    for (const t of TILES) {
      const fraction = model.fraction(t.id);
      const pct = Math.round(fraction * 100);
      const tile = this.tiles.get(t.id)!;
      c.cssVar(this.tileFills.get(t.id)!, `${t.id}.val`, '--val', `${pct}%`);
      c.text(this.tileVals.get(t.id)!, `${t.id}.text`, String(pct));
      const direction = model.gauge(t.id).dir;
      c.attr(tile, `${t.id}.dir`, 'data-dir', DIR_NAME[direction]);
      c.attr(tile, `${t.id}.aria`, 'aria-valuenow', String(pct));
      c.attr(tile, `${t.id}.description`, 'aria-valuetext', `${pct}%, ${DIR_LABEL[direction]}`);
      tile.classList.toggle('is-critical', t.criticalBelow > 0 && fraction < t.criticalBelow);
    }

    // Cleanliness on the wire (255 = clean); the dial shows how irradiated we are.
    const irradiation = 1 - model.fraction('radiation');
    const p = Math.round(irradiation * 1000) / 1000;
    c.cssVar(this.radEl, 'rad.p', '--p', String(p));
    c.text(this.radVal, 'rad.text', `${Math.round(irradiation * 100)}%`);
    c.attr(this.radEl, 'rad.aria', 'aria-valuenow', String(Math.round(irradiation * 100)));
    const needle = Math.round(-RAD_SWEEP / 2 + irradiation * RAD_SWEEP);
    c.attr(this.radNeedle, 'rad.needle', 'transform', `rotate(${needle} ${RAD_PIVOT})`);
    this.radEl.classList.toggle('is-warn', irradiation >= RAD_WARN && irradiation <= RAD_CRITICAL);
    this.radEl.classList.toggle('is-critical', irradiation > RAD_CRITICAL);
    // The old client's rad.decrease: cleanliness is draining right now, i.e. we stand in a zone.
    this.radEl.classList.toggle(
      'is-draining',
      model.gauge('radiation').dir === GaugeDirection.FALL,
    );

    const needed = inventory.xpForLevel(inventory.level);
    const progress = needed > 0 ? Math.max(0, Math.min(1, inventory.xp / needed)) : 0;
    c.text(this.levelEl, 'level', String(inventory.level));
    c.cssVar(this.xpFill, 'xp.val', '--val', `${Math.round(progress * 100)}%`);
    c.text(this.xpText, 'xp.text', `${inventory.xp} / ${needed} XP`);

    // The marker goes once round the ring per cycle; the text says which half and how long it has left.
    const turn = clock.cycleMs > 0 ? (clock.phaseMs % clock.cycleMs) / clock.cycleMs : 0;
    const angle = Math.round(turn * 3600) / 10;
    c.attr(this.clockMarker, 'clock.marker', 'transform', `rotate(${angle} ${CLOCK_PIVOT})`);
    this.clockEl.classList.toggle('is-night', clock.isNight);
    c.text(this.timePhase, 'time.phase', clock.isNight ? 'Night' : 'Day');
    c.text(this.timeLeft, 'time.left', formatCountdown(clock.remainingMs()));
    c.text(this.timeUntil, 'time.until', clock.isNight ? 'to dawn' : 'to dusk');
  }
}
