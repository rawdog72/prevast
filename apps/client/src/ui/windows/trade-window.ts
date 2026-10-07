// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/windows/trade-window.ts
// Player-to-player trade, drawn from the server's snapshots (TradeStore): the
// invitation (outgoing: waiting; incoming: accept or decline), then both
// offers side by side with who is ready, a line saying what happens next, and
// Cancel / Accept. Our own rows edit their quantity or come off the offer;
// nothing here moves an item, the server does that when both accept.

import { itemIconUrl } from '../../assets/asset-loader';
import type { ContentStore } from '../../content/store';
import type { TradeItem } from '../../net/events';
import type { GameSocket } from '../../net/socket';
import type { InventoryStore } from '../../world/inventory-store';
import type { TradeStore } from '../../world/trade-store';
import type { WorldState } from '../../world/world-state';
import { icon, type IconName } from '../dom/icons';
import { magazine, rotStage } from '../hud/hud-hotbar';
import { hoverCard } from '../hud/weapon-card';

export interface TradeWindowDeps {
  trade: TradeStore;
  socket: GameSocket;
  content: ContentStore;
  inventory: InventoryStore;
  world: WorldState;
}

/** The window's title bar, retitled with the other player's name. */
export interface TradeChrome {
  title: HTMLElement;
  sub: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(name: IconName, label: string, click: () => void): HTMLButtonElement {
  const button = el('button', 'dv-btn is-icon is-small');
  button.type = 'button';
  button.innerHTML = icon(name);
  button.setAttribute('aria-label', label);
  button.title = label;
  button.addEventListener('click', click);
  return button;
}

export class TradeWindow {
  private body!: HTMLElement;
  private chrome: TradeChrome | null = null;
  private key = '';

  mount(body: HTMLElement, deps: TradeWindowDeps, chrome?: TradeChrome): void {
    this.body = body;
    this.chrome = chrome ?? null;
    this.key = '';
    this.refresh(deps);
  }

  refresh(d: TradeWindowDeps): void {
    const s = d.trade.state;
    if (!s) return;
    // Do not rebuild a focused quantity input on every frame.
    const key = JSON.stringify([s, d.trade.pending, d.trade.closing]);
    if (key === this.key) return;
    this.key = key;
    // The slot a card was over is about to be rebuilt, so its pointerleave never comes.
    hoverCard().hide();
    this.body.replaceChildren();
    const peer = d.world.players.get(s.peer)?.nickname || 'Player';
    const busy = d.trade.pending || d.trade.closing;
    if (this.chrome) {
      this.chrome.title.textContent = 'Trade';
      this.chrome.sub.textContent = `with ${peer}`;
    }

    if (s.phase !== 2) {
      const invite = el('div', 'dv-trade-invite');
      const avatar = el('span', 'dv-trade-avatar', peer.slice(0, 1).toUpperCase());
      const text = el('div', 'dv-trade-invite-text');
      text.append(
        el('strong', '', peer),
        el(
          'span',
          'dv-muted',
          s.phase === 0 ? 'Waiting for an answer…' : 'wants to trade with you.',
        ),
      );
      invite.append(avatar, text);
      if (s.phase === 0) invite.append(el('span', 'dv-spinner is-on'));
      this.body.append(
        invite,
        el(
          'p',
          'dv-trade-hint',
          `Stay within ${s.rangeTiles} tiles of each other while you trade.`,
        ),
      );
    } else {
      const board = el('div', 'dv-trade-board');
      const swap = el('span', 'dv-trade-swap');
      swap.innerHTML = icon('swap');
      board.append(
        this.side('Your offer', s.own, !!(s.accepted & 1), true, d, busy),
        swap,
        this.side(`${peer}'s offer`, s.theirs, !!(s.accepted & 2), false, d, busy),
      );
      this.body.append(
        board,
        el('p', 'dv-trade-hint', this.hint(s.accepted, peer, s.own.length + s.theirs.length)),
      );
    }

    const actions = el('div', 'dv-trade-actions');
    const cancel = el('button', 'dv-btn', s.phase === 1 ? 'Decline' : 'Cancel');
    cancel.type = 'button';
    cancel.disabled = d.trade.closing;
    cancel.addEventListener('click', () => {
      if (s.phase === 1) d.trade.reply(d.socket, false);
      else d.trade.cancel(d.socket);
      this.refresh(d);
    });
    actions.append(cancel);
    if (s.phase !== 0) {
      const mine = !!(s.accepted & 1);
      const accept = el('button', 'dv-btn is-primary dv-trade-primary');
      accept.type = 'button';
      accept.innerHTML = mine ? `${icon('check')}<span>Accepted</span>` : '<span>Accept</span>';
      accept.disabled = busy || (s.phase === 2 && (mine || !(s.own.length + s.theirs.length)));
      accept.addEventListener('click', () => {
        if (s.phase === 1) d.trade.reply(d.socket, true);
        else d.trade.accept(d.socket);
        this.refresh(d);
      });
      actions.append(accept);
    }
    this.body.append(actions);
  }

