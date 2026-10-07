// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { Profiler } from './profiler';

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('Profiler', () => {
  it('is inert until enabled: no frames recorded, begin/end are no-ops', () => {
    const c = clock();
    const p = new Profiler({ now: c.now });
    p.frameBegin();
    p.begin('render');
    c.advance(5);
    p.end('render');
    p.frameEnd();
    expect(p.summary().frames).toBe(0);
  });

  it('records the rAF interval, the tick time and nested section times per frame', () => {
    const c = clock();
    const p = new Profiler({ now: c.now });
    p.enable();

    p.frameBegin();
    p.begin('world');
    c.advance(2);
    p.end('world');
    p.begin('render');
    p.begin('render.buildings');
    c.advance(3);
    p.end('render.buildings');
    c.advance(1);
    p.end('render');
    p.frameEnd();

    c.advance(10); // idle until the next rAF
    p.frameBegin();
    c.advance(4);
    p.frameEnd();

    const s = p.summary();
    expect(s.frames).toBe(2);
    expect(p.lastFrame()?.interval).toBe(16); // 6 ms tick + 10 ms idle
    expect(p.lastFrame()?.tick).toBe(4);
    expect(s.sections.world?.max).toBe(2);
    expect(s.sections.render?.max).toBe(4);
    expect(s.sections['render.buildings']?.max).toBe(3);
  });

  it('accumulates a section entered several times in one frame', () => {
    const c = clock();
    const p = new Profiler({ now: c.now });
    p.enable();
    p.frameBegin();
    for (let i = 0; i < 3; i++) {
      p.begin('layer');
      c.advance(1);
      p.end('layer');
    }
    p.frameEnd();
    expect(p.lastFrame()?.sections.layer).toBe(3);
  });

  it('counts per-frame increments and cumulative deltas', () => {
    const c = clock();
    const p = new Profiler({ now: c.now });
    p.enable();
    p.frameBegin();
    p.count('draw', 5);
    p.count('draw', 2);
    p.delta('net.bytes', 1000);
    p.frameEnd();
    p.frameBegin();
    p.delta('net.bytes', 1300);
    p.gauge('entities', 42);
    p.frameEnd();
    const frames = p.recentFrames(2);
    expect(frames[0]?.counters.draw).toBe(7);
    expect(frames[0]?.counters['net.bytes']).toBe(0); // first sample only seeds the baseline
    expect(frames[1]?.counters['net.bytes']).toBe(300);
    expect(frames[1]?.counters.entities).toBe(42);
  });

  it('classifies hitches: a long tick blames its slowest section, a long gap after a short tick blames the pipeline', () => {
    const c = clock();
    const p = new Profiler({ now: c.now, hitchMs: 33 });
    p.enable();

    // Warm-up frame so the next one has an interval.
    p.frameBegin();
    c.advance(1);
    p.frameEnd();
    c.advance(15);

    // JS-bound: a 50 ms tick dominated by 'hud'.
    p.frameBegin();
    p.begin('world');
    c.advance(5);
    p.end('world');
    p.begin('hud');
    c.advance(45);
    p.end('hud');
    p.frameEnd();

    // A short tick that drew four sprites for the first time...
    p.frameBegin();
    p.count('sprites.firstDraw', 4);
    c.advance(3);
    p.frameEnd();
    // ...followed by a 77 ms gap before the browser gave us the next frame.
    c.advance(77);
    p.frameBegin();
    c.advance(1);
    p.frameEnd();

    const hitches = p.summary().hitches;
    expect(hitches.count).toBe(2);
    expect(hitches.recent[0]).toMatchObject({ kind: 'js', blame: 'hud', tick: 50 });
    expect(hitches.recent[1]).toMatchObject({ kind: 'pipeline', interval: 80, tick: 3 });
    expect(hitches.recent[1]?.counters['sprites.firstDraw']).toBe(4);
    expect(hitches.recent[1]?.blame).toContain('4 new sprite');
  });

  it('classifies a gap that overlapped a long task as such', () => {
    const c = clock();
    const p = new Profiler({ now: c.now, hitchMs: 33 });
    p.enable();
    p.frameBegin();
    c.advance(2);
    p.frameEnd();
    c.advance(60);
    p.recordLongTask({ at: 1010, duration: 55, kind: 'longtask' });
    p.frameBegin();
    c.advance(2);
    p.frameEnd();
    expect(p.summary().hitches.recent[0]).toMatchObject({ kind: 'longtask' });
  });

  it('summarises percentiles over the requested window only', () => {
    const c = clock();
    const p = new Profiler({ now: c.now });
    p.enable();
    for (let i = 0; i < 10; i++) {
      p.frameBegin();
      c.advance(i === 0 ? 40 : 4);
      p.frameEnd();
      c.advance(12);
    }
    const all = p.summary();
    expect(all.tick.max).toBe(40);
    const recent = p.summary(50);
    expect(recent.frames).toBeLessThan(10);
    expect(recent.tick.max).toBe(4);
    expect(recent.fps).toBeGreaterThan(50);
  });

  it('keeps only the newest frames once the ring buffer is full', () => {
    const c = clock();
    const p = new Profiler({ now: c.now, capacity: 4 });
    p.enable();
    for (let i = 0; i < 6; i++) {
      p.frameBegin();
      c.advance(i + 1);
      p.frameEnd();
    }
    const ticks = p.recentFrames(10).map((f) => f.tick);
    expect(ticks).toEqual([3, 4, 5, 6]);
  });

  it('records external long tasks and clears everything on reset', () => {
    const c = clock();
    const p = new Profiler({ now: c.now });
    p.enable();
    p.recordLongTask({ at: 5, duration: 120, kind: 'longtask', detail: 'self' });
    p.frameBegin();
    p.frameEnd();
    expect(p.summary().longTasks).toHaveLength(1);
    p.reset();
    expect(p.summary().frames).toBe(0);
    expect(p.summary().longTasks).toHaveLength(0);
  });

  it('warns about unbalanced end() without throwing', () => {
    const c = clock();
    const p = new Profiler({ now: c.now });
    p.enable();
    p.frameBegin();
    expect(() => p.end('never-begun')).not.toThrow();
    p.frameEnd();
    expect(p.lastFrame()?.sections['never-begun']).toBeUndefined();
  });
});
