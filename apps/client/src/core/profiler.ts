// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Frame profiler for the game client. Answers "where did that hitch come
// from?" with numbers rather than guesses: every frame records the rAF
// interval (what the player actually sees), the time spent in tick() and a
// breakdown by named section (world update, each render layer, HUD DOM, ...),
// plus per-frame counters fed by the asset loader, socket and renderer. Frames
// longer than `hitchMs` are kept with their full breakdown and classified:
//   'js'       the tick itself was long -> blame the slowest section;
//   'pipeline' the tick was short but the frame was late -> decode / raster /
//              GC / compositor, i.e. work the main thread did not run itself
//              (the `sprites.firstDraw` counter usually names it: a sprite
//              rasterised for the first time costs 5-20 ms);
//   'longtask' a Long Task overlapped the frame (network decode, GC, ...).
// Disabled it costs one boolean test per call. Enabled with `userTiming` it
// also emits performance.measure() entries so the sections show up in the
// DevTools Performance panel's Timings track.

export interface ProfilerOptions {
  now?: () => number;
  /** Frames kept in the ring buffer. */
  capacity?: number;
  /** A frame interval at or above this is a hitch. */
  hitchMs?: number;
  /** Hitches and long tasks kept. */
  eventCapacity?: number;
}

export interface FrameSample {
  /** Clock at frameBegin(). */
  at: number;
  /** ms since the previous frameBegin(); 0 for the first frame. */
  interval: number;
  /** ms between frameBegin() and frameEnd(): the main-thread cost of the tick. */
  tick: number;
  sections: Record<string, number>;
  counters: Record<string, number>;
}

export type HitchKind = 'js' | 'pipeline' | 'longtask';

export interface HitchRecord extends FrameSample {
  kind: HitchKind;
  /** Slowest section for 'js' hitches, else the classification reason. */
  blame: string;
}

export interface LongTaskSample {
  at: number;
  duration: number;
  kind: 'longtask' | 'loaf';
  detail?: string;
}

export interface Stat {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export interface CounterStat {
  mean: number;
  max: number;
  total: number;
}

export interface ProfilerSummary {
  frames: number;
  windowMs: number;
  fps: number;
  interval: Stat;
  tick: Stat;
  sections: Record<string, Stat>;
  counters: Record<string, CounterStat>;
  hitches: { count: number; js: number; pipeline: number; longtask: number; recent: HitchRecord[] };
  longTasks: LongTaskSample[];
}

const EMPTY_STAT: Stat = { n: 0, mean: 0, p50: 0, p95: 0, max: 0 };

function stat(values: number[]): Stat {
  if (values.length === 0) return EMPTY_STAT;
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    n: sorted.length,
    mean: sum / sorted.length,
    p50: q(0.5),
    p95: q(0.95),
    max: sorted[sorted.length - 1]!,
  };
}

export class Profiler {
  private readonly now: () => number;
  private readonly capacity: number;
  private readonly eventCapacity: number;
  readonly hitchMs: number;

  private enabled = false;
  /** Emit performance.measure() per section (DevTools Timings track). */
  userTiming = false;

  private readonly frames: FrameSample[] = [];
  private head = 0;
  private filled = 0;
  private readonly hitches: HitchRecord[] = [];
  private readonly longTasks: LongTaskSample[] = [];

  // Current frame.
  private inFrame = false;
  private frameStart = 0;
  private lastFrameStart = -1;
  private sections: Record<string, number> = {};
  private counters: Record<string, number> = {};
  private readonly stackNames: string[] = [];
  private readonly stackStarts: number[] = [];
  private readonly baselines = new Map<string, number>();
  private longTaskInFrame = 0;

  private observers: { disconnect(): void }[] = [];

  constructor(options: ProfilerOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.capacity = options.capacity ?? 600;
    this.hitchMs = options.hitchMs ?? 33;
    this.eventCapacity = options.eventCapacity ?? 60;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
    this.inFrame = false;
    this.stackNames.length = 0;
    this.stackStarts.length = 0;
  }

  reset(): void {
    this.frames.length = 0;
    this.head = 0;
    this.filled = 0;
    this.hitches.length = 0;
    this.longTasks.length = 0;
    this.baselines.clear();
    this.lastFrameStart = -1;
    this.longTaskInFrame = 0;
  }

  // ---- frame lifecycle ----------------------------------------------------

  frameBegin(now: number = this.now()): void {
    if (!this.enabled) return;
    this.inFrame = true;
    this.frameStart = now;
    this.sections = {};
    this.counters = {};
    this.stackNames.length = 0;
    this.stackStarts.length = 0;
  }

