// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-status-line.ts
// One line of text just above the hotbar, Tibia's "You see a wooden wall.":
// Look results now, other short notices later. No box -- plain text with a
// shadow. The newest line replaces the last and fades out after a few seconds.

const SHOW_MS = 4000;

export class HudStatusLine {
  private readonly el = document.createElement('div');
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.el.className = 'hud-status-line';
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
  }

  /** Inside the hotbar root, so it sits over the slots and follows the inventory zoom. */
  mount(parent: HTMLElement): void {
    parent.append(this.el);
  }

  get text(): string {
    return this.el.classList.contains('is-visible') ? (this.el.textContent ?? '') : '';
  }

  show(text: string, failure = false): void {
    this.el.textContent = text;
    this.el.classList.toggle('is-failure', failure);
    this.el.classList.add('is-visible');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.el.classList.remove('is-visible'), SHOW_MS);
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.el.remove();
  }
}
