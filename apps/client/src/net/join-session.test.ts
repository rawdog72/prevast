// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetEventBus } from './events';
import {
  JoinSession,
  type JoinConnection,
  type JoinOutcome,
  type JoinSessionOptions,
  type JoinStage,
} from './join-session';
import { DisconnectReason } from './opcodes';

class FakeConnection implements JoinConnection {
  readonly bus = new NetEventBus();
  connected = false;
  closeCount = 0;
  constructor(readonly ticket: string) {}
  connect(): void {
    this.connected = true;
  }
  close(): void {
    this.closeCount++;
  }
  open(): void {
    this.bus.emit('connectionOpened', undefined as unknown as void);
  }
  frame(): void {
    this.bus.emit('connectionActivity', undefined as unknown as void);
  }
  handshake(): void {
    this.bus.emit('handshake', {
      ownGuid: 1,
      unitsPerPlayer: 0,
      playerCount: 0,
      modeId: 0,
      players: [],
    });
  }
  reject(reason: DisconnectReason, detail = ''): void {
    this.bus.emit('disconnectReason', { reason, detail });
  }
  closed(opened: boolean): void {
    this.bus.emit('connectionClosed', { code: 1006, reason: '', opened });
  }
}

function setup(overrides: Partial<JoinSessionOptions<FakeConnection>> = {}) {
  const connections: FakeConnection[] = [];
  const stages: [JoinStage, number][] = [];
  const session = new JoinSession<FakeConnection>({
    ensureContent: async () => {},
    openConnection: (ticket) => {
      const connection = new FakeConnection(ticket);
      connections.push(connection);
      return connection;
    },
    onStage: (stage, info) => stages.push([stage, info.attempt]),
    ...overrides,
  });
  let outcome: JoinOutcome | null = null;
  let connection: FakeConnection | null = null;
  const run = () =>
    session.run().then((result) => {
      outcome = result.outcome;
      connection = result.connection;
    });
  return {
    session,
    connections,
    stages,
    run,
    get outcome(): JoinOutcome | null {
      return outcome;
    },
    get connection(): FakeConnection | null {
      return connection;
    },
  };
}

// Several rounds: a join chains a few awaits (content, ticket, connect) between timers.
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