  frameEnd(): void {
    if (!this.enabled || !this.inFrame) return;
    this.inFrame = false;
    const end = this.now();
    // Close anything left open so a thrown exception mid-frame cannot skew
    // the next frame.
    while (this.stackNames.length) this.closeTop();

    // Clamped: a manual tick() interleaved with the rAF loop can hand in a
    // timestamp older than the previous frame's.
    const sample: FrameSample = {
      at: this.frameStart,
      interval: this.lastFrameStart < 0 ? 0 : Math.max(0, this.frameStart - this.lastFrameStart),
      tick: Math.max(0, end - this.frameStart),
      sections: this.sections,
      counters: this.counters,
    };
    this.lastFrameStart = this.frameStart;
    const previous = this.lastFrame();
    this.push(sample);

    this.classify(sample, previous);
    this.longTaskInFrame = 0;
  }

  lastFrame(): FrameSample | undefined {
    if (this.filled === 0) return undefined;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.frames[idx];
  }

  /** Oldest to newest. */
  recentFrames(n: number): FrameSample[] {
    const count = Math.min(n, this.filled);
    const out: FrameSample[] = [];
    for (let i = count; i > 0; i--) {
      out.push(this.frames[(this.head - i + this.capacity) % this.capacity]!);
    }
    return out;
  }

  // ---- sections & counters ------------------------------------------------

  begin(name: string): void {
    if (!this.enabled || !this.inFrame) return;
    this.stackNames.push(name);
    this.stackStarts.push(this.now());
  }

  end(name: string): void {
    if (!this.enabled || !this.inFrame) return;
    const top = this.stackNames.length - 1;
    // Unbalanced: drop the call rather than corrupt the stack.
    if (top < 0 || this.stackNames[top] !== name) return;
    this.closeTop();
  }

  private closeTop(): void {
    const name = this.stackNames.pop()!;
    const start = this.stackStarts.pop()!;
    const t = this.now();
    this.sections[name] = (this.sections[name] ?? 0) + (t - start);
    if (this.userTiming && typeof performance !== 'undefined' && 'measure' in performance) {
      try {
        performance.measure(name, { start, end: t });
      } catch {
        // Older engines only accept mark names here; not worth a polyfill.
      }
    }
  }

  /** Adds `n` to a per-frame counter (draw calls, cache misses, ...). */
  count(name: string, n = 1): void {
    if (!this.enabled || !this.inFrame) return;
    this.counters[name] = (this.counters[name] ?? 0) + n;
  }

  /** Records an absolute value for this frame (entity count, resident MB, ...). */
  gauge(name: string, value: number): void {
    if (!this.enabled || !this.inFrame) return;
    this.counters[name] = value;
  }

  /**
   * Records how much a cumulative counter (bytes received, sprites loaded)
   * grew since the previous call. The first call only seeds the baseline.
   */
  delta(name: string, cumulative: number): void {
    if (!this.enabled || !this.inFrame) return;
    const prev = this.baselines.get(name);
    this.baselines.set(name, cumulative);
    this.counters[name] = prev === undefined ? 0 : cumulative - prev;
  }

  // ---- long tasks -----------------------------------------------------------

  recordLongTask(sample: LongTaskSample): void {
    if (!this.enabled) return;
    this.longTasks.push(sample);
    if (this.longTasks.length > this.eventCapacity) this.longTasks.shift();
    this.longTaskInFrame += sample.duration;
  }

