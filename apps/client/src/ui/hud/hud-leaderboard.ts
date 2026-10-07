// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-leaderboard.ts
// DOM leaderboard panel (top-right, below the minimap), after the old client's
// _Leaderboard + GameUI.leaderboardBackground: the server's LEADERBOARD order
// (top 10), each row rank / name / simplified score / karma badge, our own row
// in the accent color -- and appended under a rule when we are not listed.
// Titled with the name of the server we are on.

import type { WorldState } from '../../world/world-state';
import { badgesFor, badgeNodes, type Badge } from '../badges';

const MAX_ROWS = 10;

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

export class HudLeaderboard {
  /** A row was double-clicked (not our own): the game opens a private tab. */
  onPlayerDoubleClick?: (guid: number) => void;
  private mounted = false;
  private root!: HTMLElement;
  private lastSignature = '';
  private title = 'Leaderboard';

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
    const rows = world.leaderboard
      .map((e) => ({ ...e, player: world.players.get(e.guid) }))
      .filter((e) => e.player)
      .slice(0, MAX_ROWS);

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

    this.root.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'hud-leaderboard-title';
    title.textContent = this.title;
    this.root.appendChild(title);

    rows.forEach((r, i) => {
      this.root.appendChild(
        this.row(
          i + 1,
          r.guid,
          r.player!.nickname,
          r.score,
          r.karma,
          r.guid === world.ownGuid,
          badgesFor(r.player, world.groups),
        ),
      );
    });

    if (!own && me) {
      const row = this.row(
        0,
        world.ownGuid,
        me.nickname,
        world.ownScore,
        world.ownKarma,
        true,
        badgesFor(me, world.groups),
      );
      row.classList.add('hud-leaderboard-own');
      this.root.appendChild(row);
    }
  }

  private row(
    rank: number,
    guid: number,
    name: string,
    score: number,
    karma: number,
    isMe: boolean,
    badges: Badge[],
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = isMe ? 'hud-leaderboard-row is-me' : 'hud-leaderboard-row';
    if (!isMe) {
      row.dataset['guid'] = String(guid);
      row.title = 'Double-click to message';
    }

    const rankEl = document.createElement('span');
    rankEl.className = 'rank';
    rankEl.textContent = rank > 0 ? String(rank) : '';

    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = name;
    nameEl.append(...badgeNodes(document, badges));

    const scoreEl = document.createElement('span');
    scoreEl.className = 'score';
    scoreEl.textContent = simplifyNumber(score);

    const karmaEl = document.createElement('span');
    karmaEl.className = 'karma';
    karmaEl.style.backgroundImage = `url(/img/${karmaSprite(karma)}.png)`;

    row.append(rankEl, nameEl, scoreEl, karmaEl);
    return row;
  }
}
