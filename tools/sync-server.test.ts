// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncServer } from './sync-server';

describe('syncServer', () => {
  it('synchronizes dist/client/client.js to configured destinations', () => {
    const distJs = resolve('dist/client/client.js');
    expect(existsSync(distJs)).toBe(true);

    const output = mkdtempSync(join(tmpdir(), 'prevast-sync-test-'));
    try {
    const result = syncServer({ destinations: [{ label: 'Temporary test output', targetJs: join(output, 'client.js') }] });
    expect(result.success).toBe(true);
    expect(result.copied.length).toBeGreaterThan(0);

    for (const file of result.copied) {
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(0);
    }
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
});
