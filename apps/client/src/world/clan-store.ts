// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/world/clan-store.ts
// Clan state, mirroring the old client's World.teams + World.PLAYER team
// fields. Every fact here comes from the server (TEAM_NAMES, TEAM_CREATED,
// TEAM_MEMBER_JOINED, TEAM_MEMBER_LEFT, TEAM_DELETED, TEAM_JOIN_REQUEST, TEAM_LOCKED, TEAM_INVITE
// and the handshake roster); the only client-side state is the optimistic lock
// toggle (TEAM_LOCKED confirms it) and the action-delay timestamps that grey
// buttons out.

import type { NetEventBus } from '../net/events';
import type { PlayerInfo, WorldState } from './world-state';

export interface Clan {
  id: number;
  /**
   * Bumped every time the slot is recycled (deleteTeam). Members remember the
   * uid they joined under, so a stale membership never matches a new clan that
   * happens to reuse the slot (old client World.deleteTeam).
   */
  uid: number;
  name: string;
  leaderGuid: number;
}

export type ClanNameProblem = 'empty' | 'invalid' | 'taken';

const JOIN_QUEUE_SIZE = 5;

export class ClanStore {
  clans: Clan[] = [];

  /** Our clan id, or -1. */
  teamId = -1;
  isLeader = false;
  /** Our own clan's lock: flipped by the lock / unlock sends, then stated by TEAM_LOCKED. */
  locked = false;

  /** TEAM_INVITE: the invitation waiting for an answer (the latest wins), while we have no clan. */
  invite: { clanId: number; inviterGuid: number } | null = null;

  /** TEAM_LOCKED: clans that take invitations only, no join requests. */
  private readonly lockedIds = new Set<number>();

  /** TEAM_JOIN_REQUEST (leader only): the request being shown, then up to five waiting. */
  joinRequest = 0;
  readonly joinQueue: number[] = new Array<number>(JOIN_QUEUE_SIZE).fill(0);

  /** PLAYER_POSITIONS: clan mates' positions scaled to 0..255 over the map (never our own). */
  readonly positions = new Map<number, { x: number; y: number }>();

  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private lastCreateAt = Number.NEGATIVE_INFINITY;
  /** Kick, lock and unlock share one server-side delay (lastClanManageTime). */
  private lastManageAt = Number.NEGATIVE_INFINITY;
  private nextUid = 1;

  constructor(private readonly world: WorldState) {}

  get ownGuid(): number {
    return this.world.ownGuid;
  }

  player(guid: number): PlayerInfo | undefined {
    return this.world.players.get(guid);
  }

  onlineAccountMembers(): PlayerInfo[] {
    const id = this.player(this.ownGuid)?.accountClan?.id;
    return id ? [...this.world.players.values()].filter(p => p.accountClan?.id === id) : [];
  }

  clan(id: number): Clan | undefined {
    return this.clans[id];
  }

  /** Clans a player can ask to join: occupied slots. */
  listed(): Clan[] {
    return this.clans.filter((c) => c.leaderGuid !== 0 || c.name !== '');
  }

  /** Current members of a clan: leader first, then by name, natural order (GameUI.clanMembers). */
  members(clanId: number): PlayerInfo[] {
    const clan = this.clans[clanId];
    if (!clan) return [];
    const list = Array.from(this.world.players.values()).filter(
      (p) => p.team === clan.id && p.teamUid === clan.uid,
    );
    return list.sort(
      (a, b) =>
        Number(b.guid === clan.leaderGuid) - Number(a.guid === clan.leaderGuid) ||
        a.nickname.localeCompare(b.nickname, undefined, { sensitivity: 'base', numeric: true }) ||
        a.guid - b.guid,
    );
  }

  isLocked(clanId: number): boolean {
    return this.lockedIds.has(clanId);
  }

  /** A join request could go to this clan: we have none, it exists and it is not locked. */
  canAskToJoin(clanId: number): boolean {
    const clan = this.clans[clanId];
    return (
      this.teamId === -1 && !!clan && (clan.leaderGuid !== 0 || clan.name !== '') && !this.isLocked(clanId)
    );
  }

  /** The invitation was accepted or declined: nothing is waiting any more. */
  clearInvite(): void {
    this.invite = null;
  }

  pendingCount(): number {
    return this.joinQueue.filter((id) => id !== 0).length;
  }

  /** Accept / decline consumed the shown request: show the next waiting one. */
  nextInvitation(): void {
    this.joinRequest = 0;
    for (let i = 0; i < this.joinQueue.length; i++) {
      if (this.joinQueue[i] !== 0) {
        this.joinRequest = this.joinQueue[i];
        this.joinQueue[i] = 0;
        return;
      }
    }
  }

  canRequest(nowMs: number, delayMs: number): boolean {
    return nowMs - this.lastRequestAt > delayMs;
  }
  markRequest(nowMs: number): void {
    this.lastRequestAt = nowMs;
  }
  canCreate(nowMs: number, delayMs: number): boolean {
    return nowMs - this.lastCreateAt > delayMs;
  }
  markCreate(nowMs: number): void {
    this.lastCreateAt = nowMs;
  }
  canManage(nowMs: number, delayMs: number): boolean {
    return nowMs - this.lastManageAt > delayMs;
  }
  markManage(nowMs: number): void {
    this.lastManageAt = nowMs;
  }
  setLocked(locked: boolean): void {
    this.locked = locked;
  }

