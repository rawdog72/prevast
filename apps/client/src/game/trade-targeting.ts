// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/game/trade-targeting.ts
// "Trade with…" from an item's right-click menu: the item rides on the cursor
// until a player is clicked, that player gets the usual trade request, and
// once they accept the item goes in as the first offer. Everything after that
// is the ordinary trade window. The server still decides who can trade.

import type { Camera } from '../core/camera';
import type { NetEventBus } from '../net/events';
import type { GameSocket } from '../net/socket';
import { EntityType } from '../world/entity-types';
import type { InventoryStore } from '../world/inventory-store';
import type { TradeStore } from '../world/trade-store';
import type { WorldState } from '../world/world-state';

/** Pick the visible body under the cursor using the rendered, interpolated position. */
export function playerAt(world: WorldState, camera: Camera, x: number, y: number): number | null {
  const point = camera.screenToWorld(x, y);
  let best = 36 * 36,
    pid: number | null = null;
  for (const player of world.entities.getByType(EntityType.PLAYER)) {
    if (player.pid === world.ownGuid) continue;
    const distance = (point.x - player.x) ** 2 + (point.y - player.y) ** 2;
    if (distance <= best) {
      best = distance;
      pid = player.pid;
    }
  }
  return pid;
}

export interface TradeItemRef {
  iid: number;
  uid: number;
}

/**
 * How long a request may go unanswered by a session before it is forgotten.
 * The server refuses a request (out of range, peer busy, ghoul) with an alert
 * and no session at all, so there is nothing else to wait for.
 */
const REQUEST_TIMEOUT_MS = 3000;

export class TradeTargeting {
  /** The item on the cursor, waiting for a player to be clicked. */
  item: TradeItemRef | null = null;
  /** Requested: offered as soon as the session it belongs to opens. */
  private pending: { item: TradeItemRef; session: number; since: number } | null = null;

  get active(): boolean {
    return this.item !== null;
  }

  begin(item: TradeItemRef): void {
    this.item = { iid: item.iid, uid: item.uid };
  }

  cancel(): void {
    this.item = null;
  }

  /**
   * A click on the world while an item is on the cursor. On a player it sends
   * the request; anywhere else it just puts the item back. Either way the
   * click is spent here and never reaches the game as an attack.
   */
  pick(pid: number | null, socket: GameSocket, now: number): boolean {
    const item = this.item;
    this.item = null;
    if (!item || pid === null) return false;
    socket.tradeRequest(pid);
    this.pending = { item, session: 0, since: now };
    return true;
  }

  /** Attach after the TradeStore, so its state is current when a session opens. */
  attachBus(
    bus: NetEventBus,
    trade: TradeStore,
    inventory: InventoryStore,
    socket: GameSocket,
  ): () => void {
    const off = [
      bus.on('tradeState', (state) => {
        const p = this.pending;
        if (!p) return;
        // Our own outgoing invitation: this is the session the item belongs to.
        if (p.session === 0 && state.phase === 0) p.session = state.id;
        if (state.id !== p.session || state.phase !== 2) return;
        this.pending = null;
        const live = inventory.slots.find(
          (slot) => slot.uid === p.item.uid && slot.iid === p.item.iid,
        );
        if (live && live.count > 0) trade.offer(socket, live);
      }),
      bus.on('tradeClosed', (event) => {
        if (this.pending?.session === event.id) this.pending = null;
      }),
      bus.on('playerDie', () => {
        this.item = null;
        this.pending = null;
      }),
    ];
    return () => off.forEach((fn) => fn());
  }

  update(now: number): void {
    if (this.pending?.session === 0 && now - this.pending.since > REQUEST_TIMEOUT_MS)
      this.pending = null;
  }
}
