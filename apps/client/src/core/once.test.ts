// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import { onceUnlessFailed } from './once';

describe('onceUnlessFailed', () => {
  it('runs once and shares the result, in flight and after', async () => {
    const load = vi.fn(async () => 'data');
    const get = onceUnlessFailed(load);
    const [a, b] = await Promise.all([get(), get()]);
    expect(await get()).toBe('data');
    expect([a, b]).toEqual(['data', 'data']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('forgets a failure so the next call tries again', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('data');
    const get = onceUnlessFailed(load);
    await expect(get()).rejects.toThrow('offline');
    await expect(get()).resolves.toBe('data');
    await expect(get()).resolves.toBe('data');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
