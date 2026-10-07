// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
import {
  clanShieldColor,
  type ClanCommand,
  type ClanView,
  type CommunityProfile,
  type Rankings,
} from '../../../../../shared/typescript/account-community';
import type { AccountCommunityApi } from './account-api';
import { sectionTabs } from './section-tabs';
import { dismissOnBackdrop } from './dialog-dismiss';

const number = (value: number | null) =>
  value === null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
function node<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const n = doc.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}
function button(doc: Document, text: string, click: () => void): HTMLButtonElement {
  const b = node(doc, 'button', text, 'dv-btn');
  b.type = 'button';
  b.onclick = click;
  return b;
}
function section(doc: Document, title: string): HTMLDetailsElement {
  const d = node(doc, 'details', undefined, 'dv-account-section');
  d.append(node(doc, 'summary', title));
  return d;
}
function card(doc: Document, title: string): HTMLElement {
  const result = node(doc, 'section', undefined, 'dv-workspace-card');
  result.append(node(doc, 'h4', title));
  return result;
}
function table(doc: Document, head: string[], values: (string | HTMLElement)[][]): HTMLElement {
  const scroll = node(doc, 'div', undefined, 'dv-community-table-scroll'),
    t = node(doc, 'table', undefined, 'dv-community-table');
  const h = node(doc, 'tr');
  head.forEach((text) => {
    const th = node(doc, 'th', text);
    th.scope = 'col';
    h.append(th);
  });
  const thead = node(doc, 'thead');
  thead.append(h);
  t.append(thead);
  const body = node(doc, 'tbody');
  for (const row of values) {
    const tr = node(doc, 'tr');
    for (const value of row) {
      const td = node(doc, 'td');
      typeof value === 'string' ? (td.textContent = value) : td.append(value);
      tr.append(td);
    }
    body.append(tr);
  }
  t.append(body);
  scroll.append(t);
  return scroll;
}
function shield(doc: Document, clan: { tag: string; name: string; rank: number }): HTMLElement {
  const mark = node(doc, 'span', clan.tag + ' · ' + clan.name, 'dv-account-clan-badge');
  mark.style.color = clanShieldColor(clan.rank);
  mark.title = clan.rank
    ? 'Registered clan · Season rank #' + clan.rank
    : 'Registered clan · Unranked';
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = doc.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', 'M12 2 21 6v6c0 5-9 10-9 10S3 17 3 12V6Z');
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  mark.prepend(svg);
  return mark;
}
export class AccountCommunityPanel {
  private generation = 0;
  private busy = false;
  private creation: { name: string; tag: string; requestId: string } | null = null;
  private clanPage = 'members';
  constructor(
    private readonly root: HTMLElement,
    private readonly api: AccountCommunityApi,
    private readonly outlets?: { summary: HTMLElement; activity: HTMLElement },
  ) {}
  clear(): void {
    this.generation++;
    this.busy = false;
    this.creation = null;
    this.root.replaceChildren();
    this.outlets?.summary.replaceChildren();
    this.outlets?.activity.replaceChildren();
    this.clanPage = 'members';
  }
  async show(): Promise<void> {
    const generation = ++this.generation;
    this.root.textContent = 'Loading your clan…';
    if (this.outlets) {
      this.outlets.summary.textContent = 'Loading your survivor stats…';
      this.outlets.activity.textContent = 'Loading your activity…';
    }
    try {
      const p = await this.api.profile();
      if (generation === this.generation) this.render(p);
    } catch (e) {
      if (generation === this.generation) {
        const message = e instanceof Error ? e.message : 'Account progression could not be loaded.';
        this.root.textContent = message;
        if (this.outlets) {
          this.outlets.summary.textContent = message;
          this.outlets.activity.textContent = message;
        }
        this.root.append(button(this.root.ownerDocument, 'Try again', () => void this.show()));
      }
    }
  }
  private async act(command: ClanCommand): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const generation = this.generation;
    const disabled = [...this.root.querySelectorAll('button')].map((b) => ({ b, was: b.disabled }));
    disabled.forEach(({ b }) => (b.disabled = true));
    const status = this.root.querySelector<HTMLElement>('[data-community-status]');
    try {
      await this.api.command(command);
      if (generation === this.generation) await this.show();
    } catch (e) {
      if (generation === this.generation && status)
        status.textContent = e instanceof Error ? e.message : 'Action failed.';
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        disabled.forEach(({ b, was }) => (b.disabled = was));
      } else this.busy = false;
    }
  }
  private input(parent: HTMLElement, label: string, max: number): HTMLInputElement {
    const d = this.root.ownerDocument,
      wrap = node(d, 'label', label, 'dv-field'),
      input = node(d, 'input');
    input.maxLength = max;
    wrap.append(input);
    parent.append(wrap);
    return input;
  }
  private render(p: CommunityProfile): void {
    const d = this.root.ownerDocument;
    this.root.replaceChildren();
    const overview = node(d, 'div', undefined, 'dv-community-summary');
    for (const [value, label] of [
      [number(p.wallet), 'golden caps'],
      [number(p.bestScore), 'best session'],
      [number(p.averageScore), 'average session'],
      [number(p.completedRuns), 'completed sessions'],
    ]) {
      const stat = node(d, 'div', undefined, 'dv-stat-card');
      stat.append(node(d, 'strong', value), d.createTextNode(' '), node(d, 'span', label));
      overview.append(stat);
    }
    if (this.outlets) this.outlets.summary.replaceChildren(overview);
    else this.root.append(overview);
    const history = card(d, 'Recent survivor sessions');
    history.append(
      table(
        d,
        ['Started', 'Status', 'Score', 'Kills', 'Survived', 'Golden caps'],
        p.recentRuns.map((r) => [
          new Date(r.startedAt).toLocaleString(),
          r.end === 'alive' ? 'Alive' : r.end === 'death' ? 'Died' : 'Interrupted',
          number(r.score),
          number(r.kills),
          Math.floor(r.survivedSeconds / 60) + ' min',
          number(r.goldenCaps),
        ]),
      ),
    );
    if (!p.recentRuns.length)
      history.append(node(d, 'p', 'Your first survivor session will appear here.'));
    const wallet = card(d, 'Golden cap history');
    wallet.append(
      node(
        d,
        'p',
        'Earn 1 golden cap per ' +
          number(p.rules.scorePerGoldenCap) +
          ' eligible score in one survivor session. Achievement and event rewards are additional.',
      ),
    );
    wallet.append(
      table(
        d,
        ['When', 'Amount', 'Reason'],
        p.transactions.map((t) => [
          new Date(t.at).toLocaleString(),
          (t.amount > 0 ? '+' : '') + number(t.amount),
          t.reason,
        ]),
      ),
    );
    if (!p.transactions.length)
      wallet.append(node(d, 'p', 'No golden cap transactions yet.', 'dv-account-hint'));
    if (this.outlets) this.outlets.activity.replaceChildren(history, wallet);
    else this.root.append(history, wallet);
    const clan = node(d, 'section', undefined, 'dv-clan-workspace');
    if (p.clan) this.renderClan(clan, p.clan, p.accountId);
    else {
      clan.classList.add('dv-workspace-card');
      clan.append(node(d, 'h4', 'Start your clan'));
      clan.append(
        node(
          d,
          'p',
          'Create a permanent clan for ' +
            p.rules.clanCreationCost +
            ' golden caps. Membership has no size limit.',
        ),
      );
      if (p.canJoinAt > Date.now())
        clan.append(
          node(
            d,
            'p',
            'You can join another clan after ' + new Date(p.canJoinAt).toLocaleString() + '.',
          ),
        );
      const name = this.input(clan, 'Clan name', 40),
        tag = this.input(clan, 'Tag (2–5 letters or numbers)', 5);
      name.placeholder = 'Choose a clan name';
      tag.placeholder = 'e.g. WOLF';
      const create = button(d, 'Create clan · ' + p.rules.clanCreationCost + ' caps', () => {
        const n = name.value.trim(),
          t = tag.value.trim().toUpperCase();
        if (!this.creation || this.creation.name !== n || this.creation.tag !== t)
          this.creation = { name: n, tag: t, requestId: crypto.randomUUID() };
        void this.act({ action: 'create', ...this.creation });
      });
      create.disabled = p.wallet < p.rules.clanCreationCost || p.canJoinAt > Date.now();
      clan.append(create);
      if (p.wallet < p.rules.clanCreationCost)
        clan.append(
          node(
            d,
            'p',
            'You need ' +
              number(p.rules.clanCreationCost - p.wallet) +
              ' more golden caps to create a clan.',
            'dv-account-hint',
          ),
        );
    }
    if (p.invitations.length) clan.append(node(d, 'h4', 'Clan invitations'));
    for (const i of p.invitations) {
      const row = node(d, 'div', undefined, 'dv-clan-invitation');
      row.append(node(d, 'strong', i.tag + ' · ' + i.name));
      row.append(
        button(d, 'Accept', () => void this.act({ action: 'accept', clanId: i.clanId })),
        button(d, 'Decline', () => void this.act({ action: 'decline', clanId: i.clanId })),
      );
      clan.append(row);
    }
    this.root.append(clan);
    const status = node(d, 'p', undefined, 'dv-account-hint');
    status.dataset.communityStatus = '';
    status.setAttribute('role', 'status');
    this.root.prepend(status);
  }
  private renderClan(container: HTMLElement, c: ClanView, accountId: number): void {
    const d = this.root.ownerDocument;
    const header = node(d, 'div', undefined, 'dv-clan-header');
    header.append(
      shield(d, c),
      node(
        d,
        'p',
        c.members +
          ' members · ' +
          c.contributors +
          ' season contributors · ' +
          number(c.score) +
          ' score · ' +
          number(c.average) +
          ' average per contributor',
      ),
      node(d, 'p', 'Your contribution this season: ' + number(c.yourContribution)),
    );
    container.append(header);
    const nav = node(d, 'nav', undefined, 'dv-section-tabs');
    nav.setAttribute('aria-label', 'Clan sections');
    const pages: Record<string, HTMLElement> = {};
    for (const [key, label] of [
      ['members', 'Members'],
      ['activity', 'Activity'],
      ['settings', 'Settings'],
    ]) {
      const tab = button(d, label!, () => {});
      tab.dataset.page = key!;
      nav.append(tab);
      pages[key!] = node(d, 'section');
    }
    container.append(nav, ...Object.values(pages));
    sectionTabs(nav, pages, 'dv-clan', (key) => {
      this.clanPage = key;
    })(this.clanPage);
    const members = pages.members!,
      settings = pages.settings!,
      activity = pages.activity!;
    if (c.role === 'owner' || c.role === 'officer') {
      const invite = node(d, 'div', undefined, 'dv-clan-invite');
      const who = this.input(invite, 'Invite a player', 16);
      who.placeholder = 'Account name';
      invite.append(
        button(
          d,
          'Send invitation',
          () => void this.act({ action: 'invite', account: who.value.trim() }),
        ),
      );
      members.append(invite);
    }
    const roster = node(d, 'div');
    members.append(roster);
    const search = this.input(roster, 'Search members', 16),
      list = node(d, 'div');
    roster.append(list);
    const render = (view: ClanView, offset: number) => {
      const rows = view.roster.map((m) => {
        const controls = node(d, 'div', undefined, 'dv-member-actions');
        if (
          m.id !== accountId &&
          m.role !== 'owner' &&
          (c.role === 'owner' || (c.role === 'officer' && m.role === 'member'))
        )
          controls.append(
            button(d, 'Remove', () => void this.act({ action: 'kick', accountId: m.id })),
          );
        if (c.role === 'owner' && m.id !== accountId) {
          controls.append(
            button(
              d,
              m.role === 'officer' ? 'Make member' : 'Make officer',
              () =>
                void this.act({
                  action: m.role === 'officer' ? 'demote' : 'promote',
                  accountId: m.id,
                }),
            ),
          );
          controls.append(
            button(d, 'Transfer ownership', () => {
              const confirm = button(
                d,
                'Confirm transfer to ' + m.name,
                () => void this.act({ action: 'transfer', accountId: m.id }),
              );
              controls.replaceChildren(
                confirm,
                button(d, 'Cancel', () => render(view, offset)),
              );
            }),
          );
        }
        if (!controls.childElementCount) return [m.name, m.role, number(m.contribution), '—'];
        const menu = node(d, 'details', undefined, 'dv-member-menu');
        menu.append(node(d, 'summary', 'Manage'), controls);
        return [m.name, m.role, number(m.contribution), menu];
      });
      list.replaceChildren(table(d, ['Member', 'Role', 'Season contribution', 'Actions'], rows));
      if (!view.roster.length)
        list.append(node(d, 'p', 'No members match your search.', 'dv-account-hint'));
      if (offset > 0) list.append(button(d, 'Previous', () => void load(Math.max(0, offset - 50))));
      if (view.nextOffset !== null)
        list.append(button(d, 'Next', () => void load(view.nextOffset!)));
    };
    const generation = this.generation;
    let request = 0;
    const load = async (offset: number) => {
      const current = ++request;
      try {
        const view = await this.api.roster(offset, search.value.trim());
        if (generation === this.generation && current === request) render(view, offset);
      } catch (e) {
        if (generation === this.generation && current === request)
          list.textContent = e instanceof Error ? e.message : 'Roster could not be loaded.';
      }
    };
    search.onchange = () => void load(0);
    search.placeholder = 'Search by account name';
    search.type = 'search';
    search.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void load(0);
      }
    };
    render(c, 0);
    if (c.role === 'owner') {
      const controls = section(d, 'Disband clan');
      controls.append(
        node(
          d,
          'p',
          'Disbanding removes all memberships. The creation fee is not refunded; historical contributions remain.',
        ),
      );
      const tag = this.input(controls, 'Type ' + c.tag + ' to confirm', 5);
      controls.append(
        button(
          d,
          'Disband clan',
          () => void this.act({ action: 'disband', confirmTag: tag.value.trim() }),
        ),
      );
      controls.classList.add('dv-danger-zone');
      settings.append(controls);
    } else {
      const leave = card(d, 'Leave this clan');
      leave.append(
        node(
          d,
          'p',
          'Your historical contributions stay with the clan. A cooldown may apply before joining another clan.',
          'dv-account-hint',
        ),
      );
      leave.append(
        button(d, 'Leave clan', () => {
          const confirm = node(d, 'div', undefined, 'dv-account-actions');
          confirm.append(
            button(d, 'Confirm leave', () => void this.act({ action: 'leave' })),
            button(d, 'Cancel', () => confirm.remove()),
          );
          if (!leave.querySelector('.dv-account-actions')) leave.append(confirm);
        }),
      );
      settings.append(leave);
    }
    const log = card(d, 'Clan activity');
    for (const a of c.audit)
      log.append(
        node(
          d,
          'p',
          new Date(a.at).toLocaleString() +
            ' · ' +
            a.actor +
            ' ' +
            a.action +
            (a.target ? ' ' + a.target : ''),
        ),
      );
    if (!c.audit.length) log.append(node(d, 'p', 'No clan activity yet.', 'dv-account-hint'));
    activity.append(log);
    if (c.trophies.length) {
      const trophies = card(d, 'Season trophies');
      for (const t of c.trophies)
        trophies.append(
          node(d, 'p', t.season + ' · #' + t.rank + ' · ' + number(t.score) + ' score'),
        );
      activity.append(trophies);
    }
  }
}
export class CommunityRankings {
  private generation = 0;
  private detailGeneration = 0;
  constructor(
    private readonly root: HTMLElement,
    private readonly api: AccountCommunityApi,
  ) {}
  mount(): void {
    const d = this.root.ownerDocument;
    this.root.replaceChildren();
    const filter = node(d, 'div', undefined, 'dv-ranking-filters'),
      season = node(d, 'select'),
      metric = node(d, 'select');
    for (const [value, label] of [
      ['current', 'This month'],
      ['all', 'Lifetime'],
    ]) {
      const o = node(d, 'option', label);
      o.value = value;
      season.append(o);
    }
    season.setAttribute('aria-label', 'Ranking period');
    for (const [value, label] of [
      ['score', 'Total score'],
      ['best', 'Best session'],
      ['average', 'Average session'],
      ['kills', 'Player kills'],
    ]) {
      const o = node(d, 'option', label);
      o.value = value;
      metric.append(o);
    }
    metric.setAttribute('aria-label', 'Player ranking');
    filter.append(season, metric);
    this.root.append(filter);
    const result = node(d, 'div');
    this.root.append(result);
    const load = async (offset = 0) => {
      const generation = ++this.generation;
      result.textContent = 'Loading rankings…';
      try {
        const r = await this.api.rankings(
          season.value === 'all' ? 'all' : undefined,
          metric.value as Rankings['metric'],
          offset,
        );
        if (generation !== this.generation) return;
        result.replaceChildren(
          node(
            d,
            'p',
            r.season === 'all'
              ? 'Lifetime rankings'
              : 'Season ' + r.season + ' · Next season ' + new Date(r.nextResetAt).toLocaleString(),
          ),
          node(
            d,
            'p',
            'Average-session rankings require 10 completed eligible sessions. Clan averages include all season contributors, including former members.',
          ),
        );
        const detail = node(d, 'div');
        result.append(
          node(d, 'h4', 'Players'),
          table(
            d,
            [
              'Rank',
              'Player',
              metric.value === 'kills' ? 'Player kills' : 'Score',
              'Completed sessions',
            ],
            r.players.map((p) => [
              '#' + p.rank,
              button(d, p.name, () => void this.playerDetail(detail, p.id)),
              number(p.score),
              number(p.sessions ?? 0),
            ]),
          ),
          node(d, 'h4', 'Clans'),
          table(
            d,
            ['Rank', 'Clan', 'Total score', 'Members', 'Contributors', 'Average per player'],
            r.clans.map((c) => [
              '#' + c.rank,
              (() => {
                const link = button(d, '', () => void this.clanDetail(detail, c.id));
                link.append(shield(d, { tag: c.tag ?? '', name: c.name, rank: c.rank }));
                return link;
              })(),
              number(c.score),
              number(c.members ?? 0),
              number(c.contributors ?? 0),
              number(c.average ?? null),
            ]),
          ),
          detail,
        );
        if (!r.players.length && !r.clans.length)
          result.append(node(d, 'p', 'No qualifying scores yet.'));
        if (offset > 0)
          result.append(button(d, 'Previous', () => void load(Math.max(0, offset - 50))));
        if (r.nextOffset !== null) result.append(button(d, 'Next', () => void load(r.nextOffset!)));
      } catch (e) {
        if (generation === this.generation)
          result.textContent = e instanceof Error ? e.message : 'Rankings could not be loaded.';
      }
    };
    season.onchange = () => void load();
    metric.onchange = () => void load();
    void load();
  }
  private async clanDetail(root: HTMLElement, id: number, offset = 0): Promise<void> {
    const generation = ++this.detailGeneration,
      d = root.ownerDocument;
    root.textContent = 'Loading clan…';
    try {
      const c = await this.api.clan(id, offset);
      if (generation !== this.detailGeneration) return;
      root.replaceChildren(
        shield(d, c),
        node(
          d,
          'p',
          c.members +
            ' members · ' +
            number(c.score) +
            ' score this month · ' +
            number(c.average) +
            ' average contribution',
        ),
        table(
          d,
          ['Member', 'Role', 'Contribution'],
          c.roster.map((m) => [m.name, m.role, number(m.contribution)]),
        ),
      );
      if (offset > 0)
        root.append(
          button(
            d,
            'Previous members',
            () => void this.clanDetail(root, id, Math.max(0, offset - 50)),
          ),
        );
      if (c.nextOffset !== null)
        root.append(button(d, 'More members', () => void this.clanDetail(root, id, c.nextOffset!)));
      for (const t of c.trophies)
        root.append(node(d, 'p', 'Season ' + t.season + ' · #' + t.rank + ' trophy'));
    } catch (e) {
      if (generation === this.detailGeneration)
        root.textContent = e instanceof Error ? e.message : 'Clan could not be loaded.';
    }
  }
  private async playerDetail(root: HTMLElement, id: number): Promise<void> {
    const generation = ++this.detailGeneration,
      d = root.ownerDocument;
    root.textContent = 'Loading survivor…';
    try {
      const p = await this.api.player(id);
      if (generation !== this.detailGeneration) return;
      root.replaceChildren(
        node(d, 'h4', p.name),
        node(
          d,
          'p',
          p.completedRuns +
            ' completed sessions · ' +
            number(p.averageScore) +
            ' average · ' +
            number(p.bestScore) +
            ' best',
        ),
      );
    } catch (e) {
      if (generation === this.detailGeneration)
        root.textContent = e instanceof Error ? e.message : 'Survivor could not be loaded.';
    }
  }
}
export function mountPublicRankings(
  doc: Document,
  api: AccountCommunityApi,
): { refresh: () => Promise<void> } {
  const host =
    doc.querySelector('#prevast-home .dv-footer nav') ?? doc.getElementById('dv-play-view');
  const dialog = node(doc, 'dialog', undefined, 'dv-community-dialog');
  dialog.setAttribute('aria-labelledby', 'dv-community-title');
  const content = node(doc, 'div'),
    close = button(doc, 'Close', () => dialog.close());
  const title = node(doc, 'h2', 'Player and clan rankings');
  title.id = 'dv-community-title';
  dialog.append(close, title, content);
  doc.body.append(dialog);
  dismissOnBackdrop(dialog, dialog, () => dialog.close());
  for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup', 'touchstart', 'touchend'])
    dialog.addEventListener(type, (event) => event.stopPropagation());
  const open = () => {
    dialog.showModal();
    new CommunityRankings(content, api).mount();
  };
  host?.append(button(doc, 'Player & clan rankings', open));
  const sidebar = doc.getElementById('dv-home-rankings');
  if (sidebar) sidebar.hidden = false;
  sidebar
    ?.querySelector<HTMLButtonElement>('[data-home-rankings-open]')
    ?.addEventListener('click', open);
  let loadedAt = -Infinity;
  let pending = false;
  const refresh = async () => {
    if (!sidebar || pending || Date.now() - loadedAt < 60_000) return;
    pending = true;
    sidebar.setAttribute('aria-busy', 'true');
    const status = sidebar.querySelector<HTMLElement>('[data-home-rankings-status]')!;
    const retry = sidebar.querySelector<HTMLButtonElement>('[data-home-rankings-retry]')!;
    status.textContent = '';
    retry.hidden = true;
    try {
      const ranks = await api.rankings();
      loadedAt = Date.now();
      sidebar.querySelector('[data-home-season]')!.textContent = ranks.season;
      for (const [kind, rows] of [
        ['players', ranks.players],
        ['clans', ranks.clans],
      ] as const) {
        const target = sidebar.querySelector<HTMLElement>(`[data-home-${kind}]`)!;
        const list = node(doc, 'ol', undefined, 'dv-ranking-list');
        for (const row of rows.slice(0, 5)) {
          const item = node(doc, 'li');
          item.dataset.rank = String(row.rank);
          const name = node(doc, 'span', undefined, 'dv-ranking-name');
          name.append(node(doc, 'strong', row.tag ? `[${row.tag}] ${row.name}` : row.name));
          name.append(
            node(
              doc,
              'small',
              kind === 'players'
                ? number(row.sessions ?? 0) + ' completed sessions'
                : number(row.members ?? 0) + ' members',
            ),
          );
          item.append(
            node(doc, 'span', String(row.rank).padStart(2, '0'), 'dv-ranking-position'),
            name,
            node(doc, 'span', number(row.score), 'dv-ranking-score'),
          );
          list.append(item);
        }
        target.replaceChildren(
          rows.length
            ? list
            : node(
                doc,
                'p',
                kind === 'players'
                  ? 'No ranked players yet. Your next run could be the first.'
                  : 'No ranked clans yet. Build a clan and leave your mark.',
                'dv-ranking-empty',
              ),
        );
      }
    } catch {
      status.textContent = 'Leaderboards are unavailable. Try again in a moment.';
      retry.hidden = false;
      if (loadedAt === -Infinity) {
        for (const kind of ['players', 'clans'])
          sidebar
            .querySelector(`[data-home-${kind}]`)!
            .replaceChildren(node(doc, 'p', 'Scores could not be loaded.', 'dv-ranking-empty'));
      }
    } finally {
      pending = false;
      sidebar.setAttribute('aria-busy', 'false');
    }
  };
  sidebar
    ?.querySelector<HTMLButtonElement>('[data-home-rankings-retry]')
    ?.addEventListener('click', () => void refresh());
  return { refresh };
}
