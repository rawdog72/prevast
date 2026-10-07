// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-stats.ts
// The small "60 fps · 42 ms" line under the minimap cluster (Options > Stats).
// Counts the frames it is fed itself, so it costs nothing when hidden and
// never needs the full F2 profiler running; the ping is the socket's last
// keepalive round trip. Text is rewritten twice a second, and only on change.

const WINDOW_MS = 500;

export class HudStats {
  private root?: HTMLElement;
  private visible = false;
  private frames = 0;
  private windowStart = 0;
  private lastText = '';

  mount(root: HTMLElement): void {
    this.root = root;
    root.classList.add('hud-stats');
    root.hidden = true;
    root.textContent = '';
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.root) this.root.hidden = !visible;
    // A fresh window: the frames that never ran while hidden must not count.
    this.windowStart = 0;
    this.frames = 0;
  }

  /** Once per frame. `pingMs` < 0 means no pong has been timed yet. */
  update(now: number, pingMs: number): void {
    if (!this.visible || !this.root) return;
    if (this.windowStart === 0) {
      this.windowStart = now;
      this.frames = 0;
      return;
    }
    this.frames++;
    const elapsed = now - this.windowStart;
    if (elapsed < WINDOW_MS) return;
    const fps = Math.round((this.frames * 1000) / elapsed);
    this.frames = 0;
    this.windowStart = now;
    const ping = pingMs < 0 ? '–' : String(Math.round(pingMs));
    const text = `${fps} fps · ${ping} ms`;
    if (text !== this.lastText) {
      this.lastText = text;
      this.root.textContent = text;
    }
  }
}
