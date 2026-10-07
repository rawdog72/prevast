// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/windows/clan-window.ts
// The old client's generated clan window (GameUI.clan), as DOM.
//
// Not in a clan: "Create a clan" (name + Create) and the AVAILABLE CLANS list
// with a Request button per clan. In a clan: the clan name as the title, "N
// members", the lock status, an owner card with a code-drawn crown, MEMBERS in
// two columns (a leader gets Remove on each), then the footer -- lock/unlock +
// Delete clan for the leader, Leave clan for a member. Everything here is a
// view of ClanStore; the buttons only send the old client's packets.

import type { ClanStore } from '../../world/clan-store';
import { icon } from '../dom/icons';
import { badgeNodes, badgesFor } from '../badges';

export interface ClanWindowCallbacks {
  onCreate: (name: string) => void;
  onRequest: (clanId: number) => void;
  onKick: (guid: number) => void;
  onLock: () => void;
  onUnlock: () => void;
  onDelete: () => void;
  onLeave: () => void;
}

/** Content-driven rules (config table) plus the clock, injectable for tests. */
export interface ClanRules {
  nameMaxLength: number;
  actionDelayMs: number;
  now: () => number;
}

export interface WindowHead {
  title: HTMLElement;
  sub: HTMLElement;
}

const CROWN_SVG =
  '<svg class="dv-crown" viewBox="0 0 40 30" aria-hidden="true">' +
  '<path d="M4 6 L9 25 L29 25 L34 6 L26 12 L19 2 L12 12 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
  '</svg>';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const btn = el('button', className);
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

export class ClanWindow {
  /** Typed clan name survives re-renders (the old client kept Game.teamName). */
  private draftName = '';

  private body!: HTMLElement;
  private head!: WindowHead;
  private lastSignature = '';
  private createBtn: HTMLButtonElement | null = null;

  mount(
    body: HTMLElement,
    head: WindowHead,
    clans: ClanStore,
    rules: ClanRules,
    callbacks: ClanWindowCallbacks,
  ): void {
    this.body = body;
    this.head = head;
    this.lastSignature = '';
    this.refresh(clans, rules, callbacks);
  }

  refresh(clans: ClanStore, rules: ClanRules, callbacks: ClanWindowCallbacks): void {
    const now = rules.now();
    const inClan = clans.teamId >= 0 ? clans.clan(clans.teamId) : undefined;
    const members = inClan ? clans.members(inClan.id) : [];
    const listed = clans.listed();
    const canRequest = clans.canRequest(now, rules.actionDelayMs);
    const canCreate = clans.canCreate(now, rules.actionDelayMs);
    const canManage = clans.canManage(now, rules.actionDelayMs);

    const accountClan = clans.player(clans.ownGuid)?.accountClan;
    const online = clans.onlineAccountMembers();
    let signature = inClan
      ? `in:${inClan.id}:${inClan.uid}:${inClan.name}:${clans.isLeader}:${clans.locked}:${canManage}|${members.map((m) => `${m.guid}:${m.nickname}`).join(',')}`
      : `browse:${canRequest}:${canCreate}|${listed.map((c) => `${c.id}:${c.name}:${clans.isLocked(c.id)}`).join(',')}`;
    signature += '|' + JSON.stringify(accountClan) + '|' + online.map(p => p.guid + ':' + p.nickname).join(',');
    if (signature === this.lastSignature) {
      this.syncCreateButton(clans, rules);
      return;
    }
    this.lastSignature = signature;
    this.body.innerHTML = '';
    this.createBtn = null;

    if (inClan) this.renderClan(clans, inClan.id, members, rules, canManage, callbacks);
    else this.renderBrowse(clans, listed, rules, canRequest, callbacks);
    const card = el('section', 'dv-account-clan-card');
    card.append(el('div', 'dv-label', 'Account clan'));
    if (accountClan) {
      const title = el('strong', undefined, accountClan.name + ' [' + accountClan.tag + ']');
      title.append(...badgeNodes(document, badgesFor(clans.player(clans.ownGuid), new Map()).filter(b => b.key === 'clan')));
      card.append(title, el('p', 'dv-muted', accountClan.rank ? 'Season rank #' + accountClan.rank : 'No season rank yet'),
        el('p', undefined, 'Online here: ' + online.map(p => p.nickname).join(', ')));
    } else card.append(el('p', 'dv-muted', 'You have no account clan.'));
    card.append(el('p', 'dv-muted', 'Manage your permanent clan from Account on the main menu. Temporary teams keep their own membership and permissions.'));
    this.body.append(card);
  }

