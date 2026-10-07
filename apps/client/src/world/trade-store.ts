// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import type { NetEventBus, TradeItem, TradeStateEvent } from '../net/events';
import type { GameSocket } from '../net/socket';

/** Server snapshots only. Inventory is never moved or debited by the UI. */
export class TradeStore {
  state: TradeStateEvent | null = null;
  pending = false;
  closing = false;
  attachBus(bus: NetEventBus): () => void {
    const off = [
      bus.on('tradeState', (state) => {
        if (this.closing && this.state?.id === state.id) return;
        this.state = state;
        this.pending = this.closing = false;
      }),
      bus.on('tradeClosed', (event) => {
        if (this.state?.id !== event.id) return;
        this.reset();
        bus.emit('alert', { text: event.reason });
      }),
      bus.on('playerDie', () => this.reset()),
      bus.on('stoleYourSession', () => this.reset()),
    ];
    return () => {
      off.forEach((fn) => fn());
      this.reset();
    };
  }
  reset(): void {
    this.state = null;
    this.pending = this.closing = false;
  }
  offer(
    socket: GameSocket,
    item: Pick<TradeItem, 'uid' | 'iid' | 'count'>,
    count = item.count,
  ): void {
    const s = this.state;
    if (
      !s ||
      s.phase !== 2 ||
      this.pending ||
      this.closing ||
      !Number.isInteger(count) ||
      count < 0 ||
      count > 255
    )
      return;
    const existing = s.own.find((offer) => offer.uid === item.uid && offer.iid === item.iid);
    if ((existing?.count ?? 0) === count) return;
    this.pending = true;
    socket.tradeOffer(s.id, s.revision, item.iid, item.uid, count);
  }
  reply(socket: GameSocket, accept: boolean): void {
    if (!this.state || this.state.phase !== 1 || this.pending) return;
    this.pending = true;
    socket.tradeReply(this.state.id, accept);
  }
  accept(socket: GameSocket): void {
    const s = this.state;
    if (
      !s ||
      s.phase !== 2 ||
      this.pending ||
      this.closing ||
      s.accepted & 1 ||
      !(s.own.length + s.theirs.length)
    )
      return;
    this.pending = true;
    socket.tradeAccept(s.id, s.revision);
  }
  cancel(socket: GameSocket): void {
    if (!this.state || this.closing) return;
    this.closing = this.pending = true;
    socket.tradeCancel(this.state.id);
  }
}
