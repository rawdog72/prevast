// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { passwordStrength, STRENGTH_LABELS } from './account-form';

describe('passwordStrength', () => {
  it('rates below the minimum as too short', () => {
    expect(STRENGTH_LABELS[passwordStrength('Ab1!')]).toBe('Too short');
  });
  it('grows with length and variety', () => {
    expect(passwordStrength('aaaaaaaa')).toBe(1);
    expect(passwordStrength('abcd1234')).toBe(1);
    expect(passwordStrength('Abcd1234')).toBe(2);
    expect(passwordStrength('Abcd1234efgh')).toBe(3);
    expect(passwordStrength('Abcd1234efgh!xyz')).toBe(4);
    expect(passwordStrength('correct horse battery staple')).toBe(3);
  });
});
