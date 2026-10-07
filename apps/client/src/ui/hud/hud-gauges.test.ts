// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { GaugeDirection } from '../../net/opcodes';
import { GaugeModel } from '../../world/gauge-model';
import { InventoryStore } from '../../world/inventory-store';
import { WorldClock } from '../../world/world-state';
import { HudGauges, stepLifeTrail } from './hud-gauges';

function setup() {
  const root = document.createElement('div');
  const gauges = new HudGauges();
  gauges.mount(root);
  const model = new GaugeModel();
  const inventory = new InventoryStore();
  const clock = new WorldClock();
  return { root, gauges, model, inventory, clock };
}

const q = <T extends HTMLElement = HTMLElement>(root: HTMLElement, sel: string) =>
  root.querySelector<T>(sel)!;

describe('HudGauges vitality panel', () => {
  it('draws life as the hero bar with its percent, and flags it critical below a quarter', () => {
    const { root, gauges, model, inventory, clock } = setup();
    model.setValue('life', 51); // 20 %
    model.snap();
    gauges.update(model, inventory, clock);
    const life = q(root, '.hud-life');
    expect(q(life, '.hud-life-fill').style.getPropertyValue('--val')).toBe('20%');
    expect(q(life, '.hud-life-val').textContent).toBe('20');
    expect(life.getAttribute('aria-valuenow')).toBe('20');
    expect(life.classList.contains('is-critical')).toBe(true);

    model.setValue('life', 255);
    model.snap();
    gauges.update(model, inventory, clock);
    expect(q(life, '.hud-life-val').textContent).toBe('100');
    expect(life.classList.contains('is-critical')).toBe(false);
  });

  it('fills the food / warmth / stamina tracks and describes the direction the server states', () => {
    const { root, gauges, model, inventory, clock } = setup();
    model.setValue('food', 40); // 16 % -> critical
    model.setDirection('food', GaugeDirection.FALL);
    model.setDirection('warmth', GaugeDirection.RISE);
    model.snap();
    gauges.update(model, inventory, clock);

    const food = q(root, '.hud-tile[data-gauge="food"]');
    expect(q(food, '.hud-tile-fill').style.getPropertyValue('--val')).toBe('16%');
    expect(q(food, '.hud-tile-val').textContent).toBe('16');
    expect(food.dataset.dir).toBe('fall');
    expect(food.getAttribute('aria-label')).toBe('Food');
    expect(food.getAttribute('aria-valuenow')).toBe('16');
    expect(food.getAttribute('aria-valuetext')).toBe('16%, decreasing');
    expect(food.classList.contains('is-critical')).toBe(true);

    const warmth = q(root, '.hud-tile[data-gauge="warmth"]');
    expect(warmth.dataset.dir).toBe('rise');
    expect(warmth.getAttribute('aria-valuetext')).toBe('100%, increasing');
    expect(warmth.classList.contains('is-critical')).toBe(false);

    const stamina = q(root, '.hud-tile[data-gauge="stamina"]');
    expect(stamina.dataset.dir).toBe('hold');
    // Stamina drains to zero in normal play; that is never an emergency.
    model.setValue('stamina', 0);
    model.snap();
    gauges.update(model, inventory, clock);
    expect(stamina.classList.contains('is-critical')).toBe(false);
    expect(stamina.getAttribute('aria-valuenow')).toBe('0');
  });

  it('sweeps the radiation dial with irradiation (1 - cleanliness) and pulses while it drains', () => {
    const { root, gauges, model, inventory, clock } = setup();
    const rad = q(root, '.hud-rad');
    gauges.update(model, inventory, clock); // clean
    expect(rad.style.getPropertyValue('--p')).toBe('0');
    expect(q(rad, '.hud-rad-val').textContent).toBe('0%');
    expect(q(rad, '.hud-rad-needle').getAttribute('transform')).toBe('rotate(-110 32 34)');
    expect(rad.classList.contains('is-critical')).toBe(false);
    expect(rad.classList.contains('is-draining')).toBe(false);

    model.setValue('radiation', 0); // fully irradiated
    model.setDirection('radiation', GaugeDirection.FALL);
    model.snap();
    gauges.update(model, inventory, clock);
    expect(rad.style.getPropertyValue('--p')).toBe('1');
    expect(q(rad, '.hud-rad-val').textContent).toBe('100%');
    expect(rad.getAttribute('aria-valuenow')).toBe('100');
    expect(q(rad, '.hud-rad-needle').getAttribute('transform')).toBe('rotate(110 32 34)');
    expect(rad.classList.contains('is-critical')).toBe(true);
    expect(rad.classList.contains('is-draining')).toBe(true);
  });

  it('runs the clock marker once round the ring per cycle and counts down to the switch', () => {
    const { root, gauges, model, inventory, clock } = setup();
    const face = q(root, '.hud-clock');
    clock.sync(240000, 60000, false); // half-way through the day
    gauges.update(model, inventory, clock);
    expect(q(face, '.hud-clock-marker').getAttribute('transform')).toBe('rotate(90 32 32)');
    expect(face.classList.contains('is-night')).toBe(false);
    expect(q(root, '.hud-time-phase').textContent).toBe('Day');
    expect(q(root, '.hud-time-left').textContent).toBe('1:00');
    expect(q(root, '.hud-time-until').textContent).toBe('to dusk');

    clock.sync(240000, 235000, true); // 5 s before dawn
    gauges.update(model, inventory, clock);
    expect(q(face, '.hud-clock-marker').getAttribute('transform')).toBe('rotate(352.5 32 32)');
    expect(face.classList.contains('is-night')).toBe(true);
    expect(q(root, '.hud-time-phase').textContent).toBe('Night');
    expect(q(root, '.hud-time-left').textContent).toBe('0:05');
    expect(q(root, '.hud-time-until').textContent).toBe('to dawn');
  });

  it('shows the level with the XP progress and the numbers toward the next level', () => {
    const { root, gauges, model, inventory, clock } = setup();
    inventory.level = 3;
    inventory.xp = Math.floor(inventory.xpForLevel(3) / 2);
    gauges.update(model, inventory, clock);
    expect(q(root, '.hud-level').textContent).toBe('3');
    expect(q(root, '.hud-xp-fill').style.getPropertyValue('--val')).toBe('50%');
    const needed = inventory.xpForLevel(3);
    expect(q(root, '.hud-xp-text').textContent).toBe(`${inventory.xp} / ${needed} XP`);
  });

  it('only touches the DOM when a drawn value changes', () => {
    const { root, gauges, model, inventory, clock } = setup();
    model.setValue('food', 128);
    model.snap();
    gauges.update(model, inventory, clock);
    const fill = q(root, '.hud-tile[data-gauge="food"] .hud-tile-fill');
    let writes = 0;
    const observer = new MutationObserver((records) => (writes += records.length));
    observer.observe(root, { attributes: true, childList: true, subtree: true, characterData: true });
    gauges.update(model, inventory, clock);
    gauges.update(model, inventory, clock);
    // MutationObserver delivers asynchronously; flush by taking the records directly.
    writes += observer.takeRecords().length;
    observer.disconnect();
    expect(writes).toBe(0);
    expect(fill.style.getPropertyValue('--val')).toBe('50%');
  });
});

describe('stepLifeTrail', () => {
  it('holds after a hit, then drains down to life', () => {
    const hit = { value: 0.8, holdUntil: 1450 };
    expect(stepLifeTrail(hit, 0.5, 1000, 16)).toBe(hit);
    const draining = stepLifeTrail(hit, 0.5, 1500, 100);
    expect(draining.value).toBeCloseTo(0.71);
    expect(stepLifeTrail(draining, 0.5, 2500, 1000).value).toBe(0.5);
  });

  it('follows healing straight up', () => {
    expect(stepLifeTrail({ value: 0.4, holdUntil: 0 }, 0.6, 10, 16)).toEqual({ value: 0.6, holdUntil: 10 });
  });
});
