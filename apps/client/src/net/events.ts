// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import type { ContentManifest, ContentPatch, ContentTable } from '../../../../shared/typescript/content-format';
import type { FittedMod } from '../world/weapon-mods';
import type {
  ChatChannel,
  DisconnectReason,
  GaugeDirection,
  GaugeSlotName,
  ServerLogKind,
  StatusKind,
} from './opcodes';

export interface HandshakePlayer {
  guid: number;
  team: number;
  ghoul: number;
  tokenId: number;
  score: number;
  repellent: number;
  withdrawal: number;
}

export interface HandshakeEvent {
  ownGuid: number;
  unitsPerPlayer: number;
  playerCount: number;
  modeId: number;
  players: HandshakePlayer[];
}

export interface MapSizeEvent {
  width: number;
  height: number;
}

export interface WorldTimeEvent {
  cycleMs: number;
  phaseMs: number;
  isNight: boolean;
}

export interface UnitRecord {
  pid: number;
  id: number;
  rotation: number;
  type: number;
  state: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  extra: number;
}

export interface UnitsEvent {
  isFullReset: boolean;
  units: UnitRecord[];
}

export interface GaugesEvent {
  life: number;
  food: number;
  warmth: number;
  stamina: number;
  radiation: number;
}

export interface GaugeStateEvent {
  life: GaugeDirection;
  food: GaugeDirection;
  warmth: GaugeDirection;
  stamina: GaugeDirection;
  radiation: GaugeDirection;
}

export interface GaugeRate {
  max: number;
  inc: number;
  dec: number;
}

export type GaugeRatesEvent = Record<GaugeSlotName, GaugeRate>;

export interface InventorySlotEvent {
  uid: number;
  iid: number;
  count: number;
  ammo: number;
}

export interface InventorySlotData {
  iid: number;
  count: number;
  uid: number;
  ammo: number;
}

export interface FullInventoryEvent {
  slots: InventorySlotData[];
}

/** The complete fitted-mod list of one inventory item, by wire uid (ITEM_MODS). */
export interface ItemModsEvent {
  uid: number;
  mods: FittedMod[];
}

/** AIM_STATE: aiming turned on or off, with the server's maxViewportX/Y. */
export interface AimStateEvent {
  active: boolean;
  viewX: number;
  viewY: number;
}

export interface SelectedItemEvent {
  iid: number;
}

/** One chat line as the server delivered it (our own lines come back as echoes). */
export interface ChatEvent {
  channel: ChatChannel;
  /** Speaker guid, or CHAT_SYSTEM_PID for a line the server wrote. */
  pid: number;
  /** PRIVATE: the other party of the conversation. 0 otherwise. */
  peer: number;
  /** CHAT_FLAG_* bits about the speaker. */
  flags: number;
  text: string;
}

export interface StatusMessageEvent {
  kind: StatusKind;
  text: string;
}

export interface ServerLogEvent {
  kind: ServerLogKind;
  a: number;
  b: number;
  text: string;
}

export interface ChatAccessEvent {
  /** Bit (1 << channel) set = we may write to that channel. */
  mask: number;
}

export interface AlertEvent {
  text: string;
}

export interface DisconnectReasonEvent {
  /** A DisconnectReason code; an unknown future code arrives as its number. */
  reason: DisconnectReason;
  detail: string;
}

/** The socket closed on its own (or the watchdog gave up); never after our own close(). */
export interface ConnectionClosedEvent {
  code: number;
  reason: string;
  /** Whether the WebSocket had opened: false means the server was never reached. */
  opened: boolean;
}

export interface NicknamesEvent {
  names: (string | null)[];
  sessionToken: string;
}

export interface PlayerInfoEvent {
  guid: number;
  tokenId: number;
  skin: number;
  ghoul: number;
  name: string;
  /** data/XML/groups.xml id; 0 from servers that predate it. */
  groupId: number;
  /** Logged in with an account (the checkmark badge). */
  verified: boolean;
}

export interface GroupInfo {
  id: number;
  name: string;
  /** Badge key: 'tutor' | 'gamemaster' | 'admin' | anything the server defines. */
  badge: string;
}

export interface GroupsEvent {
  groups: GroupInfo[];
}

export interface TeamCreatedEvent {
  clanId: number;
  leaderGuid: number;
  name: string;
}

export interface TeamNamesEvent {
  names: string[];
}

export interface DamageIndicatorEvent {
  x: number;
  y: number;
  amount: number;
  pct: number;
}

/**
 * NOTIFICATION: a player's gauge crossed a threshold (server checkGaugeNotification).
 * type 0 health / 1 hunger / 2 cold / 3 radiation; level 0 ~80% / 1 ~50% / 2 ~20%.
 * Broadcast to everyone in range -- the old client pops alert{type}_{level}.png over that player.
 */
