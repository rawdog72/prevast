// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, parseOptions, serializeOptions } from './options-settings';

describe('options-settings (Options rows persisted as prevast.options)', () => {
  it('round-trips every persisted row', () => {
    const json = serializeOptions({
      audioMuted: true,
      volumeMaster: 0.7,
      volumeSfx: 0.6,
      volumeMusic: 0.4,
      particlesDisabled: true,
      keyboardLayout: 'azerty',
      leaderboardVisible: false,
      zoomLevel: 1.3,
      noticeY: 80,
      privateMessages: 'clan',
    });
    expect(parseOptions(json)).toEqual({
      audioMuted: true,
      volumeMaster: 0.7,
      volumeSfx: 0.6,
      volumeMusic: 0.4,
      particlesDisabled: true,
      keyboardLayout: 'azerty',
      leaderboardVisible: false,
      zoomLevel: 1.3,
      noticeY: 80,
      privateMessages: 'clan',
    });
  });

  it('falls back to the defaults for a missing, broken or out-of-range value', () => {
    expect(parseOptions(null)).toEqual(DEFAULT_OPTIONS);
    expect(parseOptions('not json')).toEqual(DEFAULT_OPTIONS);
    expect(parseOptions('[1]')).toEqual(DEFAULT_OPTIONS);
    expect(
      parseOptions(
        '{"zoomLevel":9,"keyboardLayout":"dvorak","audioMuted":"yes","leaderboardVisible":false,"privateMessages":"friends"}',
      ),
    ).toEqual({ ...DEFAULT_OPTIONS, leaderboardVisible: false });
  });
});
