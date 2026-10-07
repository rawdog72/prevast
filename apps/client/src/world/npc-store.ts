// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { NpcAction, type NpcState } from '../../../../shared/typescript/npc-protocol';
import type { NetEventBus } from '../net/events';
import type { GameSocket } from '../net/socket';

export class NpcStore {
  state: NpcState | null = null;
  pending = false;
  private nextRequest = 0;
  private pendingSince = 0;
  private hiddenPanel = false;
  private closedSession = 0;

  get panel(): '' | 'shop' | 'bank' { return this.hiddenPanel ? '' : this.state?.panel ?? ''; }
  attachBus(bus: NetEventBus): () => void {
    const cleanups = [
      bus.on('npcState', state => this.receive(state)),
      bus.on('npcClosed', ({ session }) => { if (this.state?.session === session) this.reset(); }),
      bus.on('playerDie', () => this.reset()),
      bus.on('handshake', () => { this.reset(); this.closedSession = 0; }),
    ];
    return () => cleanups.forEach(fn => fn());
  }
  receive(state: NpcState): void {
    if (state.session <= this.closedSession || (this.state && state.session < this.state.session)) return;
    if (this.state?.session === state.session && this.state.revision >= state.revision) return;
    if (this.state?.session !== state.session) this.nextRequest = 0;
    if (state.panel !== this.state?.panel || state.text) this.hiddenPanel = false;
    this.state = state;
    this.nextRequest = Math.max(this.nextRequest, state.request);
    this.pending = false;
  }
  reset(): void { this.closedSession = Math.max(this.closedSession, this.state?.session ?? 0); this.state = null; this.pending = false; this.nextRequest = 0; this.hiddenPanel = false; }
  open(socket: GameSocket, entityId: number, text = ''): void {
    socket.npcAction({ session: 0, revision: 0, request: 0, action: NpcAction.OPEN, target: entityId, text });
  }
  command(socket: GameSocket, action: NpcAction, target = 0, amount = 0, text = '', revision?: number): boolean {
    const s = this.state;
    if (!s || (this.pending && action !== NpcAction.CLOSE && action !== NpcAction.REFRESH) || (revision !== undefined && revision !== s.revision)) return false;
    if (action === NpcAction.CLOSE) this.hiddenPanel = true;
    this.pending = true; this.pendingSince = Date.now();
    socket.npcAction({ session: s.session, revision: s.revision, request: ++this.nextRequest, action, target, amount, text });
    if (action === NpcAction.CLOSE) this.reset();
    return true;
  }
  say(socket: GameSocket, text: string, revision?: number): boolean {
    return this.command(socket, NpcAction.SAY, 0, 0, text, revision);
  }
  close(socket: GameSocket): void { this.command(socket, NpcAction.CLOSE); }
  /** Recover an acknowledgement lost to rate limiting without replaying a purchase. */
  update(socket: GameSocket): void {
    if (this.pending && Date.now() - this.pendingSince > 2500) this.command(socket, NpcAction.REFRESH);
  }
}
