// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/badges.ts
// The icons after a player's name: a check for a verified account, then the
// staff group's badge. The DOM draws them as SVG icons; the canvas nameplates,
// which draw text, use the glyphs. The server names the badge (ServerOpcode.GROUPS); this file
// only knows how each key looks, so a new group needs a new entry here.
import { clanShieldColor, type ClanIdentity } from '../../../../shared/typescript/account-community';
import type { GroupInfo } from '../net/events';
import { icon, type IconName } from './dom/icons';

export interface Badge {
  key: string;
  glyph: string;
  icon: IconName;
  color: string;
  title: string;
}

export const BADGE_STYLES: Record<string, { glyph: string; icon: IconName; color: string }> = {
  verified: { glyph: '✔', icon: 'verified', color: '#5ab8ff' },
  tutor: { glyph: '✚', icon: 'tutor', color: '#6fdc7c' },
  gamemaster: { glyph: '◆', icon: 'gamemaster', color: '#6f9bff' },
  admin: { glyph: '♛', icon: 'admin', color: '#ff5a5a' },
};

export function badgesFor(
  info: { verified: boolean; groupId: number; accountClan?: ClanIdentity | null } | undefined,
  groups: ReadonlyMap<number, GroupInfo>,
): Badge[] {
  if (!info) return [];
  const out: Badge[] = [];
  if (info.verified) out.push({ key: 'verified', title: 'Verified account', ...BADGE_STYLES.verified! });
  const group = groups.get(info.groupId);
  // Own keys only: a server-sent badge such as "constructor" must not
  // resolve to something off Object.prototype.
  const style = group && Object.hasOwn(BADGE_STYLES, group.badge) ? BADGE_STYLES[group.badge] : undefined;
  if (group && style) out.push({ key: group.badge, title: group.name, ...style });
  if (info.accountClan) {
    const c = info.accountClan;
    out.push({ key: 'clan', icon: 'clan_shield', glyph: '⬟', color: clanShieldColor(c.rank),
      title: c.name + ' [' + c.tag + '] · ' + (c.rank ? 'Season rank #' + c.rank : 'Registered clan') });
  }
  return out;
}

export function badgeNodes(doc: Document, badges: readonly Badge[]): HTMLElement[] {
  return badges.map((badge) => {
    const node = doc.createElement('span');
    node.className = `dv-badge dv-badge-${badge.key}`;
    node.innerHTML = icon(badge.icon);
    node.style.color = badge.color;
    node.title = badge.title;
    node.setAttribute('aria-label', badge.title);
    return node;
  });
}
