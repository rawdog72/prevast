// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-profiler.ts
// On-screen profiler panel (F2). Reads the Profiler's ring buffer four times a
// second and shows: FPS and frame interval percentiles over the last two
// seconds, the tick's cost split by section (sorted, with bars), the per-frame
// counters that explain stalls (new sprites rasterised, draws, entities, net
// traffic), the asset loader's state (resident / queued / decoded MB) and the
// most recent hitches with their classification. A 2 s frame graph at the
// top colours each frame green / amber / red by interval. Deliberately plain
// DOM, no backdrop blur, and updated on a timer rather than every frame so the
// panel itself stays out of the measurements. The title bar drags the panel
// anywhere on screen (the body stays click-through) and the spot is kept in
// localStorage so it comes back where it was left.

import type { Profiler, ProfilerSummary } from '../../core/profiler';
import { readSetting, writeSetting } from '../../core/storage';

const REFRESH_MS = 250;
const WINDOW_MS = 2000;
const GRAPH_FRAMES = 140;
/** localStorage key of the dragged position ({x, y} in CSS px). */
const POSITION_SETTING = 'prevast.profiler-pos';
/** How much of the panel must stay inside the window: enough of the title bar to grab. */
const KEEP_ON_SCREEN_X = 60;
const KEEP_ON_SCREEN_Y = 40;

export interface ProfilerExtras {
  /** Extra "key: value" lines from the game loop (asset loader state, socket...). */
  lines?: [string, string][];
  /** Last keepalive round trip (socket.stats.rttMs); -1 until one answered. */
  pingMs?: number;
}

export class HudProfiler {
  private root?: HTMLElement;
  private graph?: HTMLCanvasElement;
  private head?: HTMLElement;
  private sections?: HTMLElement;
  private counters?: HTMLElement;
  private extras?: HTMLElement;
  private hitches?: HTMLElement;
  private lastRefresh = 0;
  private visible = false;
  /** Pointer offset from the panel's corner while the title bar is held. */
  private drag: { dx: number; dy: number } | null = null;

  mount(root: HTMLElement): void {
    this.root = root;
    root.classList.add('hud-profiler');
    root.hidden = true;
    root.innerHTML = '';

    const title = el('div', 'hud-profiler-title');
    title.textContent = 'Profiler';
    const hint = el('span', 'hud-profiler-hint');
    hint.textContent = 'F2 · __prevastGame.profiler';
    title.appendChild(hint);
    this.mountDrag(title);
    this.restorePosition();

    this.graph = document.createElement('canvas');
    this.graph.className = 'hud-profiler-graph';
    this.graph.width = GRAPH_FRAMES * 2;
    this.graph.height = 40;

    this.head = el('div', 'hud-profiler-head');
    this.sections = el('div', 'hud-profiler-sections');
    this.counters = el('div', 'hud-profiler-counters');
    this.extras = el('div', 'hud-profiler-extras');
    this.hitches = el('div', 'hud-profiler-hitches');
    root.append(
      title,
      this.graph,
      this.head,
      this.sections,
      this.counters,
      this.extras,
      this.hitches,
    );
  }

  get isVisible(): boolean {
    return this.visible;
  }

