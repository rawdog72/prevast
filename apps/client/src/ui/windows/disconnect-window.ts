// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The dialog shown when the connection ends in game: why, and what the player
// can do, over a dimmed picture of the last frame. The game itself is already
// stopped by then -- a new GameLoop cannot share the HUD with the old one, so
// a reconnect builds the next one only after the last is gone. Markup is
// #dv-disconnect in apps/client/public/index.html; wording is join-messages.ts.
import {
  DISCONNECT_ACTION_LABELS,
  type DisconnectAction,
  type DisconnectView,
} from '../home/join-messages';

export class DisconnectWindow {
  private readonly backdrop: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly message: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly actions: HTMLElement;

  constructor(private readonly root: HTMLElement) {
    const part = (selector: string): HTMLElement => {
      const el = root.querySelector<HTMLElement>(selector);
      if (!el) throw new Error(`#dv-disconnect is missing ${selector}`);
      return el;
    };
    this.backdrop = part('.dv-disconnect-backdrop');
    this.panel = part('.dv-disconnect-panel');
    this.title = part('h2');
    this.message = part('.dv-disconnect-message');
    this.detail = part('.dv-disconnect-detail');
    this.actions = part('.dv-disconnect-actions');
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** `backdropUrl` is a data URL of the last frame (canvas.toDataURL), or '' for none. */
  open(backdropUrl: string): void {
    this.backdrop.style.backgroundImage = backdropUrl ? `url("${backdropUrl}")` : '';
    this.root.hidden = false;
  }

  render(view: DisconnectView, onAction: (action: DisconnectAction) => void): void {
    this.title.textContent = view.title;
    this.message.textContent = view.message;
    this.detail.textContent = view.detail;
    this.panel.setAttribute('aria-busy', String(view.busy));
    const doc = this.root.ownerDocument;
    this.actions.replaceChildren(
      ...view.actions.map((action, i) => {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = i === 0 ? 'dv-btn is-primary' : 'dv-btn';
        button.dataset.action = action;
        button.textContent = DISCONNECT_ACTION_LABELS[action];
        button.addEventListener('click', () => onAction(action));
        return button;
      }),
    );
    this.actions.querySelector<HTMLButtonElement>('button')?.focus();
  }

  close(): void {
    this.root.hidden = true;
    this.actions.replaceChildren();
    this.backdrop.style.backgroundImage = '';
  }
}
