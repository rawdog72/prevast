// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-leaderboard.ts
// DOM leaderboard panel (top-left), after the old client's _Leaderboard +
// GameUI.leaderboardBackground: the server's LEADERBOARD order (top 10), each
// row rank / karma badge / name / simplified score, padded with empty
// numbered slots so the panel always shows ten places. A faint bar behind each
// row shows its score against the leader's; the top three get rank chips;
// our own row is lifted out as a card -- and appended under a gap when we are
// not listed. A row that just moved up or down flashes briefly.
// Titled with the name of the server we are on.

import type { WorldState } from '../../world/world-state';
import { badgesFor, badgeNodes, type Badge } from '../badges';
import { icon } from '../dom/icons';

const MAX_ROWS = 10;
/** How long (ms) a row keeps its moved-up / moved-down flash; matches hud.css. */
const MOVE_FLASH_MS = 2400;

/** Old client KARMA table: leaderboard karma index -> sprite. */
const KARMA_SPRITES = ['karma4', 'karma3', 'karma2', 'karma1', 'karma0', 'karma5'];

export function karmaSprite(index: number): string {
  return KARMA_SPRITES[Math.max(0, Math.min(KARMA_SPRITES.length - 1, index))];
}

/** MathUtils.simplifyNumber: 12345 -> "12.3k", 123456 -> "123k", below 10000 verbatim. */
export function simplifyNumber(n: number): string {
  if (n < 10000) return String(Math.floor(n));
  const log = Math.floor(Math.log10(n)) - 2;
  const decimals = Math.max(0, 3 - log);
  let v = String(Math.floor(n / 1000));
  if (decimals) {
    v +=
      '.' +
      String((n % 1000) / 1000)
        .substring(2)
        .substring(0, decimals);
    v = v.replace(/0+$/, '').replace(/\.$/, '');
  }
  return v + 'k';
}

interface RowSpec {
  /** 1-based; 0 when the server did not tell us (our own row, off the list). */
  rank: number;
  guid: number;
  name: string;
  score: number;
  karma: number;
  isMe: boolean;
  badges: Badge[];
}

export class HudLeaderboard {
  /** A row was double-clicked (not our own): the game opens a private tab. */
  onPlayerDoubleClick?: (guid: number) => void;
  private mounted = false;
  private root!: HTMLElement;
  private lastSignature = '';
  private title = 'Leaderboard';
  /** guid -> rank at the last render, to spot movement. */
  private lastRanks = new Map<number, number>();
  /** guid -> when it last moved and which way, so a re-render mid-flash keeps it going. */
  private moves = new Map<number, { at: number; dir: 'up' | 'down' }>();
  /** Clock for the move flash; tests may replace it. */
  now: () => number = () => performance.now();

  mount(root: HTMLElement): void {
    if (this.mounted) return;
    this.mounted = true;
    this.root = root;
    root.addEventListener('dblclick', this.handleDoubleClick);
  }

