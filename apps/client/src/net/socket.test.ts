// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BinaryWriter } from './binary-stream';
import { NetEventBus, type NetEventMap } from './events';
import { ClientOpcode, GAME_PROTOCOL_IDENTIFIER, ServerOpcode } from './opcodes';
import { GameSocket } from './socket';

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  binaryType = 'blob';
  sent: Uint8Array[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | Uint8Array }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  constructor(public url: string) {}

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: 'Normal closure' });
  }

  // Test trigger helpers
  triggerOpen(): void {
    this.onopen?.();
  }

  triggerMessage(data: Uint8Array): void {
    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);
    this.onmessage?.({ data: ab });
  }
}

describe('GameSocket', () => {
  it('connects, sends login frame on open, and starts keepalive', () => {
    let mockWs: MockWebSocket | null = null;
    const bus = new NetEventBus();

    const socket = new GameSocket({
      url: 'ws://localhost:7172',
      login: { nickname: 'Tester' },
      bus,
      pingIntervalMs: 1000,
      WebSocketClass: class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          mockWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    socket.connect();
    expect(mockWs).toBeDefined();
    expect(mockWs!.binaryType).toBe('arraybuffer');

    // Trigger open
    mockWs!.triggerOpen();
    expect(mockWs!.sent.length).toBe(1);
    expect(mockWs!.sent[0]![0]).toBe(GAME_PROTOCOL_IDENTIFIER);

    // Send actions
    socket.move(1);
    expect(mockWs!.sent[1]).toEqual(new Uint8Array([ClientOpcode.MOVE, 1]));
    socket.addFuel(23);
    expect(mockWs!.sent[2]).toEqual(new Uint8Array([ClientOpcode.ADD_FUEL, 23]));

    socket.close();
  });

  it('receives frames, unwraps batches, and dispatches events to the bus', () => {
    let mockWs: MockWebSocket | null = null;
    const bus = new NetEventBus();
    const mapListener = vi.fn();
    bus.on('mapSize', mapListener);

    const socket = new GameSocket({
      url: 'ws://localhost:7172',
      login: { nickname: 'Tester' },
      bus,
      WebSocketClass: class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          mockWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    socket.connect();
    mockWs!.triggerOpen();

    // Trigger a single MAP_SIZE message: [74][0][150, 0][150, 0]
    const mapMsg = new Uint8Array([ServerOpcode.MAP_SIZE, 0, 150, 0, 150, 0]);
    mockWs!.triggerMessage(mapMsg);

    expect(mapListener).toHaveBeenCalledWith({ width: 150, height: 150 });
    socket.close();
  });

  it('times the keepalive: the PONG answering a PING sets stats.rttMs', () => {
    vi.useFakeTimers();
    let mockWs: MockWebSocket | null = null;
    const bus = new NetEventBus();
    const socket = new GameSocket({
      url: 'ws://localhost:7172',
      login: { nickname: 'Tester' },
      bus,
      pingIntervalMs: 1000,
      WebSocketClass: class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          mockWs = this;
        }
      } as unknown as typeof WebSocket,
    });
    socket.connect();
    mockWs!.triggerOpen();
    expect(socket.stats.rttMs).toBe(-1);

    vi.advanceTimersByTime(1000);
    expect(mockWs!.sent.at(-1)).toEqual(new Uint8Array([ClientOpcode.PING_MESSAGE]));
    vi.advanceTimersByTime(37);
    mockWs!.triggerMessage(new Uint8Array([ServerOpcode.PONG]));
    expect(socket.stats.rttMs).toBeCloseTo(37, 0);

    // A pong with no ping in flight (batched twice, say) changes nothing.
    vi.advanceTimersByTime(500);
    mockWs!.triggerMessage(new Uint8Array([ServerOpcode.PONG]));
    expect(socket.stats.rttMs).toBeCloseTo(37, 0);
    socket.close();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function capture() {
    let ws: MockWebSocket | null = null;
    const WebSocketClass = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        ws = this;
      }
    } as unknown as typeof WebSocket;
    return {
      WebSocketClass,
      get ws(): MockWebSocket {
        return ws!;
      },
    };
  }

  it('keeps dispatching the rest of a batch when one message fails', () => {
    // A bus whose ALERT delivery throws stands in for any decoder bug.
    class ThrowingBus extends NetEventBus {
      override emit<K extends keyof NetEventMap>(event: K, data: NetEventMap[K]): void {
        if (event === 'alert') throw new Error('decoder bug');
        super.emit(event, data);
      }
    }
    const bus = new ThrowingBus();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mapSize = vi.fn();
    bus.on('mapSize', mapSize);
    const mock = capture();
    const socket = new GameSocket({
      url: 'ws://x',
      login: { nickname: 'T' },
      bus,
      WebSocketClass: mock.WebSocketClass,
    });
    socket.connect();
    mock.ws.triggerOpen();
    const alert = new BinaryWriter().u8(ServerOpcode.ALERT).str('x').build();
    const size = new BinaryWriter().u8(ServerOpcode.MAP_SIZE).u8(0).u16(150).u16(150).build();
    const batch = new BinaryWriter()
      .u8(ServerOpcode.BATCH)
      .u8(0)
      .u16(alert.length)
      .bytes(alert)
      .u16(size.length)
      .bytes(size)
      .build();
    expect(() => mock.ws.triggerMessage(batch)).not.toThrow();
    expect(mapSize).toHaveBeenCalledWith({ width: 150, height: 150 });
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
    socket.close();
  });

  it('emits connectionOpened, loginSent and connectionActivity on the bus', () => {
    const bus = new NetEventBus();
    const events: string[] = [];
    bus.on('connectionOpened', () => events.push('opened'));
    bus.on('loginSent', () => events.push('login'));
    bus.on('connectionActivity', () => events.push('frame'));
    const mock = capture();
    const socket = new GameSocket({
      url: 'ws://x',
      login: { nickname: 'T' },
      bus,
      WebSocketClass: mock.WebSocketClass,
    });
    socket.connect();
    mock.ws.triggerOpen();
    mock.ws.triggerMessage(new Uint8Array([ServerOpcode.PONG]));
    expect(events).toEqual(['opened', 'login', 'frame']);
    socket.close();
  });

  it('reports whether the socket had opened when it closes', () => {
    const bus = new NetEventBus();
    const closed = vi.fn();
    bus.on('connectionClosed', closed);
    const mock = capture();
    const socket = new GameSocket({
      url: 'ws://x',
      login: { nickname: 'T' },
      bus,
      WebSocketClass: mock.WebSocketClass,
    });
    socket.connect();
    mock.ws.onclose?.({ code: 1006, reason: '' });
    expect(closed).toHaveBeenLastCalledWith({ code: 1006, reason: '', opened: false });

    socket.connect();
    mock.ws.triggerOpen();
    mock.ws.onclose?.({ code: 1006, reason: '' });
    expect(closed).toHaveBeenLastCalledWith({ code: 1006, reason: '', opened: true });
  });

  it('does not emit connectionClosed for its own close()', () => {
    const bus = new NetEventBus();
    const closed = vi.fn();
    bus.on('connectionClosed', closed);
    const mock = capture();
    const socket = new GameSocket({
      url: 'ws://x',
      login: { nickname: 'T' },
      bus,
      WebSocketClass: mock.WebSocketClass,
    });
    socket.connect();
    mock.ws.triggerOpen();
    socket.close();
    expect(closed).not.toHaveBeenCalled();
  });

  it('emits connectionClosed with code 4000 when the watchdog gives up', () => {
    vi.useFakeTimers();
    const bus = new NetEventBus();
    const closed = vi.fn();
    bus.on('connectionClosed', closed);
    const mock = capture();
    const socket = new GameSocket({
      url: 'ws://x',
      login: { nickname: 'T' },
      bus,
      WebSocketClass: mock.WebSocketClass,
      watchdogTimeoutMs: 100,
    });
    socket.connect();
    mock.ws.triggerOpen();
    vi.advanceTimersByTime(150);
    expect(closed).toHaveBeenCalledWith({ code: 4000, reason: 'Watchdog timeout', opened: true });
  });
});
