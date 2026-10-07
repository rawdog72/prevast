// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import { NetEventBus } from '../events';
import { handleOpenBuilding, handleNewFuelValue } from './interaction';

describe('station fuel snapshots', () => {
  it('decodes unsigned milliseconds in a batched fuel packet', () => {
    const bus = new NetEventBus();
    const fuel = vi.fn();
    bus.on('newFuelValue', fuel);
    const bytes = new Uint8Array(12).subarray(4, 10);
    bytes.set([47, 254, 0, 0, 0, 0]);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(2, 3000000000, true);
    handleNewFuelValue(bytes, bus);
    expect(fuel).toHaveBeenCalledWith({ fuel: 254, fuelMs: 3000000000 });
  });

  it('does not overwrite station state with an incomplete snapshot', () => {
    const bus = new NetEventBus();
    const open = vi.fn();
    const fuel = vi.fn();
    bus.on('openBuilding', open);
    bus.on('newFuelValue', fuel);
    handleOpenBuilding(new Uint8Array(13), bus);
    handleNewFuelValue(new Uint8Array(5), bus);
    expect(open).not.toHaveBeenCalled();
    expect(fuel).not.toHaveBeenCalled();
  });
});
