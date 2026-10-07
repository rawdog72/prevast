// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import type { ContentManifest, ContentPatch, ContentTable } from '../../../../shared/typescript/content-format';
import { MemoryCache } from '../content/cache';
import { ContentStore } from '../content/store';
import { NetEventBus } from './events';
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

  triggerOpen(): void {
    this.onopen?.();
  }

  triggerMessage(data: Uint8Array): void {
    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);
    this.onmessage?.({ data: ab });
  }
}

function makeServerFrame(opcode: ServerOpcode, jsonPayload: unknown): Uint8Array {
  const jsonStr = JSON.stringify(jsonPayload);
  const bytes = new TextEncoder().encode(jsonStr);
  const frame = new Uint8Array(1 + bytes.length);
  frame[0] = opcode;
  frame.set(bytes, 1);
  return frame;
}

import { readFileSync } from 'node:fs';

const mockModesTable: ContentTable = JSON.parse(
  readFileSync('tests/fixtures/content/modes.json', 'utf8'),
) as ContentTable;

const mockItemsTable: ContentTable = JSON.parse(
  readFileSync('tests/fixtures/content/items.json', 'utf8'),
) as ContentTable;

describe('GameSocket Content Sync', () => {
  it('waits for CONTENT_MANIFEST and syncs missing tables before sending login', async () => {
    let mockWs: MockWebSocket | null = null;
    const bus = new NetEventBus();
    const store = new ContentStore();
    const cache = new MemoryCache();

    // Prime cache with modes table
    await cache.put(mockModesTable);

    const socket = new GameSocket({
      url: 'ws://localhost:7172',
      login: { nickname: 'Tester' },
      bus,
      contentStore: store,
      cache,
      contentSyncTimeoutMs: 1000,
      WebSocketClass: class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          mockWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    socket.connect();
    expect(mockWs).not.toBeNull();
    mockWs!.triggerOpen();

    // On open, since contentStore is provided, login is NOT sent yet
    expect(mockWs!.sent.length).toBe(0);

    // Server sends CONTENT_MANIFEST: modes (cached) and items (missing)
    const manifest: ContentManifest = {
      protocol: 1,
      tables: {
        modes: { version: mockModesTable.version, hash: mockModesTable.hash },
        items: { version: mockItemsTable.version, hash: mockItemsTable.hash },
      },
    };

    mockWs!.triggerMessage(makeServerFrame(ServerOpcode.CONTENT_MANIFEST, manifest));

    // Allow async cache check
    await new Promise((resolve) => setTimeout(resolve, 10));

    // modes was in cache, so store should now have modes
    expect(store.has('modes')).toBe(true);

    // items was missing from cache, so socket sent CONTENT_REQUEST for ['items']
    expect(mockWs!.sent.length).toBe(1);
    const reqFrame = mockWs!.sent[0];
    expect(reqFrame[0]).toBe(ClientOpcode.CONTENT_REQUEST);
    // Decode request payload
    const reqJson = new TextDecoder().decode(reqFrame.subarray(3)); // opcode(1) + u16 len(2)
    expect(JSON.parse(reqJson)).toEqual(['items']);

    // Login is still not sent because items is pending
    expect(mockWs!.sent.length).toBe(1);

    // Server sends CONTENT_TABLE for items
    mockWs!.triggerMessage(makeServerFrame(ServerOpcode.CONTENT_TABLE, mockItemsTable));

    // Now all pending tables are resolved: items loaded in store and cache, and login sent!
    expect(store.has('items')).toBe(true);
    const cachedItems = await cache.get('items', mockItemsTable.hash);
    expect(cachedItems).toBeDefined();

    // Login message should now have been sent
    expect(mockWs!.sent.length).toBe(2);
    expect(mockWs!.sent[1][0]).toBe(GAME_PROTOCOL_IDENTIFIER);

    socket.close();
  });

  it('handles live CONTENT_PATCH during gameplay and applies merge patch', async () => {
    let mockWs: MockWebSocket | null = null;
    const bus = new NetEventBus();
    const store = new ContentStore();
    const cache = new MemoryCache();

    // Pre-load items table
    store.load(mockItemsTable);

    const socket = new GameSocket({
      url: 'ws://localhost:7172',
      login: { nickname: 'Tester' },
      bus,
      contentStore: store,
      cache,
      WebSocketClass: class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          mockWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    socket.connect();
    mockWs!.triggerOpen();

    const changeListener = vi.fn();
    store.onChange(changeListener);

    // Server broadcasts CONTENT_PATCH for items (version 1 -> 2)
    const patch: ContentPatch = {
      name: 'items',
      fromVersion: mockItemsTable.version,
      toVersion: mockItemsTable.version + 1,
      hash: 'items_hash_2',
      patch: {
        hatchet: { name: 'Super Hatchet' },
      },
    };

    mockWs!.triggerMessage(makeServerFrame(ServerOpcode.CONTENT_PATCH, patch));

    // Store should have updated version and patched entry
    const updated = store.snapshot('items');
    expect(updated).toBeDefined();
    expect(updated!.version).toBe(mockItemsTable.version + 1);
    expect(updated!.hash).toBe('items_hash_2');
    expect((updated!.entries.hatchet as any).name).toBe('Super Hatchet');
    expect(changeListener).toHaveBeenCalledWith('items', ['hatchet']);

    // Cache should be updated
    const cached = await cache.get('items', 'items_hash_2');
    expect(cached?.version).toBe(mockItemsTable.version + 1);

    socket.close();
  });

  it('requests full table if CONTENT_PATCH is stale', async () => {
    let mockWs: MockWebSocket | null = null;
    const bus = new NetEventBus();
    const store = new ContentStore();
    store.load(mockItemsTable);

    const socket = new GameSocket({
      url: 'ws://localhost:7172',
      login: { nickname: 'Tester' },
      bus,
      contentStore: store,
      WebSocketClass: class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          mockWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    socket.connect();
    mockWs!.triggerOpen();

    // Clear sent buffer
    mockWs!.sent = [];

    // Server sends patch fromVersion 5 -> 6 (client is at version 1)
    const stalePatch: ContentPatch = {
      name: 'items',
      fromVersion: mockItemsTable.version + 4,
      toVersion: mockItemsTable.version + 5,
      hash: 'items_hash_4',
      patch: { hatchet: { name: 'Mega Hatchet' } },
    };

    mockWs!.triggerMessage(makeServerFrame(ServerOpcode.CONTENT_PATCH, stalePatch));

    // GameSocket detects stale patch and requests full table
    expect(mockWs!.sent.length).toBe(1);
    expect(mockWs!.sent[0][0]).toBe(ClientOpcode.CONTENT_REQUEST);
    const reqJson = new TextDecoder().decode(mockWs!.sent[0].subarray(3));
    expect(JSON.parse(reqJson)).toEqual(['items']);

    socket.close();
  });

  it('falls back to sending login if CONTENT_MANIFEST is not received within timeout', async () => {
    vi.useFakeTimers();
    let mockWs: MockWebSocket | null = null;
    const bus = new NetEventBus();
    const store = new ContentStore();

    const socket = new GameSocket({
      url: 'ws://localhost:7172',
      login: { nickname: 'Tester' },
      bus,
      contentStore: store,
      contentSyncTimeoutMs: 200,
      WebSocketClass: class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          mockWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    socket.connect();
    mockWs!.triggerOpen();
    expect(mockWs!.sent.length).toBe(0);

    // Advance time past timeout
    vi.advanceTimersByTime(250);

    // Login message sent via fallback
    expect(mockWs!.sent.length).toBe(1);
    expect(mockWs!.sent[0][0]).toBe(GAME_PROTOCOL_IDENTIFIER);

    socket.close();
    vi.useRealTimers();
  });
});
