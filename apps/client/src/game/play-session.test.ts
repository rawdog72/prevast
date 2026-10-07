// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetEventBus } from '../net/events';
import { DisconnectReason } from '../net/opcodes';
import type { DisconnectAction, DisconnectView, FailureNotice } from '../ui/home/join-messages';
import { PlaySession, type PlayConnection, type PlaySessionOptions } from './play-session';

class FakeConnection implements PlayConnection {
  readonly bus = new NetEventBus();
  readonly game = { start: vi.fn(), stop: vi.fn() };
  connect = vi.fn();
  close = vi.fn(() => this.game.stop());
  open(): void {
    this.bus.emit('connectionOpened', undefined as unknown as void);
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
  drop(): void {
    this.bus.emit('connectionClosed', { code: 1006, reason: '', opened: true });
  }
  unreachable(): void {
    this.bus.emit('connectionClosed', { code: 1006, reason: '', opened: false });
  }
}

function setup(overrides: Partial<PlaySessionOptions<FakeConnection>> = {}) {
  const connections: FakeConnection[] = [];
  const progress: string[] = [];
  const failures: FailureNotice[] = [];
  const views: DisconnectView[] = [];
  let act: (a: DisconnectAction) => void = () => {};
  const screen = {
    show: vi.fn(),
    hide: vi.fn(),
    setProgress: (text: string) => progress.push(text),
    showFailure: (n: FailureNotice) => failures.push(n),
    endJoin: vi.fn(),
  };
  const dialog = {
    open: vi.fn(),
    render: (view: DisconnectView, onAction: (a: DisconnectAction) => void) => {
      views.push(view);
      act = onAction;
    },
    close: vi.fn(),
  };
  const session = new PlaySession<FakeConnection>({
    serverName: 'EU-1',
    maxPlayers: 40,
    screen,
    dialog,
    captureFrame: () => 'data:frame',
    ensureContent: async () => {},
    openConnection: () => {
      const c = new FakeConnection();
      connections.push(c);
      return c;
    },
    reconnectDelaysMs: [0, 2_000, 5_000],
    ...overrides,
  });
  return {
    session,
    connections,
    progress,
    failures,
    views,
    screen,
    dialog,
    click: (a: DisconnectAction) => act(a),
    last: () => connections[connections.length - 1]!,
  };
}

// Several rounds: a join chains a few awaits (content, ticket, connect) between timers.
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

async function joined(t: ReturnType<typeof setup>): Promise<FakeConnection> {
  void t.session.start();
  await settle();
  const c = t.last();
  c.open();
  c.handshake();
  await settle();
  return c;
}

describe('PlaySession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the game only on HANDSHAKE, with progress on the start screen until then', async () => {
    const t = setup();
    void t.session.start();
    await settle();
    const c = t.last();
    c.open();
    expect(t.screen.hide).not.toHaveBeenCalled();
    expect(c.game.start).not.toHaveBeenCalled();
    expect(t.progress).toEqual(['Loading game data…', 'Connecting to EU-1…', 'Syncing content…']);
    c.handshake();
    await settle();
    expect(t.screen.hide).toHaveBeenCalledTimes(1);
    expect(c.game.start).toHaveBeenCalledTimes(1);
  });

  it('keeps the start screen and explains a refusal', async () => {
    const t = setup();
    void t.session.start();
    await settle();
    t.last().reject(DisconnectReason.SERVER_FULL);
    await settle();
    expect(t.screen.hide).not.toHaveBeenCalled();
    expect(t.failures[0]).toMatchObject({
      title: 'Server is full',
      actions: ['retry', 'choose-server'],
    });
  });

