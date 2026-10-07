// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// WorldState encapsulates game world state: dimensions, clock, player list,
// local player status, and the entity store. It subscribes to typed NetEventBus events.
import type { ClanIdentity, RunLive } from '../../../../shared/typescript/account-community';
import type { GroupInfo, NetEventBus } from '../net/events';
import { EntityStore } from './entity-store';
import { GaugeModel } from './gauge-model';
import { MapMemory } from './map-memory';
import { EntityType, type WorldEntity } from './entity-types';

export interface PlayerInfo {
  accountClan?: ClanIdentity | null;
  guid: number;
  nickname: string;
  /** Clan id, or -1. */
  team: number;
  /** The clan slot's uid at join time (ClanStore); a recycled slot no longer matches. */
  teamUid?: number;
  /** Leads `team`. */
  teamLeader: boolean;
  /** Wearable skinId from PLAYER_INFO -- cosmetic only; the drawn base skin is {@link drugSkinIndex}. */
  skin: number;
  ghoul: number;
  /** groups.xml id (1 = player). */
  groupId: number;
  verified: boolean;
  score: number;
  /**
   * Drug visuals (old client PLAYER.repellent / PLAYER.withdrawal, kept as
   * timers on the frame clock): repellent and lapadoine time left, and the
   * "withdrawn" look that outlives a withdrawal timer once it has run out.
   */
  repellentMs: number;
  withdrawalMs: number;
  withdrawn: boolean;
}

/** A player record with every optional-looking field at its login default. */
export function newPlayerInfo(guid: number, nickname: string): PlayerInfo {
  return {
    guid,
    nickname,
    team: -1,
    teamLeader: false,
    skin: 0,
    ghoul: 0,
    groupId: 1,
    verified: false,
    score: 0,
    repellentMs: 0,
    withdrawalMs: 0,
    withdrawn: false,
  };
}

/** Old client badKarmaDelay. */
const BAD_KARMA_SHOW_MS = 14000;

/** Old client REPELLENT_ACTIVE: the byte is in 2 s units; LAPADONE_ACTIVE: 1 s units. */
const REPELLENT_UNIT_MS = 2000;
const WITHDRAWAL_UNIT_MS = 1000;

/**
 * Which of the six base skins (`day-skin0..5`) a player is drawn with -- the
 * old client's skinType (Wvmnw): 0 clean, 1 repellent, 2 withdrawal, 3 both,
 * 4 withdrawn, 5 repellent while withdrawn. Nothing to do with the wearable.
 */
export function drugSkinIndex(p: PlayerInfo): number {
  if (p.repellentMs > 0) {
    if (p.withdrawalMs > 0) return 3;
    return p.withdrawn ? 5 : 1;
  }
  if (p.withdrawalMs > 0) return 2;
  return p.withdrawn ? 4 : 0;
}

/**
 * The handshake roster's team byte (old client addToTeam): 50 means no clan,
 * 0..17 is membership of that clan id, and anything above 50 marks the clan's
 * LEADER, as 51 + clan id.
 */
export const TEAM_NONE_BYTE = 50;

export function decodeTeamByte(byte: number): { team: number; teamLeader: boolean } {
  if (byte === TEAM_NONE_BYTE) return { team: -1, teamLeader: false };
  if (byte > TEAM_NONE_BYTE) return { team: byte - TEAM_NONE_BYTE - 1, teamLeader: true };
  return { team: byte, teamLeader: false };
}

export interface PlayerGauges {
  life: number;
  food: number;
  warmth: number;
  stamina: number;
  /**
   * Inverted on the wire (Player::getRadiationWireValue): this is how CLEAN the
   * player is -- 255 = no radiation, 0 = fully irradiated -- so it drains like
   * the other reserves rather than filling up.
   */
  radiation: number;
}

export class WorldClock {
  cycleMs = 240000;
  phaseMs = 0;
  isNight = false;

  // The look of dusk and dawn is a function of the phase (render/sky.ts);
  // `isNight` is only which half the clock is in.
  update(delta: number): void {
    this.phaseMs = (this.phaseMs + delta) % this.cycleMs;
    this.isNight = this.phaseMs >= Math.floor(this.cycleMs / 2);
  }

  sync(cycleMs: number, phaseMs: number, isNight: boolean): void {
    this.cycleMs = cycleMs;
    this.phaseMs = phaseMs;
    this.isNight = isNight;
  }

  /** Milliseconds until the current half (day or night) hands over to the other. */
  remainingMs(): number {
    const half = Math.floor(this.cycleMs / 2);
    const intoHalf = this.phaseMs >= half ? this.phaseMs - half : this.phaseMs;
    return Math.max(0, half - intoHalf);
  }
}

export class WorldState {
  ownRun: RunLive | null = null;
  // World bounds in tiles (100 units per tile)
  tilesX = 150;
  tilesY = 150;
  readonly tileSize = 100;

  ownGuid = -1;
  modeId = 0;

