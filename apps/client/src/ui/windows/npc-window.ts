// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { NpcAction, NPC_MAX_MONEY } from '../../../../../shared/typescript/npc-protocol';
import { itemIconUrl } from '../../assets/asset-loader';
import type { ContentStore } from '../../content/store';
import type { GameSocket } from '../../net/socket';
import type { NpcStore } from '../../world/npc-store';
import { icon, type IconName } from '../dom/icons';

interface NpcWindowDeps { npc: NpcStore; socket: GameSocket; content: ContentStore }
const caps = (value: number) => `${value.toLocaleString()} caps`;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.className = className; el.textContent = text; return el;
}
function button(label: string, action: () => void, disabled = false): HTMLButtonElement {
  const el = element('button', 'dv-btn dv-npc-button', label); el.type = 'button'; el.disabled = disabled;
  el.addEventListener('click', action); return el;
}
function iconButton(name: IconName, label: string, action: () => void, disabled = false): HTMLButtonElement {
  const el = button('', action, disabled); el.classList.add('is-icon'); el.innerHTML = icon(name);
  el.setAttribute('aria-label', label); el.title = label; return el;
}

export class NpcWindow {
  private body!: HTMLElement;
  private signature = '';
  private mode: 'buy' | 'sell' = 'buy';
  private selected = -1;
  private quantity = 1;
  private session = 0;
  mount(body: HTMLElement, d: NpcWindowDeps): void {
    this.body = body; this.signature = ''; this.refresh(d);
  }
  refresh(d: NpcWindowDeps): void {
    const s = d.npc.state;
    if (!s) return;
    const signature = `${s.session}:${s.revision}:${d.npc.pending}:${this.mode}:${this.selected}`;
    if (signature === this.signature) return;
    if (s.session !== this.session) { this.session = s.session; this.selected = -1; this.quantity = 1; this.mode = 'buy'; }
    this.signature = signature;
    this.body.replaceChildren();
    const header = element('div', 'dv-npc-summary');
    header.append(element('strong', '', s.name), element('span', 'dv-npc-wallet', `Carried: ${caps(s.wallet)}`));
    this.body.append(header);
    if (s.panel === 'bank') { this.bank(d); return; }
    const tabs = element('div', 'dv-npc-tabs');
    for (const mode of ['buy', 'sell'] as const) {
      const tab = button(mode === 'buy' ? 'Buy' : 'Sell', () => {
        this.mode = mode; this.selected = -1; this.quantity = 1; this.refresh(d);
      });
      tab.classList.toggle('is-active', this.mode === mode); tabs.append(tab);
    }
    tabs.append(iconButton('refresh', 'Refresh available quantities', () => d.npc.command(d.socket, NpcAction.REFRESH), d.npc.pending));
    this.body.append(tabs);
    const offers = s.offers.filter(o => (this.mode === 'buy' ? o.buy : o.sell) > 0);
    if (!offers.some(o => o.index === this.selected)) this.selected = offers[0]?.index ?? -1;
    const columns = element('div', 'dv-npc-columns');
    const list = element('div', 'dv-npc-catalogue');
    list.setAttribute('aria-label', 'Merchant items');
    for (const offer of offers) {
      const item = d.content.has('items') ? d.content.byId('items', offer.iid) : undefined;
      const row = button('', () => { this.selected = offer.index; this.quantity = 1; this.refresh(d); });
      row.className = `dv-npc-offer${this.selected === offer.index ? ' is-selected' : ''}`;
      const art = element('img', 'dv-npc-icon');
      art.alt = ''; if (item?.client?.icon) art.src = itemIconUrl(item.client.icon);
      const detail = element('span', 'dv-npc-offer-text');
      detail.append(element('strong', '', item?.name ?? `Item ${offer.iid}`), element('small', '', caps(this.mode === 'buy' ? offer.buy : offer.sell)));
      if (offer.rare) detail.append(element('small', 'dv-npc-rare', 'Rare stock'));
      row.append(art, detail); list.append(row);
    }
    if (!offers.length) list.append(element('p', 'dv-npc-empty', 'Nothing available.'));
    const detail = element('section', 'dv-npc-detail');
    const selected = offers.find(o => o.index === this.selected);
    if (selected) {
      const item = d.content.has('items') ? d.content.byId('items', selected.iid) : undefined;
      detail.append(element('h3', '', item?.name ?? `Item ${selected.iid}`));
      if (item?.client?.description) detail.append(element('p', 'dv-npc-description', item.client.description));
      const max = this.mode === 'buy' ? selected.buyMax : selected.sellMax;
      const price = this.mode === 'buy' ? selected.buy : selected.sell;
      detail.append(element('small', 'dv-npc-stock', this.mode === 'buy'
        ? selected.unlimited ? 'In stock' : `${selected.stock} in stock` : `${max} available to sell`));
      this.quantity = Math.max(1, Math.min(this.quantity, max || 1));
      const controls = element('div', 'dv-npc-quantity');
      const input = element('input', 'dv-input'); input.type = 'number'; input.min = '1'; input.max = String(max); input.step = '1';
      input.value = String(this.quantity); input.setAttribute('aria-label', 'Quantity');
      const slider = element('input', 'dv-npc-slider'); slider.type = 'range'; slider.min = '1'; slider.max = String(Math.max(1, max)); slider.step = '1';
      slider.value = input.value; slider.setAttribute('aria-label', 'Quantity slider');
      const total = element('strong', 'dv-npc-total', caps(price * this.quantity));
      const set = (n: number) => {
        this.quantity = Number.isFinite(n) ? Math.max(1, Math.min(Math.floor(n), max || 1)) : 1;
        input.value = slider.value = String(this.quantity); total.textContent = caps(price * this.quantity);
      };
      input.addEventListener('change', () => set(input.valueAsNumber));
      slider.addEventListener('input', () => set(slider.valueAsNumber));
      controls.append(iconButton('minus', 'One less', () => set(this.quantity - 1), !max || d.npc.pending), input,
        iconButton('plus', 'One more', () => set(this.quantity + 1), !max || d.npc.pending), button('Max', () => set(max), !max || d.npc.pending));
      input.disabled = slider.disabled = !max || d.npc.pending;
      const action = button(this.mode === 'buy' ? 'Buy' : 'Sell', () => {
        set(input.valueAsNumber);
        d.npc.command(d.socket, this.mode === 'buy' ? NpcAction.BUY : NpcAction.SELL, selected.index, this.quantity);
        this.refresh(d);
      }, !max || !s.tradeAllowed || d.npc.pending);
      action.classList.add('is-primary', 'dv-npc-primary');
      detail.append(controls, slider, total, action);
      if (!max) detail.append(element('small', 'dv-npc-empty', this.mode === 'buy' ? 'Check your funds, bag space and stock.' : 'No eligible unequipped items.'));
    }
    columns.append(list, detail); this.body.append(columns);
    const minutes = Math.ceil(s.restockSeconds / 60);
    this.body.append(element('small', 'dv-npc-restock', `Next restock in about ${minutes} min`));
  }
  private bank(d: NpcWindowDeps): void {
    const s = d.npc.state!;
    this.body.append(element('h3', 'dv-npc-bank-balance', `Bank: ${caps(s.balance)}`));
    const rows = element('div', 'dv-npc-bank');
    for (const [label, action, max] of [
      ['Deposit', NpcAction.DEPOSIT, Math.min(s.wallet, NPC_MAX_MONEY - s.balance)],
      ['Withdraw', NpcAction.WITHDRAW, s.balance],
      ['Convert', NpcAction.CONVERT, s.wallet],
    ] as const) {
      const row = element('div', 'dv-npc-bank-row');
      const input = element('input', 'dv-input'); input.type = 'number'; input.min = '1'; input.max = String(max); input.step = '1'; input.value = '1'; input.setAttribute('aria-label', `${label} amount in caps`);
      const denomination = element('select', 'dv-input'); denomination.setAttribute('aria-label', 'Convert to');
      for (const [value, name] of ['Bottle caps', 'Banknotes', 'Gold bars'].entries()) {
        const option = element('option', '', name); option.value = String(value); denomination.append(option);
      }
      row.append(element('label', '', `${label} (caps)`), input,
        button('Max', () => { input.value = String(max); }, !max || d.npc.pending));
      if (action === NpcAction.CONVERT) row.append(denomination);
      const confirm = button(label, () => {
        const amount = input.valueAsNumber;
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > max) { input.reportValidity(); return; }
        d.npc.command(d.socket, action, action === NpcAction.CONVERT ? Number(denomination.value) : 0, amount);
        this.refresh(d);
      }, !max || !s.tradeAllowed || d.npc.pending);
      confirm.classList.add('is-primary'); row.append(confirm); rows.append(row);
    }
    this.body.append(rows);
  }
}