  private mountDrag(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || !this.root) return;
      const rect = this.root.getBoundingClientRect();
      this.drag = { dx: ev.clientX - rect.left, dy: ev.clientY - rect.top };
      if (typeof handle.setPointerCapture === 'function') {
        try {
          handle.setPointerCapture(ev.pointerId);
        } catch {
          // jsdom / synthetic events: capture is only an optimisation here.
        }
      }
      ev.preventDefault();
    });
    handle.addEventListener('pointermove', (ev) => {
      if (!this.drag) return;
      this.place(ev.clientX - this.drag.dx, ev.clientY - this.drag.dy);
    });
    const release = () => {
      if (!this.drag || !this.root) return;
      this.drag = null;
      writeSetting(
        POSITION_SETTING,
        JSON.stringify({ x: parseFloat(this.root.style.left), y: parseFloat(this.root.style.top) }),
      );
    };
    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);
  }

  /** Puts the panel's top-left corner at (x, y), kept far enough inside the window to grab again. */
  private place(x: number, y: number): void {
    if (!this.root) return;
    const maxX = Math.max(0, window.innerWidth - KEEP_ON_SCREEN_X);
    const maxY = Math.max(0, window.innerHeight - KEEP_ON_SCREEN_Y);
    this.root.style.left = `${Math.round(Math.min(maxX, Math.max(0, x)))}px`;
    this.root.style.top = `${Math.round(Math.min(maxY, Math.max(0, y)))}px`;
  }

  private restorePosition(): void {
    const json = readSetting(POSITION_SETTING);
    if (!json) return;
    try {
      const pos = JSON.parse(json) as { x?: unknown; y?: unknown };
      if (typeof pos.x === 'number' && typeof pos.y === 'number') this.place(pos.x, pos.y);
    } catch {
      // A broken value just leaves the panel at its CSS default.
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.root) this.root.hidden = !visible;
    this.lastRefresh = 0;
  }

  toggle(): boolean {
    this.setVisible(!this.visible);
    return this.visible;
  }

  update(profiler: Profiler, now: number, extras?: ProfilerExtras): void {
    if (!this.visible || !this.root) return;
    if (now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;

    const s = profiler.summary(WINDOW_MS);
    this.renderGraph(profiler);
    this.renderHead(s, extras?.pingMs ?? -1);
    this.renderSections(s);
    this.renderCounters(s);
    this.renderExtras(extras?.lines ?? []);
    this.renderHitches(profiler.summary());
  }

  private renderGraph(profiler: Profiler): void {
    const canvas = this.graph;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const frames = profiler.recentFrames(GRAPH_FRAMES);
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, 0, w, h);
    // 16.7 ms and 33 ms guides.
    const scale = h / 50;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, h - 16.7 * scale, w, 1);
    ctx.fillRect(0, h - 33 * scale, w, 1);
    const barW = w / GRAPH_FRAMES;
    frames.forEach((f, i) => {
      const v = f.interval > 0 ? f.interval : f.tick;
      const barH = Math.min(h, v * scale);
      ctx.fillStyle = v >= 33 ? '#e06666' : v > 17.5 ? '#e0b366' : '#8fcf8f';
      ctx.fillRect(w - (frames.length - i) * barW, h - barH, Math.max(1, barW - 0.5), barH);
      // Tick share of the frame, in a darker tone, so a short tick under a tall bar reads as "not JS".
      const tickH = Math.min(h, f.tick * scale);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(w - (frames.length - i) * barW, h - tickH, Math.max(1, barW - 0.5), tickH);
    });
  }

  private renderHead(s: ProfilerSummary, pingMs: number): void {
    if (!this.head) return;
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const memText = mem ? ` · heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB` : '';
    // fps is the rAF rate: vsync-locked to the display, so 60 on a 60 Hz monitor is the ceiling.
    const ping = pingMs < 0 ? '–' : pingMs.toFixed(0);
    this.head.textContent =
      `${s.fps.toFixed(0)} fps · ping ${ping} ms · frame p50 ${s.interval.p50.toFixed(1)} p95 ${s.interval.p95.toFixed(1)} max ${s.interval.max.toFixed(0)} ms\n` +
      `tick p50 ${s.tick.p50.toFixed(1)} p95 ${s.tick.p95.toFixed(1)} max ${s.tick.max.toFixed(1)} ms · hitches ${s.hitches.count}` +
      ` (js ${s.hitches.js} / pipeline ${s.hitches.pipeline} / task ${s.hitches.longtask})${memText}`;
  }

  private renderSections(s: ProfilerSummary): void {
    if (!this.sections) return;
    const rows = Object.entries(s.sections)
      .filter(([name]) => !name.includes('.'))
      .sort((a, b) => b[1].mean - a[1].mean);
    const children = Object.entries(s.sections).filter(([name]) => name.includes('.'));
    const max = Math.max(0.1, ...rows.map(([, st]) => st.mean));
    this.sections.innerHTML = '';
    for (const [name, st] of rows) {
      this.sections.appendChild(this.bar(name, st.mean, st.max, max));
      for (const [child, cst] of children
        .filter(([c]) => c.startsWith(name + '.'))
        .sort((a, b) => b[1].mean - a[1].mean)) {
        this.sections.appendChild(
          this.bar('  ' + child.slice(name.length + 1), cst.mean, cst.max, max),
        );
      }
    }
  }

  private bar(label: string, mean: number, max: number, scaleMax: number): HTMLElement {
    const row = el('div', 'hud-profiler-row');
    const fill = el('span', 'hud-profiler-bar');
    fill.style.width = `${Math.min(100, (mean / scaleMax) * 100).toFixed(1)}%`;
    const text = el('span', 'hud-profiler-text');
    text.textContent = `${label.padEnd(18, ' ')}${mean.toFixed(2).padStart(6)} ms  max ${max.toFixed(1)}`;
    row.append(fill, text);
    return row;
  }

  private renderCounters(s: ProfilerSummary): void {
    if (!this.counters) return;
    const c = s.counters;
    const line = (name: string, fmt: (v: number) => string = (v) => v.toFixed(0)) =>
      c[name]
        ? `${name} ${fmt(c[name]!.mean)}${c[name]!.max !== c[name]!.mean ? ` (max ${fmt(c[name]!.max)})` : ''}`
        : '';
    this.counters.textContent = [
      line('sprites.draw'),
      line('sprites.firstDraw'),
      line('sprites.miss'),
      line('entities.visible'),
      line('entities.total'),
      line('net.msgs'),
      line('net.bytes', (v) => `${(v / 1024).toFixed(1)} KB`),
    ]
      .filter(Boolean)
      .join(' · ');
  }

  private renderExtras(lines: [string, string][]): void {
    if (!this.extras) return;
    this.extras.textContent = lines.map(([k, v]) => `${k}: ${v}`).join('\n');
  }

  private renderHitches(s: ProfilerSummary): void {
    if (!this.hitches) return;
    const recent = s.hitches.recent.slice(-6).reverse();
    const lines = recent.map((h) => {
      const t = (h.at / 1000).toFixed(1).padStart(7);
      return `${t}s  ${h.interval.toFixed(0).padStart(4)} ms  ${h.kind.padEnd(8)} ${h.blame}`;
    });
    for (const task of s.longTasks.slice(-3).reverse()) {
      lines.push(
        `${(task.at / 1000).toFixed(1).padStart(7)}s  ${task.duration.toFixed(0).padStart(4)} ms  ${task.kind.padEnd(8)} ${task.detail ?? ''}`,
      );
    }
    this.hitches.textContent = lines.length ? lines.join('\n') : 'no hitches yet';
  }
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
