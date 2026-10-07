// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import type {
  ContentManifest,
  ContentPatch,
  ContentTable,
  ContentTableName,
} from '../../../../shared/typescript/content-format';
import type { ContentCache } from '../content/cache';
import type { ContentStore } from '../content/store';
import { unwrapBatch } from './batch';
import { dispatchServerMessage } from './dispatcher';
import type { NetEventBus } from './events';
import { ClientOpcode, type ChatChannel, type MouseDirection, type MoveMask } from './opcodes';
import {
  buildAimMessage,
  buildNpcActionMessage,
  buildTradeRequestMessage,
  buildTradeReplyMessage,
  buildTradeOfferMessage,
  buildTradeAcceptMessage,
  buildTradeCancelMessage,
  buildLookAtMessage,
  buildAcceptJoinTeamMessage,
  buildAddFuelMessage,
  buildCancelCraftMessage,
  buildChatMessage,
  buildChatChannelMessage,
  buildCloseContainerMessage,
  buildContentRequestMessage,
  buildCreateTeamMessage,
  buildDeleteTeamMessage,
  buildEquipItemMessage,
  buildInteractMessage,
  buildKickTeamMessage,
  buildLeaveTeamMessage,
  buildInviteTeamMessage,
  buildAcceptTeamInviteMessage,
  buildBlockPlayerMessage,
  buildQuestActionMessage,
  buildPrivateMessagesMessage,
  buildLockTeamMessage,
  buildLoginMessage,
  buildMouseDownMessage,
  buildMouseDirectionMessage,
  buildMouseUpMessage,
  buildMoveMessage,
  buildPingMessage,
  buildPlaceObjectMessage,
  buildReloadMessage,
  buildRequestJoinTeamMessage,
  buildRotationMessage,
  buildShiftMessage,
  buildSplitItemMessage,
  buildStackItemMessage,
  buildStartCraftManualMessage,
  buildStartCraftStationMessage,
  buildStoreItemMessage,
  buildMoveContainerItemMessage,
  buildTakeFromStationMessage,
  buildTakeItemMessage,
  buildTakeLootMessage,
  buildThrowItemMessage,
  buildUnlockSkillMessage,
  buildUnlockTeamMessage,
  buildWeaponModMessage,
  type LoginOptions,
} from './outbound';

export interface GameSocketOptions {
  url: string;
  login: LoginOptions;
  bus: NetEventBus;
  contentStore?: ContentStore;
  cache?: ContentCache;
  contentSyncTimeoutMs?: number;
  pingIntervalMs?: number;
  watchdogTimeoutMs?: number;
  WebSocketClass?: typeof WebSocket;
  onOpen?: () => void;
  onClose?: (event: { code: number; reason: string; opened: boolean }) => void;
  onError?: (error: unknown) => void;
}

export class GameSocket {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private loggedIn = false;
  /** The current WebSocket reached `open`; false = the server was never reached. */
  private opened = false;
  private pendingTables = new Set<string>();
  private unbindEvents: (() => void)[] = [];

  readonly bus: NetEventBus;
  readonly options: GameSocketOptions;
  /**
   * Cumulative traffic counters for the profiler (messages after batch
   * unwrap) and the round trip of the last keepalive (-1 until one answered).
   */
  readonly stats = { messages: 0, bytes: 0, decodeMs: 0, rttMs: -1 };
  /** When the keepalive in flight went out; 0 when none is. */
  private pingSentAt = 0;

  constructor(options: GameSocketOptions) {
    this.options = options;
    this.bus = options.bus;
  }

  tradeRequest(target: number): void {
    this.send(buildTradeRequestMessage(target));
  }
  lookAt(entityId: number, pid: number): void {
    this.send(buildLookAtMessage(entityId, pid));
  }
  tradeReply(id: number, accept: boolean): void {
    this.send(buildTradeReplyMessage(id, accept));
  }
  tradeOffer(id: number, revision: number, iid: number, uid: number, count: number): void {
    this.send(buildTradeOfferMessage(id, revision, iid, uid, count));
  }
  tradeAccept(id: number, revision: number): void {
    this.send(buildTradeAcceptMessage(id, revision));
  }
  tradeCancel(id: number): void {
    this.send(buildTradeCancelMessage(id));
  }