export interface NotificationEvent {
  pid: number;
  type: number;
  level: number;
}

export interface PlayerHitEvent {
  pid: number;
  angle: number;
}

export interface PlayerHealEvent {
  pid: number;
}

export interface PlayerLifeEvent {
  life: number;
}

export interface PlayerStaminaEvent {
  stamina: number;
}

export interface PlayerDieEvent {
  kills: number;
}

export interface OtherDieEvent {
  pid: number;
}

export interface PlayerXpEvent {
  xp: number;
}

export interface PlayerXpSkillEvent {
  level: number;
  /** XP progress within the current level. */
  xp: number;
  /** Item ids the player has unlocked. */
  skills: number[];
}

export interface BoughtSkillEvent {
  iid: number;
}

export interface StartCraftEvent {
  iid: number;
}

export interface OpenBuildingEvent {
  /** Station area id (objects[].station.areaId). */
  area: number;
  /** 0..255 of the active queue slot's craft time elapsed. */
  progress: number;
  activeSlot: number;
  /** Four queue slots, iid or 0. */
  queue: number[];
  /** 0 opens the window; 1 is a contents update. */
  isLogin: number;
  /** Fuel byte (0..255). */
  fuel: number;
  /** Actual remaining burn time, including the partially consumed unit. */
  fuelMs: number;
}

export interface NewFuelValueEvent {
  fuel: number;
  fuelMs: number;
}

export interface WrongToolEvent {
  toolIid: number;
}

export interface FullChestSlot {
  iid: number;
  count: number;
  ammo: number;
  mods: FittedMod[];
}

export interface FullChestEvent {
  /** 1 on the packet that opens the container; 0 for a contents refresh. */
  firstOpen: boolean;
  slots: number;
  items: FullChestSlot[];
}

/** A player joined a clan (broadcast). */
export interface AcceptedTeamEvent {
  pid: number;
  clanId: number;
}

/** A player left / was kicked from their clan (broadcast). */
export interface KickedTeamEvent {
  pid: number;
}

/** Leader only: this player asks to join your clan. */
export interface JoinTeamEvent {
  pid: number;
}

export interface TeamInviteEvent {
  clanId: number;
  inviterGuid: number;
}

export interface TeamLockedEvent {
  clanId: number;
  locked: boolean;
}

export interface BlockedPlayersEvent {
  guids: number[];
}

export interface TeamPosition {
  guid: number;
  /** 0..255 across the map width / height. */
  x: number;
  y: number;
}

export interface TeamPositionEvent {
  positions: TeamPosition[];
}

export interface KarmaEvent {
  clientIcon: number;
}

/** The server's worst-karma player: where they are (0..1 map fractions) and which KARMA icon. */
export interface BadKarmaEvent {
  guid: number;
  x: number;
  y: number;
  karma: number;
}

export interface AreasEvent {
  areas: number[];
}

export interface ShakeExplosionStateEvent {
  shake: number;
}

export interface PlayerEatEvent {
  /** Guid of the player who ate (the packet carries no item id). */
  pid: number;
}

/** Structure markers for the minimap, in tile coordinates. */
export interface CitiesLocationEvent {
  cities: { x: number; y: number }[];
  houses: { x: number; y: number }[];
}

export interface DrugEvent {
  kind: 'poisoned' | 'repellent' | 'lapadoine' | 'reset';
  a: number;
  b: number;
}

export interface DramaticChronoEvent {
  remainingMs: number;
}

export interface LeaderboardEntry {
  guid: number;
  /** Karma icon index 0..4 (Game::LeaderboardSlot). */
  karma: number;
  score: number;
}

export interface LeaderboardEvent {
  entries: LeaderboardEntry[];
}

export interface ScoreEvent {
  score: number;
}

export interface StartInteractionEvent {
  delayMultiplier: number;
}

export interface OldVersionEvent {
  requiredVersion: number;
}

export interface TradeItem { uid: number; iid: number; count: number; ammo: number; mods: FittedMod[]; }
export interface TradeStateEvent {
  id: number; revision: number; peer: number;
  /** 0 = outgoing invitation, 1 = incoming, 2 = both editing offers. */
  phase: 0 | 1 | 2;
  accepted: number; rangeTiles: number; own: TradeItem[]; theirs: TradeItem[];
}

export interface NetEventMap {
  accountRun: import('../../../../shared/typescript/account-community').RunLive;
  accountClans: { players: { pid: number; clan: import('../../../../shared/typescript/account-community').ClanIdentity | null }[] };