  /**
   * Subscribes to the browser's Long Animation Frames (script attribution)
   * or, failing that, Long Tasks. Safe to call in any environment.
   */
  observeBrowser(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    const supported: string[] =
      (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes ??
      [];
    const type = supported.includes('long-animation-frame')
      ? 'long-animation-frame'
      : supported.includes('longtask')
        ? 'longtask'
        : '';
    if (!type) return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < 50) continue;
          this.recordLongTask({
            at: entry.startTime,
            duration: entry.duration,
            kind: type === 'longtask' ? 'longtask' : 'loaf',
            detail: describeLongFrame(entry),
          });
        }
      });
      observer.observe({ type, buffered: false });
      this.observers.push(observer);
    } catch {
      // Not supported here: the frame classifier still works without it.
    }
  }

  destroy(): void {
    for (const o of this.observers) o.disconnect();
    this.observers = [];
    this.disable();
  }

  // ---- summary ----------------------------------------------------------------

  /** Aggregates the frames of the last `windowMs` (every buffered frame when 0). */
  summary(windowMs = 0): ProfilerSummary {
    const all = this.recentFrames(this.filled);
    const cutoff = windowMs > 0 && all.length ? all[all.length - 1]!.at - windowMs : -Infinity;
    const frames = windowMs > 0 ? all.filter((f) => f.at >= cutoff) : all;

    const intervals: number[] = [];
    const ticks: number[] = [];
    const sectionValues = new Map<string, number[]>();
    const counterValues = new Map<string, number[]>();
    for (const f of frames) {
      if (f.interval > 0) intervals.push(f.interval);
      ticks.push(f.tick);
      for (const [k, v] of Object.entries(f.sections)) {
        let list = sectionValues.get(k);
        if (!list) sectionValues.set(k, (list = []));
        list.push(v);
      }
      for (const [k, v] of Object.entries(f.counters)) {
        let list = counterValues.get(k);
        if (!list) counterValues.set(k, (list = []));
        list.push(v);
      }
    }

    const sections: Record<string, Stat> = {};
    for (const [k, v] of sectionValues) sections[k] = stat(v);
    const counters: Record<string, CounterStat> = {};
    for (const [k, v] of counterValues) {
      let total = 0;
      let max = 0;
      for (const x of v) {
        total += x;
        if (x > max) max = x;
      }
      counters[k] = { mean: total / v.length, max, total };
    }

    const span = frames.length >= 2 ? frames[frames.length - 1]!.at - frames[0]!.at : 0;
    const fps = span > 0 ? ((frames.length - 1) * 1000) / span : 0;

    const hitches = windowMs > 0 ? this.hitches.filter((h) => h.at >= cutoff) : this.hitches;
    const longTasks = windowMs > 0 ? this.longTasks.filter((t) => t.at >= cutoff) : this.longTasks;
    return {
      frames: frames.length,
      windowMs: windowMs > 0 ? windowMs : span,
      fps,
      interval: stat(intervals),
      tick: stat(ticks),
      sections,
      counters,
      hitches: {
        count: hitches.length,
        js: hitches.filter((h) => h.kind === 'js').length,
        pipeline: hitches.filter((h) => h.kind === 'pipeline').length,
        longtask: hitches.filter((h) => h.kind === 'longtask').length,
        recent: [...hitches],
      },
      longTasks: [...longTasks],
    };
  }

  /** Everything buffered, JSON-friendly, for `download()` or a bug report. */
  report(): ProfilerSummary & { framesRaw: FrameSample[]; generatedAt: string } {
    return {
      ...this.summary(),
      framesRaw: this.recentFrames(this.filled),
      generatedAt: new Date().toISOString(),
    };
  }

  // ---- internals ----------------------------------------------------------------

  private push(sample: FrameSample): void {
    this.frames[this.head] = sample;
    this.head = (this.head + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  /**
   * A long tick is a JS hitch of this frame. A long gap between the previous
   * tick's end and this frame's start is a stall the main thread did not run
   * itself (raster of freshly decoded sprites, GC, a long task): it is blamed
   * on the previous frame, whose draws caused it, with that frame's counters.
   */
  private classify(sample: FrameSample, previous: FrameSample | undefined): void {
    if (sample.tick >= this.hitchMs) {
      this.pushHitch({
        ...sample,
        kind: 'js',
        blame: slowestLeafSection(sample.sections) || 'tick',
      });
      return;
    }
    if (!previous || sample.interval <= 0) return;
    const gap = sample.interval - previous.tick;
    if (gap < this.hitchMs) return;
    if (this.longTaskInFrame > 0) {
      this.pushHitch({
        ...previous,
        interval: sample.interval,
        kind: 'longtask',
        blame: `long task ${this.longTaskInFrame.toFixed(0)} ms`,
      });
      return;
    }
    const firstDraws = previous.counters['sprites.firstDraw'] ?? 0;
    this.pushHitch({
      ...previous,
      interval: sample.interval,
      kind: 'pipeline',
      blame: firstDraws > 0 ? `${firstDraws} new sprite(s) rasterised` : 'raster / GC / compositor',
    });
  }

  private pushHitch(hitch: HitchRecord): void {
    this.hitches.push(hitch);
    if (this.hitches.length > this.eventCapacity) this.hitches.shift();
  }
}

/** The slowest section that has no children (a parent always outlasts its children). */
function slowestLeafSection(sections: Record<string, number>): string {
  const names = Object.keys(sections);
  let worst = '';
  let worstMs = -1;
  for (const name of names) {
    const ms = sections[name]!;
    if (ms <= worstMs) continue;
    if (names.some((other) => other !== name && other.startsWith(name + '.'))) continue;
    worst = name;
    worstMs = ms;
  }
  return worst;
}

function describeLongFrame(entry: PerformanceEntry): string | undefined {
  const loaf = entry as PerformanceEntry & {
    scripts?: {
      sourceURL?: string;
      sourceFunctionName?: string;
      invokerType?: string;
      duration: number;
    }[];
    styleAndLayoutStart?: number;
  };
  if (!loaf.scripts || loaf.scripts.length === 0) return undefined;
  const top = [...loaf.scripts].sort((a, b) => b.duration - a.duration)[0]!;
  const fn = top.sourceFunctionName || top.invokerType || '?';
  const file = (top.sourceURL ?? '').split('/').pop() ?? '';
  let detail = `${fn}${file ? ` (${file})` : ''} ${top.duration.toFixed(0)} ms`;
  if (loaf.styleAndLayoutStart) {
    detail += `, style/layout ${(entry.startTime + entry.duration - loaf.styleAndLayoutStart).toFixed(0)} ms`;
  }
  return detail;
}
