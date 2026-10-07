// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/player-menu.ts
// What the right-click menu offers on another player, besides Look: a private
// message, the clan step that fits (the leader invites a player with no clan;
// a player with no clan asks an open clan's leader to join), and Block. The
// server has the last word on all of it; this only offers what it would allow.

import type { ClanStore } from '../world/clan-store';
import type { WorldState } from '../world/world-state';
import type { ContextMenuEntry } from './context-menu';

export interface PlayerMenuActions {
  message: (pid: number) => void;
  invite: (pid: number) => void;
  askToJoin: (clanId: number) => void;
  block: (pid: number, blocked: boolean) => void;
}

export interface PlayerMenuTiming {
  now: number;
  /** config.clanActionDelayMs: the server ignores clan actions sent faster. */
  clanDelayMs: number;
}

export function playerMenuEntries(
  pid: number,
  world: WorldState,
  clans: ClanStore,
  actions: PlayerMenuActions,
  { now, clanDelayMs }: PlayerMenuTiming,
): ContextMenuEntry[] {
  const other = world.players.get(pid);
  if (!other || pid === world.ownGuid) return [];
  const entries: ContextMenuEntry[] = [
    { label: 'Private message', action: () => actions.message(pid) },
  ];

  // A ghoul cannot touch a team (ghoulMayUseOpcode on the server).
  const meGhoul = !!world.players.get(world.ownGuid)?.ghoul;
  if (!meGhoul) {
    const ownClan = clans.clan(clans.teamId);
    if (clans.isLeader && ownClan && other.team === -1 && !other.ghoul) {
      entries.push({
        label: `Invite to ${ownClan.name}`,
        disabled: !clans.canManage(now, clanDelayMs),
        action: () => {
          actions.invite(pid);
          clans.markManage(now);
        },
      });
    } else if (other.teamLeader && clans.canAskToJoin(other.team)) {
      entries.push({
        label: `Ask to join ${clans.clan(other.team)!.name}`,
        disabled: !clans.canRequest(now, clanDelayMs),
        action: () => {
          actions.askToJoin(other.team);
          clans.markRequest(now);
        },
      });
    }
  }

  const blocked = world.blocked.has(pid);
  entries.push({
    label: blocked ? 'Unblock' : 'Block',
    action: () => actions.block(pid, !blocked),
  });
  return entries;
}