  npcState: import('../../../../shared/typescript/npc-protocol').NpcState;
  npcClosed: { session: number; reason: string };
  questState: import('./handlers/quest').QuestStateEvent;
  questProgress: import('./handlers/quest').QuestProgressEvent;
  questMarkers: import('./handlers/quest').QuestMarkersEvent;
  progressState: import('./handlers/progress').ProgressStateEvent;
  progressUpdate: import('./handlers/progress').ProgressUpdateEvent;
  achievementUnlocked: import('./handlers/progress').AchievementUnlockedEvent;
  tradeState: TradeStateEvent;
  tradeClosed: { id: number; reason: string };
  handshake: HandshakeEvent;
  mapSize: MapSizeEvent;
  worldTime: WorldTimeEvent;
  units: UnitsEvent;
  gauges: GaugesEvent;
  gaugeState: GaugeStateEvent;
  gaugeRates: GaugeRatesEvent;
  inventorySlot: InventorySlotEvent;
  itemMods: ItemModsEvent;
  aimState: AimStateEvent;
  fullInventory: FullInventoryEvent;
  selectedItem: SelectedItemEvent;
  chat: ChatEvent;
  serverLog: ServerLogEvent;
  statusMessage: StatusMessageEvent;
  chatAccess: ChatAccessEvent;
  alert: AlertEvent;
  disconnectReason: DisconnectReasonEvent;
  /** Local (GameSocket): the WebSocket opened, before the login frame. */
  connectionOpened: void;
  /** Local (GameSocket): a frame arrived. */
  connectionActivity: void;
  /** Local (GameSocket): the login frame went out. */
  loginSent: void;
  /** Local (GameSocket): see ConnectionClosedEvent. */
  connectionClosed: ConnectionClosedEvent;
  nicknames: NicknamesEvent;
  playerInfo: PlayerInfoEvent;
  groups: GroupsEvent;
  teamCreated: TeamCreatedEvent;
  teamNames: TeamNamesEvent;
  damageIndicator: DamageIndicatorEvent;
  playerHit: PlayerHitEvent;
  notification: NotificationEvent;
  playerHeal: PlayerHealEvent;
  playerLife: PlayerLifeEvent;
  playerStamina: PlayerStaminaEvent;
  playerDie: PlayerDieEvent;
  otherDie: OtherDieEvent;
  playerXp: PlayerXpEvent;
  playerXpSkill: PlayerXpSkillEvent;
  boughtSkill: BoughtSkillEvent;
  startCraft: StartCraftEvent;
  blueprint: { iid: number };
  openBuilding: OpenBuildingEvent;
  lostBuilding: void;
  newFuelValue: NewFuelValueEvent;
  wrongTool: WrongToolEvent;
  fullChest: FullChestEvent;
  acceptedTeam: AcceptedTeamEvent;
  kickedTeam: KickedTeamEvent;
  deleteTeam: { clanId: number };
  joinTeam: JoinTeamEvent;
  teamInvite: TeamInviteEvent;
  teamLocked: TeamLockedEvent;
  blockedPlayers: BlockedPlayersEvent;
  teamPosition: TeamPositionEvent;
  karma: KarmaEvent;
  badKarma: BadKarmaEvent;
  areas: AreasEvent;
  shakeExplosionState: ShakeExplosionStateEvent;
  playerEat: PlayerEatEvent;
  citiesLocation: CitiesLocationEvent;
  drug: DrugEvent;
  dramaticChrono: DramaticChronoEvent;
  leaderboard: LeaderboardEvent;
  score: ScoreEvent;
  startInteraction: StartInteractionEvent;
  interruptInteraction: void;
  oldVersion: OldVersionEvent;
  full: void;
  kickInactivity: void;
  failRestoreSession: void;
  stoleYourSession: void;
  mute: { durationSec: number };
  wrongPassword: void;
  pong: void;
  contentManifest: ContentManifest;
  contentTable: ContentTable;
  contentPatch: ContentPatch;
}

export type NetEventListener<K extends keyof NetEventMap> = (data: NetEventMap[K]) => void;

export class NetEventBus {
  private readonly listeners = new Map<keyof NetEventMap, Set<NetEventListener<any>>>();

  on<K extends keyof NetEventMap>(event: K, listener: NetEventListener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof NetEventMap>(event: K, listener: NetEventListener<K>): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
    }
  }

  emit<K extends keyof NetEventMap>(event: K, data: NetEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      // One broken listener must not starve the others of the event (world
      // state, inventory and UI all listen to the same messages).
      try {
        listener(data);
      } catch (error) {
        this.reportListenerError(event, error);
      }
    }
  }

  /** Events whose listener failure was already logged; a per-frame event would flood the console. */
  private readonly reported = new Set<keyof NetEventMap>();

  private reportListenerError(event: keyof NetEventMap, error: unknown): void {
    if (this.reported.has(event)) return;
    this.reported.add(event);
    console.error(
      `[net] a '${String(event)}' listener failed (later failures of it are not logged):`,
      error,
    );
  }

  clear(): void {
    this.listeners.clear();
  }
}