  /** Server rule (Game::playerCreateClan): 1..max alphanumerics, upper-cased, unique. */
  nameProblem(name: string, maxLength: number): ClanNameProblem | null {
    if (name.length === 0) return 'empty';
    if (name.length > maxLength || !/^[A-Za-z0-9]+$/.test(name)) return 'invalid';
    const upper = name.toUpperCase();
    if (this.clans.some((c) => c.name.toUpperCase() === upper)) return 'taken';
    return null;
  }

  reset(): void {
    this.clans = [];
    this.teamId = -1;
    this.isLeader = false;
    this.locked = false;
    this.invite = null;
    this.lockedIds.clear();
    this.joinRequest = 0;
    this.joinQueue.fill(0);
    this.positions.clear();
  }

  attachBus(bus: NetEventBus): () => void {
    const cleanups: (() => void)[] = [];

    cleanups.push(
      bus.on('teamNames', (ev) => {
        this.clans = ev.names.map((name, id) => ({ id, uid: this.nextUid++, name, leaderGuid: 0 }));
        this.lockedIds.clear();
      }),
    );

    // Runs after WorldState's handshake handler (attached first), which has
    // already decoded team / teamLeader for every player.
    cleanups.push(
      bus.on('handshake', () => {
        for (const p of this.world.players.values()) {
          const clan = this.clans[p.team];
          if (!clan) {
            p.team = -1;
            p.teamLeader = false;
            continue;
          }
          p.teamUid = clan.uid;
          if (p.teamLeader) clan.leaderGuid = p.guid;
        }
        this.syncOwn();
      }),
    );

    cleanups.push(
      bus.on('teamCreated', (ev) => {
        const clan = this.clans[ev.clanId];
        if (!clan) return;
        // A slot the client saw as free is being (re)used: its old members are
        // gone, so this clan must not match them.
        if (clan.leaderGuid !== 0 && clan.leaderGuid !== ev.leaderGuid) clan.uid = this.nextUid++;
        // A new clan starts open; if it is locked, TEAM_LOCKED follows.
        this.lockedIds.delete(clan.id);
        clan.name = ev.name;
        clan.leaderGuid = ev.leaderGuid;
        const leader = this.world.players.get(ev.leaderGuid);
        if (leader) {
          leader.team = clan.id;
          leader.teamUid = clan.uid;
          leader.teamLeader = true;
        }
        if (ev.leaderGuid === this.world.ownGuid) this.locked = false;
        this.syncOwn();
      }),
    );

    cleanups.push(
      bus.on('acceptedTeam', (ev) => {
        const clan = this.clans[ev.clanId];
        const p = this.world.players.get(ev.pid);
        if (!clan || !p) return;
        p.team = clan.id;
        p.teamUid = clan.uid;
        p.teamLeader = clan.leaderGuid === p.guid;
        this.syncOwn();
      }),
    );

    cleanups.push(
      bus.on('kickedTeam', (ev) => {
        const p = this.world.players.get(ev.pid);
        if (p) {
          p.team = -1;
          p.teamLeader = false;
        }
        if (ev.pid === this.world.ownGuid) this.leaveOwn();
      }),
    );

    cleanups.push(
      bus.on('deleteTeam', (ev) => {
        const clan = this.clans[ev.clanId];
        if (!clan) return;
        clan.uid = this.nextUid++;
        clan.name = '';
        clan.leaderGuid = 0;
        this.lockedIds.delete(clan.id);
        if (this.invite?.clanId === clan.id) this.invite = null;
        for (const p of this.world.players.values()) {
          if (p.team === clan.id) {
            p.team = -1;
            p.teamLeader = false;
          }
        }
        if (this.teamId === clan.id) this.leaveOwn();
      }),
    );

    cleanups.push(
      bus.on('joinTeam', (ev) => {
        if (this.joinRequest === 0) {
          this.joinRequest = ev.pid;
          return;
        }
        const slot = this.joinQueue.indexOf(0);
        if (slot !== -1) this.joinQueue[slot] = ev.pid;
      }),
    );

    cleanups.push(
      bus.on('teamLocked', (ev) => {
        if (ev.locked) this.lockedIds.add(ev.clanId);
        else this.lockedIds.delete(ev.clanId);
        if (ev.clanId === this.teamId) this.locked = ev.locked;
      }),
    );

    cleanups.push(
      bus.on('teamInvite', (ev) => {
        if (this.teamId === -1) this.invite = { clanId: ev.clanId, inviterGuid: ev.inviterGuid };
      }),
    );

    cleanups.push(
      bus.on('teamPosition', (ev) => {
        this.positions.clear();
        for (const pos of ev.positions) {
          if (pos.guid !== this.world.ownGuid) this.positions.set(pos.guid, { x: pos.x, y: pos.y });
        }
      }),
    );

    cleanups.push(
      bus.on('otherDie', (ev) => {
        if (this.joinRequest === ev.pid) this.nextInvitation();
        const idx = this.joinQueue.indexOf(ev.pid);
        if (idx !== -1) this.joinQueue[idx] = 0;
      }),
    );

    return () => {
      for (const c of cleanups) c();
    };
  }

  private syncOwn(): void {
    const me = this.world.players.get(this.world.ownGuid);
    if (!me) return;
    if (me.team === -1) {
      if (this.teamId !== -1) this.leaveOwn();
      return;
    }
    this.teamId = me.team;
    this.isLeader = me.teamLeader;
    this.invite = null;
  }

  private leaveOwn(): void {
    this.teamId = -1;
    this.isLeader = false;
    this.locked = false;
    this.joinRequest = 0;
    this.joinQueue.fill(0);
    this.positions.clear();
  }
}
