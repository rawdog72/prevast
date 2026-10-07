// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/trade-cursor.ts
// The item riding on the cursor while "Trade with…" waits for a player to be
// clicked (game/trade-targeting.ts): its icon and a one-line hint, following
// the pointer. Written only when something changed; it is updated per frame.

export class TradeCursor {
  private readonly root = document.createElement('div');
  private readonly icon = document.createElement('div');
  private readonly label = document.createElement('span');
  private shown = '';

  constructor() {
    this.root.className = 'dv-trade-cursor';
    this.root.hidden = true;
    this.icon.className = 'dv-trade-cursor-icon';
    this.root.append(this.icon, this.label);
    document.body.append(this.root);
  }

  show(x: number, y: number, iconUrl: string, text: string): void {
    const key = `${iconUrl}\n${text}`;
    if (key !== this.shown) {
      this.shown = key;
      this.icon.style.backgroundImage = iconUrl ? `url(${iconUrl})` : '';
      this.label.textContent = text;
    }
    this.root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  destroy(): void {
    this.root.remove();
  }
}