describe('JoinSession', () => {
  it('stops before opening a connection when the account ticket fails', async () => {
    const t = setup({
      fetchTicket: async () => {
        throw new Error('Sign in again.');
      },
    });
    const result = await t.session.run();
    expect(result.outcome).toEqual({ kind: 'account-failed', detail: 'Sign in again.' });
    expect(result.connection).toBeNull();
  });

  it('never treats an empty ticket response as permission to join as a guest', async () => {
    const t = setup({ fetchTicket: async () => '' });
    expect((await t.session.run()).outcome.kind).toBe('account-failed');
  });
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports stages in order and joins on HANDSHAKE, keeping the connection open', async () => {
    const t = setup();
    void t.run();
    await settle();
    const c = t.connections[0]!;
    expect(c.connected).toBe(true);
    c.open();
    c.bus.emit('loginSent', undefined as unknown as void);
    c.handshake();
    await settle();
    expect(t.outcome).toEqual({ kind: 'joined' });
    expect(t.connection).toBe(c);
    expect(c.closeCount).toBe(0);
    expect(t.stages.map(([s]) => s)).toEqual(['content', 'connecting', 'syncing', 'logging-in']);
  });

  it('fetches a ticket before connecting when asked to', async () => {
    const t = setup({ fetchTicket: async () => 'T1' });
    void t.run();
    await settle();
    expect(t.stages.map(([s]) => s)).toEqual(['content', 'ticket', 'connecting']);
    expect(t.connections[0]!.ticket).toBe('T1');
  });

  it('settles a refusal with its reason and closes the connection', async () => {
    const t = setup();
    void t.run();
    await settle();
    const c = t.connections[0]!;
    c.open();
    c.reject(DisconnectReason.SERVER_FULL);
    await settle();
    expect(t.outcome).toEqual({
      kind: 'rejected',
      reason: DisconnectReason.SERVER_FULL,
      detail: '',
    });
    expect(t.connection).toBeNull();
    expect(c.closeCount).toBe(1);
  });

  it('treats an ALERT before HANDSHAKE as an outdated client', async () => {
    const t = setup();
    void t.run();
    await settle();
    const c = t.connections[0]!;
    c.open();
    c.bus.emit('alert', { text: 'Only clients with protocol 14.10 allowed!' });
    await settle();
    expect(t.outcome).toEqual({
      kind: 'outdated',
      text: 'Only clients with protocol 14.10 allowed!',
    });
  });

  it('tells an unreachable server from a connection dropped while joining', async () => {
    const a = setup();
    void a.run();
    await settle();
    a.connections[0]!.closed(false);
    await settle();
    expect(a.outcome).toEqual({ kind: 'unreachable' });

    const b = setup();
    void b.run();
    await settle();
    b.connections[0]!.open();
    b.connections[0]!.closed(true);
    await settle();
    expect(b.outcome).toEqual({ kind: 'dropped' });
  });

  it('times out after 15 s of silence, re-armed by every frame', async () => {
    const t = setup();
    void t.run();
    await settle();
    const c = t.connections[0]!;
    c.open();
    await vi.advanceTimersByTimeAsync(14_000);
    c.frame();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(t.outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(t.outcome).toEqual({ kind: 'timed-out' });
    expect(c.closeCount).toBe(1);
  });

  it('calls a socket that never opens within 15 s unreachable', async () => {
    const t = setup();
    void t.run();
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(t.outcome).toEqual({ kind: 'unreachable' });
  });

  it('ignores anything that arrives after the outcome', async () => {
    const t = setup();
    void t.run();
    await settle();
    const c = t.connections[0]!;
    c.open();
    c.reject(DisconnectReason.SERVER_CLOSED);
    await settle();
    const stagesBefore = t.stages.length;
    c.closed(true);
    c.handshake();
    c.bus.emit('loginSent', undefined as unknown as void);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.outcome).toEqual({
      kind: 'rejected',
      reason: DisconnectReason.SERVER_CLOSED,
      detail: '',
    });
    expect(t.stages.length).toBe(stagesBefore);
    expect(c.closeCount).toBe(1);
  });

  it('retries a starting-up server after the configured waits, with a fresh ticket each time', async () => {
    let tickets = 0;
    const t = setup({ fetchTicket: async () => `T${++tickets}`, retryDelaysMs: [5_000, 10_000] });
    void t.run();
    await settle();
    t.connections[0]!.reject(DisconnectReason.STARTING_UP);
    await settle();
    expect(t.stages.at(-1)).toEqual(['waiting', 1]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(t.connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(t.connections).toHaveLength(2);
    expect(t.connections[1]!.ticket).toBe('T2');
    t.connections[1]!.reject(DisconnectReason.MAINTENANCE);
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    t.connections[2]!.reject(DisconnectReason.STARTING_UP);
    await settle();
    expect(t.connections).toHaveLength(3);
    expect(t.outcome).toEqual({
      kind: 'rejected',
      reason: DisconnectReason.STARTING_UP,
      detail: '',
    });
  });

  it('never retries a full server on its own', async () => {
    const t = setup();
    void t.run();
    await settle();
    t.connections[0]!.reject(DisconnectReason.SERVER_FULL);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.connections).toHaveLength(1);
    expect(t.outcome).toMatchObject({ kind: 'rejected', reason: DisconnectReason.SERVER_FULL });
  });

  it('cancels while connecting, and while waiting to retry', async () => {
    const a = setup();
    void a.run();
    await settle();
    a.session.cancel();
    await settle();
    expect(a.outcome).toEqual({ kind: 'cancelled' });
    expect(a.connections[0]!.closeCount).toBe(1);

    const b = setup();
    void b.run();
    await settle();
    b.connections[0]!.reject(DisconnectReason.STARTING_UP);
    await settle();
    b.session.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.outcome).toEqual({ kind: 'cancelled' });
    expect(b.connections).toHaveLength(1);
  });

  it('cancels before any connection exists', async () => {
    const t = setup({
      fetchTicket: () => new Promise((resolve) => setTimeout(() => resolve('T'), 100)),
    });
    void t.run();
    await settle();
    t.session.cancel();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(t.outcome).toEqual({ kind: 'cancelled' });
    expect(t.connections).toHaveLength(0);
  });

  it('reports game data that failed to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = setup({
      ensureContent: async () => {
        throw new Error('404');
      },
    });
    void t.run();
    await settle();
    expect(t.outcome).toEqual({ kind: 'content-failed' });
    expect(t.connections).toHaveLength(0);
  });
});