  private hint(accepted: number, peer: string, offered: number): string {
    if (!offered) return 'Right-click an item and choose Add to trade, or press its hotbar key.';
    if (accepted & 1) return `Waiting for ${peer} to accept. Any change clears both acceptances.`;
    if (accepted & 2) return `${peer} is ready. Accept to complete the trade.`;
    return 'Both players accept to complete the trade. Any change clears both acceptances.';
  }

  private side(
    title: string,
    items: TradeItem[],
    accepted: boolean,
    own: boolean,
    d: TradeWindowDeps,
    busy: boolean,
  ): HTMLElement {
    const section = el(
      'section',
      `dv-trade-side${own ? ' is-own' : ''}${accepted ? ' is-accepted' : ''}`,
    );
    const head = el('header', 'dv-trade-side-head');
    head.append(el('h3', '', title));
    const status = el('span', `dv-trade-status${accepted ? ' is-accepted' : ''}`);
    status.innerHTML = accepted ? `${icon('check')}<span>Ready</span>` : '<span>Not ready</span>';
    head.append(status);
    section.append(head);

    const list = el('div', 'dv-trade-items');
    if (!items.length) list.append(el('p', 'dv-trade-empty', 'Nothing offered yet'));
    for (const item of items) list.append(this.row(item, own, d, busy));
    section.append(list);
    return section;
  }

  private row(item: TradeItem, own: boolean, d: TradeWindowDeps, busy: boolean): HTMLElement {
    const data = d.content.has('items') ? d.content.byId('items', item.iid) : undefined;
    const row = el('div', 'dv-trade-item');
    const art = el('div', 'dv-item-slot');
    if (data?.client?.icon) {
      art.classList.add('has-item');
      art.style.setProperty('--icon', `url(${itemIconUrl(data.client.icon)})`);
    }
    art.append(el('span', 'count', item.count > 1 ? String(item.count) : ''));
    hoverCard().attach(art, d.content, () => item);

    const detail = el('div', 'dv-trade-item-detail');
    const name = el('strong', '', data?.name || data?.key || `Item ${item.iid}`);
    detail.append(name);
    const mag = magazine(item, d.content, item.mods);
    const stage = rotStage(item, d.content);
    if (mag) detail.append(el('small', 'dv-muted', `Ammo ${mag.ammo}/${mag.size}`));
    else if (stage >= 0)
      detail.append(el('small', 'dv-muted', `Freshness ${Math.round((item.ammo / 255) * 100)}%`));
    else if (!own) detail.append(el('small', 'dv-muted', `× ${item.count}`));
    const fitted = item.mods
      .map((m) => d.content.byId('items', m.iid)?.name)
      .filter((n): n is string => !!n);
    if (fitted.length)
      detail.append(el('small', 'dv-muted dv-trade-mods', `Fitted: ${fitted.join(', ')}`));
    row.append(art, detail);
    if (!own) return row;

    const live = d.inventory.slots.find((slot) => slot.uid === item.uid && slot.iid === item.iid);
    const max = Math.min(255, live?.count ?? item.count);
    const stepper = el('div', 'dv-trade-qty');
    const quantity = el('input', 'dv-input');
    quantity.type = 'number';
    quantity.min = '1';
    quantity.step = '1';
    quantity.max = String(max);
    quantity.value = String(item.count);
    quantity.setAttribute('aria-label', `Quantity of ${name.textContent}`);
    quantity.disabled = busy;
    const set = (value: number) => {
      if (Number.isInteger(value) && value > 0 && value <= max)
        d.trade.offer(d.socket, item, value);
      else quantity.value = String(item.count);
    };
    quantity.addEventListener('change', () => set(Number(quantity.value)));
    quantity.addEventListener('blur', () => set(Number(quantity.value)));
    quantity.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        set(Number(quantity.value));
        quantity.blur();
      }
    });
    const less = iconButton('minus', 'One less', () => set(item.count - 1));
    less.disabled = busy || item.count <= 1;
    const more = iconButton('plus', 'One more', () => set(item.count + 1));
    more.disabled = busy || item.count >= max;
    stepper.append(less, quantity, more);
    const remove = iconButton('close', `Remove ${name.textContent}`, () => {
      d.trade.offer(d.socket, item, 0);
      this.refresh(d);
    });
    remove.classList.add('dv-trade-remove');
    remove.disabled = busy;
    detail.append(stepper);
    row.append(remove);
    return row;
  }
}