  it('counts down on the start screen while waiting to retry', async () => {
    const t = setup({ joinRetryDelaysMs: [5_000] });
    void t.session.start();
    await settle();
    t.last().reject(DisconnectReason.STARTING_UP);
    await settle();
    expect(t.progress.at(-1)).toBe('EU-1 is starting up — retrying in 5s (attempt 2/2)');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.progress.at(-1)).toBe('EU-1 is starting up — retrying in 4s (attempt 2/2)');
  });

  it('ends a cancelled join quietly', async () => {
    const t = setup();
    void t.session.start();
    await settle();
    t.session.cancel();
    await settle();
    expect(t.screen.endJoin).toHaveBeenCalledTimes(1);
    expect(t.failures).toEqual([]);
  });

  it('reconnects on its own after a plain drop and swaps in the new game', async () => {
    const t = setup();
    const first = await joined(t);
    first.drop();
    await settle();
    expect(first.game.stop).toHaveBeenCalled();
    expect(t.dialog.open).toHaveBeenCalledWith('data:frame');
    expect(t.views.at(-1)).toMatchObject({ message: 'Reconnecting… (attempt 1/3)', busy: true });
    const second = t.last();
    expect(second).not.toBe(first);
    second.open();
    second.handshake();
    await settle();
    expect(t.dialog.close).toHaveBeenCalled();
    expect(second.game.start).toHaveBeenCalledTimes(1);
  });

  it('gives up after three failed attempts and offers Reconnect', async () => {
    const t = setup();
    (await joined(t)).drop();
    await settle();
    t.last().unreachable();
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(t.views.at(-1)!.message).toBe('Reconnecting… (attempt 2/3)');
    t.last().unreachable();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    t.last().unreachable();
    await settle();
    expect(t.connections).toHaveLength(4);
    expect(t.views.at(-1)).toMatchObject({
      title: 'Connection lost',
      actions: ['reconnect', 'main-menu'],
    });
    t.click('reconnect');
    await settle();
    expect(t.connections).toHaveLength(5);
  });

  it('stops reconnecting when the server refuses with a reason, and treats restarts as another try', async () => {
    const t = setup();
    (await joined(t)).drop();
    await settle();
    t.last().reject(DisconnectReason.STARTING_UP);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(t.connections).toHaveLength(3);
    t.last().reject(DisconnectReason.SERVER_CLOSED);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.connections).toHaveLength(3);
    expect(t.views.at(-1)).toMatchObject({ title: 'Server is closed', actions: ['main-menu'] });
  });

  it('shows the reason for a kick and does not reconnect by itself', async () => {
    const t = setup();
    const c = await joined(t);
    c.reject(DisconnectReason.KICKED);
    c.drop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.connections).toHaveLength(1);
    expect(t.views.at(-1)).toMatchObject({
      title: 'You were kicked',
      actions: ['reconnect', 'main-menu'],
    });
  });

  it('treats a stolen session as a reason, not a drop', async () => {
    const t = setup();
    const c = await joined(t);
    c.bus.emit('stoleYourSession', undefined as unknown as void);
    c.drop();
    await settle();
    expect(t.connections).toHaveLength(1);
    expect(t.views.at(-1)!.actions).toEqual(['reconnect-here', 'main-menu']);
  });

  it('leaves a death to the death window', async () => {
    const t = setup();
    const c = await joined(t);
    c.bus.emit('playerDie', { kills: 0 } as never);
    c.drop();
    await settle();
    expect(t.dialog.open).not.toHaveBeenCalled();
    expect(c.game.stop).not.toHaveBeenCalled();
  });

  it('waits for the network before spending an attempt', async () => {
    let online = false;
    let wake: () => void = () => {};
    const t = setup({
      isOnline: () => online,
      waitForOnline: () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
    });
    (await joined(t)).drop();
    await settle();
    expect(t.views.at(-1)!.message).toBe('Waiting for your network to come back…');
    expect(t.connections).toHaveLength(1);
    online = true;
    wake();
    await settle();
    expect(t.connections).toHaveLength(2);
  });

  it('Main menu stops everything and shows the start screen without an error', async () => {
    const t = setup();
    (await joined(t)).drop();
    await settle();
    t.click('main-menu');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.connections).toHaveLength(2);
    expect(t.connections[1]!.close).toHaveBeenCalled();
    expect(t.dialog.close).toHaveBeenCalled();
    expect(t.screen.show).toHaveBeenCalled();
    expect(t.failures).toEqual([]);
  });

  it('Play again joins afresh, and a refusal lands on the start screen', async () => {
    const t = setup();
    const c = await joined(t);
    void t.session.playAgain();
    await settle();
    expect(c.game.stop).toHaveBeenCalled();
    expect(t.views.at(-1)!.title).toBe('Joining EU-1…');
    t.last().reject(DisconnectReason.SERVER_FULL);
    await settle();
    expect(t.dialog.close).toHaveBeenCalled();
    expect(t.screen.show).toHaveBeenCalled();
    expect(t.failures.at(-1)!.title).toBe('Server is full');
  });
});