  readonly clock = new WorldClock();
  readonly entities: EntityStore;
  readonly players = new Map<number, PlayerInfo>();
  readonly groups = new Map<number, GroupInfo>();
  /**
   * BLOCKED_PLAYERS: the online players whose chat the server keeps from us.
   * The server's list lives for our session, so a new handshake starts empty.
   */
  readonly blocked = new Set<number>();
  /** Structure markers in tile coordinates (CITY_LOCATIONS). */
  cities: { x: number; y: number }[] = [];
  /** What this session has seen of the map, for the minimap and the big map. */
  readonly mapMemory = new MapMemory();
  houses: { x: number; y: number }[] = [];
  /** Smoothly integrated survival gauges for drawing (old client World.gauges). */
  readonly gauges = new GaugeModel();
  /** LEADERBOARD in the server's order (guid 0 = empty slot), plus our own SCORE / KARMA icon. */
  leaderboard: { guid: number; karma: number; score: number }[] = [];
  ownScore = 0;
  ownKarma = 0;
  /**
   * WORST_KARMA_PLAYER: the server's worst Savage/Devil player, shown as their karma
   * icon on the maps for 14 s (old client badKarma / badKarmaDelay). World
   * units; follows the live entity while it is in view.
   */
  badKarma: { guid: number; x: number; y: number; karma: number; remainingMs: number } | null =
    null;

  localPlayerGauges: PlayerGauges = {
    life: 255,
    food: 255,
    warmth: 255,
    stamina: 255,
    radiation: 255,
  };

  localPlayerAngle = 0;

  constructor(unitsPerPlayer = 100) {
    this.entities = new EntityStore(unitsPerPlayer);
  }

  get worldWidth(): number {
    return this.tilesX * this.tileSize;
  }

  get worldHeight(): number {
    return this.tilesY * this.tileSize;
  }

  /**
   * Retrieves the entity corresponding to the local player.
   */
  getLocalEntity(): WorldEntity | undefined {
    if (this.ownGuid < 0) return undefined;
    // Primary player entity is id 0 for ownGuid
    const primary = this.entities.get(this.ownGuid, 0);
    if (primary && primary.type === EntityType.PLAYER) return primary;

    // Fallback: search player entities for matching pid (a fading corpse is not us)
    const allPlayers = this.entities.getByType(EntityType.PLAYER);
    return allPlayers.find((p) => p.pid === this.ownGuid && !p.removed);
  }

