// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-quest-tracker.ts
// Under the minimap: the tracked quests (up to three) with their current
// objectives and live counters. A quest's name opens the journal on it; the
// header folds the list away. Rows that just finished flash briefly.

import type { QuestStore } from '../../world/quest-store';
import { FLASH_MS } from '../../world/quest-store';
import { icon } from '../dom/icons';
import { bagSignature, objectiveRow, type BagCount } from '../windows/quest-window';

export interface QuestTrackerCallbacks {
  onOpen: (questKey: string) => void;
}

export class HudQuestTracker {
  private root!: HTMLElement;
  private callbacks!: QuestTrackerCallbacks;
  private collapsed = false;
  private signature = '';
  /** A flash has to be redrawn away once it is over; this is when. */
  private flashUntil = 0;

  mount(root: HTMLElement, callbacks: QuestTrackerCallbacks): void {
    this.root = root;
    this.callbacks = callbacks;
    this.signature = '';
  }

  update(quests: QuestStore, timeMs: number, bag?: BagCount): void {
    const tracked = quests.trackedRecords;
    const flashing = timeMs < this.flashUntil;
    const signature = `${quests.version}:${this.collapsed}:${tracked.length}:${flashing}:${bagSignature(tracked, bag)}`;
    if (signature === this.signature) return;
    this.signature = signature;

    this.root.hidden = tracked.length === 0;
    this.root.replaceChildren();
    if (!tracked.length) return;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'hud-quests-head';
    head.innerHTML = icon(this.collapsed ? 'caret_down' : 'caret_up');
    head.append('Quests');
    head.setAttribute('aria-expanded', String(!this.collapsed));
    head.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.signature = '';
    });
    this.root.append(head);
    if (this.collapsed) return;

    let anyFlash = false;
    for (const { entry } of tracked) {
      const block = document.createElement('div');
      block.className = 'hud-quest';
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'hud-quest-name';
      name.textContent = entry.name;
      name.title = 'Open the journal [J]';
      name.addEventListener('click', () => this.callbacks.onOpen(entry.key));
      block.append(name);
      const stage = entry.stages.find((s) => s.current);
      for (const objective of stage?.objectives ?? []) {
        const flash = quests.isFlashing(entry.key, objective.key);
        anyFlash ||= flash;
        block.append(objectiveRow(objective, flash, bag));
      }
      this.root.append(block);
    }
    if (anyFlash) this.flashUntil = timeMs + FLASH_MS;
  }
}