  connect(): void {
    const WS = this.options.WebSocketClass ?? (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!WS) throw new Error('No WebSocket implementation available');

    this.closed = false;
    this.loggedIn = false;
    this.opened = false;
    this.pendingTables.clear();
    this.unbindEvents.forEach((u) => u());
    this.unbindEvents = [];

    this.unbindEvents.push(
      this.bus.on('pong', () => {
        if (this.pingSentAt > 0) {
          this.stats.rttMs = performance.now() - this.pingSentAt;
          this.pingSentAt = 0;
        }
      }),
    );
    this.unbindEvents.push(
      this.bus.on('contentManifest', (manifest) => {
        void this.handleContentManifest(manifest);
      }),
      this.bus.on('contentTable', (table) => {
        this.handleContentTable(table);
      }),
      this.bus.on('contentPatch', (patch) => {
        this.handleContentPatch(patch);
      }),
    );

    this.ws = new WS(this.options.url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      if (this.closed) return;
      this.opened = true;
      this.bus.emit('connectionOpened', undefined as unknown as void);
      if (this.options.contentStore) {
        // Wait for CONTENT_MANIFEST from server, fallback to login if not received
        this.syncTimeoutTimer = setTimeout(() => {
          if (!this.loggedIn && !this.closed) {
            this.sendLogin();
          }
        }, this.options.contentSyncTimeoutMs ?? 500);
      } else {
        this.sendLogin();
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      if (this.closed) return;
      this.resetWatchdog();
      this.bus.emit('connectionActivity', undefined as unknown as void);

      const data = event.data;
      let bytes: Uint8Array;
      if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
      } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else {
        return; // Ignore non-binary frames
      }

      const t0 = performance.now();
      const messages = unwrapBatch(bytes);
      for (const m of messages) {
        // A frame batches many messages; one that fails to decode must not
        // take the rest of the frame (and the client's picture of the world)
        // down with it.
        try {
          dispatchServerMessage(m, this.bus);
        } catch (error) {
          this.reportDispatchError(m[0] ?? -1, error);
        }
      }
      this.stats.messages += messages.length;
      this.stats.bytes += bytes.byteLength;
      this.stats.decodeMs += performance.now() - t0;
    };

    this.ws.onerror = (err) => {
      this.options.onError?.(err);
    };

    this.ws.onclose = (event) => {
      if (this.syncTimeoutTimer) {
        clearTimeout(this.syncTimeoutTimer);
        this.syncTimeoutTimer = null;
      }
      this.stopHeartbeat();
      this.reportClosed(event.code, event.reason);
    };
  }