  /**
   * Attaches network event listeners to update world state in real-time.
   * Returns an unbind function.
   */
  attachBus(bus: NetEventBus): () => void {
    const cleanups: (() => void)[] = [];
    cleanups.push(this.gauges.attachBus(bus));
    cleanups.push(bus.on('accountRun', run => { this.ownRun = run; }));
    cleanups.push(bus.on('accountClans', ({ players }) => {
      for (const { pid, clan } of players) {
        const info = this.players.get(pid);
        if (info) info.accountClan = clan;
      }
    }));

    cleanups.push(
      bus.on('handshake', (ev) => {
        this.ownGuid = ev.ownGuid;
        this.ownRun = null;
        this.blocked.clear();
        this.modeId = ev.modeId;
        this.entities.setUnitsPerPlayer(ev.unitsPerPlayer);
        // PLAYER_NAMES and PLAYER_INFO precede the handshake at login, so merge
        // into whatever they already recorded rather than replacing it. A
        // player neither of them named chose to play without a name: they stay
        // nameless, never a made-up "Player N" that would follow them around.
        for (const p of ev.players) {
          const existing = this.players.get(p.guid);
          const { team, teamLeader } = decodeTeamByte(p.team);
          this.players.set(p.guid, {
            ...newPlayerInfo(p.guid, existing?.nickname ?? ''),
            team,
            teamLeader,
            skin: existing?.skin ?? 0,
            groupId: existing?.groupId ?? 1,
            verified: existing?.verified ?? false,
            accountClan: existing?.accountClan ?? null,
            ghoul: p.ghoul,
            score: p.score,
            repellentMs: p.repellent * REPELLENT_UNIT_MS,
            withdrawalMs: p.withdrawal * WITHDRAWAL_UNIT_MS,
          });
        }
      }),
    );

    cleanups.push(
      bus.on('mapSize', (ev) => {
        this.tilesX = ev.width;
        this.tilesY = ev.height;
        this.mapMemory.resize(ev.width, ev.height);
      }),
    );

    cleanups.push(
      bus.on('worldTime', (ev) => {
        this.clock.sync(ev.cycleMs, ev.phaseMs, ev.isNight);
      }),
    );

    cleanups.push(
      bus.on('units', (ev) => {
        this.entities.processUnits(ev.units, ev.isFullReset);
      }),
    );

    cleanups.push(
      bus.on('gauges', (ev) => {
        this.localPlayerGauges = {
          life: ev.life,
          food: ev.food,
          warmth: ev.warmth,
          stamina: ev.stamina,
          radiation: ev.radiation,
        };
      }),
    );

    cleanups.push(
      bus.on('playerInfo', (ev) => {
        const existing = this.players.get(ev.guid);
        if (existing) {
          existing.nickname = ev.name || existing.nickname;
          existing.skin = ev.skin;
          existing.ghoul = ev.ghoul;
          existing.groupId = ev.groupId;
          existing.verified = ev.verified;
          // A fresh life: the old client's onNewPlayer zeroed both timers.
          existing.repellentMs = 0;
          existing.withdrawalMs = 0;
          existing.withdrawn = false;
        } else {
          this.players.set(ev.guid, {
            ...newPlayerInfo(ev.guid, ev.name),
            skin: ev.skin,
            ghoul: ev.ghoul,
            groupId: ev.groupId,
            verified: ev.verified,
          });
        }
      }),
    );

    cleanups.push(
      bus.on('groups', (ev) => {
        this.groups.clear();
        for (const group of ev.groups) this.groups.set(group.id, group);
      }),
    );

    cleanups.push(
      bus.on('nicknames', (ev) => {
        ev.names.forEach((name, idx) => {
          if (!name) return;
          const p = this.players.get(idx);
          if (p) {
            p.nickname = name;
          } else {
            this.players.set(idx, newPlayerInfo(idx, name));
          }
        });
      }),
    );

    cleanups.push(
      bus.on('leaderboard', (ev) => {
        this.leaderboard = ev.entries.filter((e) => e.guid !== 0);
        for (const e of this.leaderboard) {
          const p = this.players.get(e.guid);
          if (p) p.score = e.score;
        }
      }),
    );

    cleanups.push(
      bus.on('score', (ev) => {
        this.ownScore = ev.score;
      }),
    );

    cleanups.push(
      bus.on('karma', (ev) => {
        this.ownKarma = ev.clientIcon;
      }),
    );

    // REPELLENT_ACTIVE / LAPADONE_ACTIVE / DRUG_RESET, as the old client kept them: one
    // timer per channel, and DRUG_RESET (always first in the server's
    // statement, see buildConditionVisualWire) wipes both and carries the
    // withdrawn marker; POISONED is a screen effect, not a player state.
    cleanups.push(
      bus.on('drug', (ev) => {
        if (ev.kind === 'poisoned') return;
        const p = this.players.get(ev.a);
        if (!p) return;
        if (ev.kind === 'repellent') p.repellentMs = ev.b * REPELLENT_UNIT_MS;
        else if (ev.kind === 'lapadoine') p.withdrawalMs = ev.b * WITHDRAWAL_UNIT_MS;
        else {
          p.repellentMs = 0;
          p.withdrawalMs = 0;
          p.withdrawn = ev.b !== 0;
        }
      }),
    );

    cleanups.push(
      bus.on('badKarma', (ev) => {
        if (ev.guid === this.ownGuid) return;
        this.badKarma = {
          guid: ev.guid,
          x: ev.x * this.worldWidth,
          y: ev.y * this.worldHeight,
          karma: ev.karma,
          remainingMs: BAD_KARMA_SHOW_MS,
        };
      }),
    );

    cleanups.push(
      bus.on('citiesLocation', (ev) => {
        this.cities = ev.cities;
        this.houses = ev.houses;
      }),
    );

    cleanups.push(
      bus.on('blockedPlayers', (ev) => {
        this.blocked.clear();
        for (const guid of ev.guids) this.blocked.add(guid);
      }),
    );

    cleanups.push(
      bus.on('otherDie', (ev) => {
        this.entities.remove(ev.pid, 0, EntityType.PLAYER);
        if (this.badKarma?.guid === ev.pid) this.badKarma = null;
      }),
    );

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }

  /**
   * Advances game clock and entity motion per frame.
   */
  update(delta: number): void {
    this.clock.update(delta);
    this.gauges.update(delta);
    this.entities.update(delta);

    if (this.badKarma) {
      this.badKarma.remainingMs -= delta;
      if (this.badKarma.remainingMs <= 0) this.badKarma = null;
      else {
        const tracked = this.entities.get(this.badKarma.guid, 0);
        if (tracked && !tracked.removed) {
          this.badKarma.x = tracked.x;
          this.badKarma.y = tracked.y;
        }
      }
    }

    for (const p of this.players.values()) {
      if (p.repellentMs > 0) p.repellentMs = Math.max(0, p.repellentMs - delta);
      if (p.withdrawalMs > 0) {
        p.withdrawalMs = Math.max(0, p.withdrawalMs - delta);
        // Old client: an expired PLAYER.withdrawal stays > 0, i.e. skin 4.
        if (p.withdrawalMs === 0) p.withdrawn = true;
      }
    }

    // Old client (moveEntitie): our own sprite faces the cursor immediately.
    // The server echoes our rotation back quantised to 256 steps and a round
    // trip late; steering by that made aiming lag and jitter.
    const local = this.getLocalEntity();
    if (local) {
      local.angle = this.localPlayerAngle;
      local.nangle = this.localPlayerAngle;
    }
  }
}