  private renderBrowse(
    clans: ClanStore,
    listed: { id: number; name: string }[],
    rules: ClanRules,
    canRequest: boolean,
    callbacks: ClanWindowCallbacks,
  ): void {
    this.head.title.textContent = 'Teams & clan';
    this.head.sub.textContent = 'Temporary teams last only for this game.';
    this.body.parentElement?.classList.add('is-browse');
    this.body.parentElement?.classList.toggle('is-wide', listed.length > 6);

    this.body.appendChild(el('div', 'dv-label', 'Create a temporary team'));

    const form = el('form', 'dv-clan-form');
    const input = el('input', 'dv-input dv-clan-name');
    input.type = 'text';
    input.placeholder = 'Name…';
    input.maxLength = rules.nameMaxLength;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = this.draftName;
    input.addEventListener('input', () => {
      this.draftName = input.value;
      this.syncCreateButton(clans, rules);
    });
    const create = el('button', 'dv-btn is-primary dv-clan-create');
    create.type = 'button';
    create.textContent = 'Create';
    const submit = () => {
      if (create.disabled) return;
      callbacks.onCreate(this.draftName);
      clans.markCreate(rules.now());
      this.syncCreateButton(clans, rules);
    };
    create.addEventListener('click', submit);
    // Enter in the single text field submits the form (implicit submission).
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      submit();
    });
    form.append(input, create);
    this.body.appendChild(form);
    this.createBtn = create;
    this.syncCreateButton(clans, rules);

    this.body.appendChild(el('div', 'dv-label dv-clan-section', 'Available teams'));
    if (listed.length === 0) {
      this.body.appendChild(el('div', 'dv-muted dv-clan-empty', 'No teams yet'));
      return;
    }
    const list = el('div', listed.length > 6 ? 'dv-clan-list is-two-col' : 'dv-clan-list');
    for (const clan of listed) {
      const row = el('div', 'dv-clan-row dv-slot');
      row.appendChild(el('span', 'name', clan.name));
      // A locked clan takes invitations only: the server would refuse a request.
      const locked = clans.isLocked(clan.id);
      const request = button('dv-btn dv-clan-request', locked ? 'Invite only' : 'Request', () => {
        callbacks.onRequest(clan.id);
        clans.markRequest(rules.now());
        this.lastSignature = '';
      });
      request.disabled = locked || !canRequest;
      row.appendChild(request);
      list.appendChild(row);
    }
    this.body.appendChild(list);
  }

  private renderClan(
    clans: ClanStore,
    clanId: number,
    members: { guid: number; nickname: string }[],
    rules: ClanRules,
    canAct: boolean,
    callbacks: ClanWindowCallbacks,
  ): void {
    const clan = clans.clan(clanId)!;
    const me = clans.ownGuid;
    const isLeader = clans.isLeader;
    this.head.title.textContent = clan.name || 'Team';
    this.head.sub.textContent = `${members.length} member${members.length === 1 ? '' : 's'}`;
    this.body.parentElement?.classList.remove('is-browse', 'is-wide');

    const status = el('div', 'dv-clan-status', clans.locked ? 'Invite only' : 'Open to requests');
    this.body.appendChild(status);

    const owner = members.find((m) => m.guid === clan.leaderGuid);
    const ownerCard = el('div', 'dv-clan-owner dv-slot is-active');
    ownerCard.innerHTML = CROWN_SVG;
    const ownerText = el('div', 'dv-clan-owner-text');
    ownerText.appendChild(
      el('div', 'role dv-label', clan.leaderGuid === me ? 'OWNER · YOU' : 'OWNER'),
    );
    ownerText.appendChild(el('div', 'name', owner?.nickname ?? 'Owner unavailable'));
    ownerCard.appendChild(ownerText);
    this.body.appendChild(ownerCard);

    this.body.appendChild(el('div', 'dv-label dv-clan-section', 'Members'));
    const others = members.filter((m) => m.guid !== clan.leaderGuid);
    if (others.length === 0) {
      this.body.appendChild(el('div', 'dv-muted dv-clan-empty', 'No other members'));
    } else {
      const grid = el('div', 'dv-clan-members');
      for (const m of others) {
        const card = el('div', 'dv-clan-member dv-slot');
        const text = el('div', 'dv-clan-member-text');
        text.appendChild(el('div', 'name', m.nickname));
        text.appendChild(el('div', 'role dv-muted', m.guid === me ? 'You' : 'Member'));
        card.appendChild(text);
        if (isLeader && m.guid !== me) {
          const kick = button('dv-btn dv-clan-kick', 'Remove', () => {
            callbacks.onKick(m.guid);
            clans.markManage(rules.now());
            this.lastSignature = '';
          });
          kick.disabled = !canAct;
          card.appendChild(kick);
        }
        grid.appendChild(card);
      }
      this.body.appendChild(grid);
    }

    this.body.appendChild(el('div', 'dv-rule'));
    const footer = el('div', 'dv-clan-footer');
    if (isLeader) {
      const lock = el('button', 'dv-btn is-icon dv-clan-lock');
      lock.type = 'button';
      lock.innerHTML = icon(clans.locked ? 'lock' : 'unlock');
      lock.setAttribute('data-hint', clans.locked ? 'Unlock team' : 'Lock team');
      lock.setAttribute('aria-label', clans.locked ? 'Unlock team' : 'Lock team');
      lock.disabled = !canAct;
      lock.addEventListener('click', () => {
        if (clans.locked) {
          callbacks.onUnlock();
          clans.setLocked(false);
        } else {
          callbacks.onLock();
          clans.setLocked(true);
        }
        clans.markManage(rules.now());
        this.lastSignature = '';
      });
      const hint = el(
        'span',
        'dv-muted dv-clan-lock-hint',
        clans.locked ? 'Unlock team' : 'Lock team',
      );
      const del = button('dv-btn is-danger dv-clan-delete', 'Delete team', () =>
        callbacks.onDelete(),
      );
      footer.append(lock, hint, del);
    } else {
      footer.appendChild(button('dv-btn dv-clan-leave', 'Leave team', () => callbacks.onLeave()));
    }
    this.body.appendChild(footer);
  }

  private syncCreateButton(clans: ClanStore, rules: ClanRules): void {
    if (!this.createBtn) return;
    const problem = clans.nameProblem(this.draftName, rules.nameMaxLength);
    this.createBtn.disabled =
      problem !== null || !clans.canCreate(rules.now(), rules.actionDelayMs);
    this.createBtn.setAttribute(
      'data-hint',
      problem === 'taken'
        ? 'Name already taken'
        : problem === 'invalid'
          ? 'Letters and digits only'
          : '',
    );
  }
}