  send(data: Uint8Array): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return true;
    }
    return false;
  }

  // --- Outbound client actions ---

  move(mask: MoveMask): void {
    this.send(buildMoveMessage(mask));
  }

  mouseDirection(dir: MouseDirection): void {
    this.send(buildMouseDirectionMessage(dir));
  }

  mouseDown(): void {
    this.send(buildMouseDownMessage());
  }

  mouseUp(): void {
    this.send(buildMouseUpMessage());
  }

  rotation(degrees: number): void {
    this.send(buildRotationMessage(degrees));
  }

  shift(enabled: boolean): void {
    this.send(buildShiftMessage(enabled));
  }

  /** AIM; the server decides whether aiming is active and says so with AIM_STATE. */
  aim(held: boolean): void {
    this.send(buildAimMessage(held));
  }

  chat(text: string): void {
    this.send(buildChatMessage(text));
  }

  /** A line on `channel`; `target` is the peer guid for PRIVATE and ignored otherwise. */
  chatChannel(channel: ChatChannel, target: number, text: string): boolean {
    try { return this.send(buildChatChannelMessage(channel, target, text)); }
    catch { return false; }
  }

  npcAction(command: import('../../../../shared/typescript/npc-protocol').NpcCommand): void {
    this.send(buildNpcActionMessage(command));
  }

  equipItem(iid: number, uid: number, count = 0, ammo = 0): void {
    this.send(buildEquipItemMessage(iid, uid, count, ammo));
  }

  throwItem(iid: number, uid: number, count = 1, ammo = 0): void {
    this.send(buildThrowItemMessage(iid, uid, count, ammo));
  }

  storeItem(iid: number, uid: number, count = 1, ammo = 0, containerSlot = 255): void {
    this.send(buildStoreItemMessage(iid, uid, count, ammo, containerSlot));
  }

  splitItem(iid: number, count: number, uid: number): void {
    this.send(buildSplitItemMessage(iid, count, uid));
  }

  stackItem(
    dragIid: number,
    dragCount: number,
    dragUid: number,
    targetCount: number,
    targetUid: number,
  ): void {
    this.send(buildStackItemMessage(dragIid, dragCount, dragUid, targetCount, targetUid));
  }

  takeLoot(lootId: number): void {
    this.send(buildTakeLootMessage(lootId));
  }

  reload(): void {
    this.send(buildReloadMessage());
  }

  /** PLACE_OBJECT: `i` is the tile ROW, `j` the COLUMN, as the server reads them. */
  placeObject(rotationIndex: number, i: number, j: number): void {
    this.send(buildPlaceObjectMessage(rotationIndex, i, j));
  }

  interact(
    opcode:
      | typeof ClientOpcode.OPEN_STATION_15
      | typeof ClientOpcode.OPEN_STATION_16
      | typeof ClientOpcode.OPEN_CONTAINER
      | typeof ClientOpcode.INTERACT_LAMP
      | typeof ClientOpcode.INTERACT_SWITCH
      | typeof ClientOpcode.INTERACT_TIMER,
    entityId: number,
    pid = 0,
  ): void {
    this.send(buildInteractMessage(opcode, entityId, pid));
  }

  takeItem(containerSlot: number): void {
    this.send(buildTakeItemMessage(containerSlot));
  }

  moveContainerItem(from: number, to: number): void {
    this.send(buildMoveContainerItemMessage(from, to));
  }

  takeFromStation(stationSlot: number): void {
    this.send(buildTakeFromStationMessage(stationSlot));
  }

  closeContainer(): void {
    this.send(buildCloseContainerMessage());
  }

  craftManual(iid: number): void {
    this.send(buildStartCraftManualMessage(iid));
  }

  craftStation(iid: number): void {
    this.send(buildStartCraftStationMessage(iid));
  }

  cancelCraft(): void {
    this.send(buildCancelCraftMessage());
  }

  unlockSkill(iid: number): void {
    this.send(buildUnlockSkillMessage(iid));
  }

  addFuel(amount: number): void {
    this.send(buildAddFuelMessage(amount));
  }

  createTeam(name: string): void {
    this.send(buildCreateTeamMessage(name));
  }

  deleteTeam(): void {
    this.send(buildDeleteTeamMessage());
  }

  requestJoinTeam(clanId: number): void {
    this.send(buildRequestJoinTeamMessage(clanId));
  }

  acceptJoinTeam(guid: number): void {
    this.send(buildAcceptJoinTeamMessage(guid));
  }

  kickTeam(guid: number): void {
    this.send(buildKickTeamMessage(guid));
  }

  lockTeam(): void {
    this.send(buildLockTeamMessage());
  }

  unlockTeam(): void {
    this.send(buildUnlockTeamMessage());
  }

  leaveTeam(): void {
    this.send(buildLeaveTeamMessage());
  }

  inviteTeam(guid: number): void {
    this.send(buildInviteTeamMessage(guid));
  }

  acceptTeamInvite(clanId: number): void {
    this.send(buildAcceptTeamInviteMessage(clanId));
  }

  /** QUEST_ACTION (QuestAction in quest-protocol.ts). */
  questAction(questId: number, action: number): void {
    this.send(buildQuestActionMessage(questId, action));
  }

  /** WEAPON_MOD; the server times it, applies it and answers with ITEM_MODS. */
  weaponMod(weaponUid: number, slot: number, modUid: number | null): void {
    this.send(buildWeaponModMessage(weaponUid, slot, modUid));
  }

  blockPlayer(guid: number, blocked: boolean): void {
    this.send(buildBlockPlayerMessage(guid, blocked));
  }

  /** PrivateMessagePolicy value. */
  setPrivateMessages(policy: number): void {
    this.send(buildPrivateMessagesMessage(policy));
  }

  close(): void {
    this.closed = true;
    if (this.syncTimeoutTimer) {
      clearTimeout(this.syncTimeoutTimer);
      this.syncTimeoutTimer = null;
    }
    this.unbindEvents.forEach((u) => u());
    this.unbindEvents = [];
    this.stopHeartbeat();
    if (this.ws) {
      // A close we initiated is not a "connection lost" for the owner: the
      // watchdog and disconnect() already report it (or chose not to).
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }

  disconnect(): void {
    this.close();
  }

  private sendLogin(): void {
    if (this.loggedIn || this.closed) return;
    this.loggedIn = true;
    if (this.syncTimeoutTimer) {
      clearTimeout(this.syncTimeoutTimer);
      this.syncTimeoutTimer = null;
    }
    this.send(buildLoginMessage(this.options.login));
    this.bus.emit('loginSent', undefined as unknown as void);
    this.startHeartbeat();
    this.options.onOpen?.();
  }

  private async handleContentManifest(manifest: ContentManifest): Promise<void> {
    if (this.loggedIn || this.closed) return;
    if (this.syncTimeoutTimer) {
      clearTimeout(this.syncTimeoutTimer);
      this.syncTimeoutTimer = null;
    }

    const store = this.options.contentStore;
    if (!store) {
      this.sendLogin();
      return;
    }

    const cache = this.options.cache;
    const missing: string[] = [];

    for (const [name, info] of Object.entries(manifest.tables)) {
      let hit = false;
      if (cache) {
        try {
          const cached = await cache.get(name, info.hash);
          if (cached && cached.version === info.version && cached.hash === info.hash) {
            store.load(cached);
            hit = true;
          }
        } catch {
          // Cache read failure: ignore, will request fresh table
        }
      }
      if (!hit) {
        missing.push(name);
        this.pendingTables.add(name);
      }
    }

    if (missing.length > 0) {
      this.send(buildContentRequestMessage(missing));
      this.syncTimeoutTimer = setTimeout(() => {
        if (!this.loggedIn && !this.closed) {
          console.warn('[net] Content sync timeout waiting for tables, logging in');
          this.sendLogin();
        }
      }, this.options.contentSyncTimeoutMs ?? 2000);
    } else {
      this.sendLogin();
    }
  }

  private handleContentTable(table: ContentTable): void {
    if (this.closed) return;
    const store = this.options.contentStore;
    if (store) {
      try {
        store.load(table);
      } catch (err) {
        console.warn(`[net] Failed to load table ${table.name}:`, err);
      }
    }
    if (this.options.cache) {
      void this.options.cache.put(table);
    }

    if (this.pendingTables.has(table.name)) {
      this.pendingTables.delete(table.name);
      if (this.pendingTables.size === 0 && !this.loggedIn) {
        this.sendLogin();
      }
    }
  }

  private handleContentPatch(patch: ContentPatch): void {
    if (this.closed) return;
    const store = this.options.contentStore;
    if (!store) return;
    const res = store.applyPatch(patch);
    if (res === 'stale') {
      console.warn(`[net] Content patch stale for ${patch.name}, requesting full table`);
      this.send(buildContentRequestMessage([patch.name]));
    } else if (res === 'applied') {
      const snap = store.snapshot(patch.name as ContentTableName);
      if (snap && this.options.cache) {
        void this.options.cache.put(snap);
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Every 2 s (the server allows 2/s): often enough for a live ping readout.
    const pingMs = this.options.pingIntervalMs ?? 2000;
    this.pingTimer = setInterval(() => {
      this.pingSentAt = performance.now();
      this.send(buildPingMessage());
    }, pingMs);
    this.resetWatchdog();
  }

  private resetWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    const timeoutMs = this.options.watchdogTimeoutMs ?? 15000;
    this.watchdogTimer = setTimeout(() => {
      // Server timed out without any messages or pongs
      this.close();
      this.reportClosed(4000, 'Watchdog timeout');
    }, timeoutMs);
  }

  /** Opcodes whose failure was already logged, so a broken one cannot flood the console. */
  private readonly failedOpcodes = new Set<number>();

  private reportDispatchError(opcode: number, error: unknown): void {
    if (this.failedOpcodes.has(opcode)) return;
    this.failedOpcodes.add(opcode);
    console.error(
      `[net] server message ${opcode} failed to dispatch (later failures of it are not logged):`,
      error,
    );
  }

  private reportClosed(code: number, reason: string): void {
    const event = { code, reason, opened: this.opened };
    this.options.onClose?.(event);
    this.bus.emit('connectionClosed', event);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}