  /**
   * The root is permanent page markup that every game session mounts again;
   * a listener left on it would keep this (stopped) session and its whole
   * world alive, and answer double-clicks meant for the next one.
   */
  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.root.removeEventListener('dblclick', this.handleDoubleClick);
  }

  private readonly handleDoubleClick = (ev: Event): void => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-guid]');
    if (row) this.onPlayerDoubleClick?.(Number(row.dataset['guid']));
  };

  /** The panel's heading: the listed server's name (a custom address shows its host). */
  setTitle(title: string): void {
    this.title = title || 'Leaderboard';
  }

  update(world: WorldState, visible: boolean): void {
    // Every player we know of is listed. A guest without a name gets a blank
    // name and still shows their score and karma.
    const known = world.leaderboard
      .map((e) => ({ ...e, player: world.players.get(e.guid) }))
      .filter((e) => e.player);
    const rows = known.slice(0, MAX_ROWS);

    if (!visible || rows.length === 0) {
      this.root.hidden = true;
      this.lastSignature = '';
      return;
    }
    this.root.hidden = false;

    const own = rows.some((r) => r.guid === world.ownGuid);
    const me = world.players.get(world.ownGuid);
    const signature =
      this.title +
      '#' +
      rows
        .map(
          (r) =>
            `${r.guid}:${r.player!.nickname}:${r.score}:${r.karma}:${badgesFor(
              r.player,
              world.groups,
            )
              .map((b) => b.key + ':' + b.color + ':' + b.title)
              .join(',')}`,
        )
        .join('|') +
      (own ? '' : `|own:${me?.nickname}:${world.ownScore}:${world.ownKarma}:${JSON.stringify(me?.accountClan)}`);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    const now = this.now();
    this.trackMoves(rows, now);

    this.root.innerHTML = '';
    this.root.appendChild(this.header());

    // Bars are relative to the leader, so the gap between places reads at a glance.
    const top = Math.max(1, rows[0]!.score, own ? 0 : world.ownScore);
    const list = document.createElement('div');
    list.className = 'hud-leaderboard-list';
    rows.forEach((r, i) => {
      list.appendChild(
        this.row(
          {
            rank: i + 1,
            guid: r.guid,
            name: r.player!.nickname,
            score: r.score,
            karma: r.karma,
            isMe: r.guid === world.ownGuid,
            badges: badgesFor(r.player, world.groups),
          },
          top,
          now,
        ),
      );
    });
    // Always ten places: the ones nobody holds yet stay as faint numbered slots.
    for (let rank = rows.length + 1; rank <= MAX_ROWS; rank++) list.appendChild(this.emptySlot(rank));
    this.root.appendChild(list);

    if (!own && me) {
      // The server's list may run past what we show; if we are on it, say where.
      const index = known.findIndex((r) => r.guid === world.ownGuid);
      const gap = document.createElement('div');
      gap.className = 'hud-leaderboard-gap';
      gap.setAttribute('aria-hidden', 'true');
      this.root.appendChild(gap);
      const row = this.row(
        {
          rank: index >= 0 ? index + 1 : 0,
          guid: world.ownGuid,
          name: me.nickname,
          score: world.ownScore,
          karma: world.ownKarma,
          isMe: true,
          badges: badgesFor(me, world.groups),
        },
        top,
        now,
      );
      row.classList.add('hud-leaderboard-own');
      this.root.appendChild(row);
    }
  }

  /** Remember who moved since the last render; newcomers count as moving up. */
  private trackMoves(rows: readonly { guid: number }[], now: number): void {
    const ranks = new Map<number, number>();
    rows.forEach((r, i) => ranks.set(r.guid, i + 1));
    // The very first render has nothing to compare against: no flashes.
    if (this.lastRanks.size > 0) {
      for (const [guid, rank] of ranks) {
        const before = this.lastRanks.get(guid);
        if (before === rank) continue;
        this.moves.set(guid, { at: now, dir: before === undefined || rank < before ? 'up' : 'down' });
      }
    }
    for (const [guid, m] of this.moves) {
      if (now - m.at >= MOVE_FLASH_MS || !ranks.has(guid)) this.moves.delete(guid);
    }
    this.lastRanks = ranks;
  }

  private header(): HTMLElement {
    const head = document.createElement('div');
    head.className = 'hud-leaderboard-head';
    head.innerHTML = icon('leaderboard');
    const title = document.createElement('div');
    title.className = 'hud-leaderboard-title';
    title.textContent = this.title;
    title.title = this.title;
    head.appendChild(title);
    return head;
  }

  private emptySlot(rank: number): HTMLElement {
    const slot = document.createElement('div');
    slot.className = 'hud-leaderboard-empty';
    slot.setAttribute('aria-hidden', 'true');
    const rankEl = document.createElement('span');
    rankEl.className = 'rank';
    rankEl.textContent = String(rank);
    const line = document.createElement('span');
    line.className = 'slot-line';
    slot.append(rankEl, line);
    return slot;
  }

  private row(r: RowSpec, top: number, now: number): HTMLElement {
    const row = document.createElement('div');
    row.className = r.isMe ? 'hud-leaderboard-row is-me' : 'hud-leaderboard-row';
    if (r.rank >= 1 && r.rank <= 3) row.classList.add(`is-top${r.rank}`);
    if (!r.isMe) {
      row.dataset['guid'] = String(r.guid);
      row.title = 'Double-click to message';
    }
    // The score bar: a share of the leader's score; a sliver too thin to read is left out.
    const share = Math.min(1, Math.max(0, r.score / top));
    if (share < 0.06) row.classList.add('is-trailing');
    row.style.setProperty('--lb-fill', share.toFixed(3));

    const move = this.moves.get(r.guid);
    if (move) {
      row.classList.add(move.dir === 'up' ? 'is-up' : 'is-down');
      // A re-render mid-flash picks the animation up where it was.
      row.style.setProperty('--lb-delay', `${-Math.round(now - move.at)}ms`);
    }

    const rankEl = document.createElement('span');
    rankEl.className = 'rank';
    rankEl.textContent = r.rank > 0 ? String(r.rank) : '';

    const karmaEl = document.createElement('span');
    karmaEl.className = 'karma';
    karmaEl.style.backgroundImage = `url(/img/${karmaSprite(r.karma)}.png)`;

    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    const nameText = document.createElement('span');
    nameText.className = 'name-text';
    nameText.textContent = r.name;
    nameEl.append(nameText, ...badgeNodes(document, r.badges));

    const scoreEl = document.createElement('span');
    scoreEl.className = 'score';
    scoreEl.textContent = simplifyNumber(r.score);

    row.append(rankEl, karmaEl, nameEl, scoreEl);
    return row;
  }
}
