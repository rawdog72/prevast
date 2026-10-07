// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import { NetEventBus } from './events';

describe('NetEventBus', () => {
  it('subscribes, emits, and unsubscribes properly', () => {
    const bus = new NetEventBus();
    const chatListener = vi.fn();
    const unsub = bus.on('chat', chatListener);

    bus.emit('chat', { channel: 0, pid: 1, peer: 0, flags: 0, text: 'hello' });
    expect(chatListener).toHaveBeenCalledTimes(1);
    expect(chatListener).toHaveBeenCalledWith({ channel: 0, pid: 1, peer: 0, flags: 0, text: 'hello' });

    unsub();
    bus.emit('chat', { channel: 0, pid: 2, peer: 0, flags: 0, text: 'world' });
    expect(chatListener).toHaveBeenCalledTimes(1);
  });

  it('supports multiple listeners per event', () => {
    const bus = new NetEventBus();
    const l1 = vi.fn();
    const l2 = vi.fn();

    bus.on('mapSize', l1);
    bus.on('mapSize', l2);

    bus.emit('mapSize', { width: 150, height: 150 });
    expect(l1).toHaveBeenCalledWith({ width: 150, height: 150 });
    expect(l2).toHaveBeenCalledWith({ width: 150, height: 150 });
  });

  it('clears all listeners', () => {
    const bus = new NetEventBus();
    const l1 = vi.fn();
    bus.on('alert', l1);
    bus.clear();
    bus.emit('alert', { text: 'test' });
    expect(l1).not.toHaveBeenCalled();
  });

  it('keeps delivering to the other listeners when one throws, and logs it once per event', () => {
    const bus = new NetEventBus();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    bus.on('alert', () => {
      throw new Error('broken listener');
    });
    bus.on('alert', after);
    expect(() => bus.emit('alert', { text: 'a' })).not.toThrow();
    bus.emit('alert', { text: 'b' });
    expect(after).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain("'alert'");
    error.mockRestore();
  });
});
