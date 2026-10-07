// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Profiler } from '../../core/profiler';
import { HudProfiler } from './hud-profiler';

describe('HudProfiler head line', () => {
  function setup() {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const root = document.createElement('div');
    const hud = new HudProfiler();
    hud.mount(root);
    hud.setVisible(true);
    const profiler = new Profiler();
    profiler.enable();
    for (let i = 0; i < 30; i++) {
      profiler.frameBegin(i * 16);
      profiler.frameEnd();
    }
    return { root, hud, profiler };
  }

  it('shows the fps and the ping next to each other', () => {
    const { root, hud, profiler } = setup();
    hud.update(profiler, 1000, { pingMs: 37.6 });
    const head = root.querySelector('.hud-profiler-head')!.textContent!;
    expect(head).toMatch(/^\d+ fps · ping 38 ms · frame p50/);
  });

  it('prints a dash while no keepalive has been answered', () => {
    const { root, hud, profiler } = setup();
    hud.update(profiler, 1000, { pingMs: -1 });
    expect(root.querySelector('.hud-profiler-head')!.textContent).toContain('ping – ms');
  });
});

describe('HudProfiler dragging (the title bar moves the panel)', () => {
  afterEach(() => localStorage.clear());

  function setup() {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const hud = new HudProfiler();
    hud.mount(root);
    hud.setVisible(true);
    const title = root.querySelector<HTMLElement>('.hud-profiler-title')!;
    return { root, hud, title };
  }

  function pointer(type: string, target: Element, x: number, y: number) {
    const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    target.dispatchEvent(ev);
  }

  it('follows the pointer from where it was grabbed and remembers the spot', () => {
    const { root, title } = setup();
    root.getBoundingClientRect = () =>
      ({ left: 16, top: 62, width: 360, height: 400, right: 376, bottom: 462 }) as DOMRect;
    pointer('pointerdown', title, 100, 70);
    pointer('pointermove', title, 300, 170);
    expect(root.style.left).toBe('216px');
    expect(root.style.top).toBe('162px');
    pointer('pointerup', title, 300, 170);
    expect(JSON.parse(localStorage.getItem('prevast.profiler-pos')!)).toEqual({ x: 216, y: 162 });
  });

  it('starts where it was left last time, and never off-screen', () => {
    localStorage.setItem('prevast.profiler-pos', JSON.stringify({ x: 5000, y: -40 }));
    (window as unknown as { innerWidth: number }).innerWidth = 1200;
    (window as unknown as { innerHeight: number }).innerHeight = 800;
    const { root } = setup();
    expect(root.style.left).toBe('1140px');
    expect(root.style.top).toBe('0px');
  });
});
