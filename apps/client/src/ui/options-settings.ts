// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/options-settings.ts
// The Options rows that survive a reload: sound, particles, keyboard layout,
// leaderboard, the zoom level and who may message us privately (sent to the
// server at login and on change), kept as one JSON object in localStorage
// (`prevast.options`). Stats has its own key from before and the interface
// sizes live in `prevast.ui-scale` (ui-scale.ts). Anything missing, of the
// wrong type or out of range falls back to its default, so a stale or
// hand-edited value can never wedge the HUD.

export type KeyboardLayout = 'qwerty' | 'azerty';
/** Who may send us a private message; the server enforces it (staff always may). */
export type PrivateMessages = 'everyone' | 'clan' | 'nobody';
export const PRIVATE_MESSAGES: readonly PrivateMessages[] = ['everyone', 'clan', 'nobody'];

export interface OptionsSettings {
  audioMuted: boolean;
  volumeMaster: number;
  volumeSfx: number;
  volumeMusic: number;
  particlesDisabled: boolean;
  keyboardLayout: KeyboardLayout;
  leaderboardVisible: boolean;
  zoomLevel: number;
  noticeY: number;
  privateMessages: PrivateMessages;
}

/** The zoom the mouse wheel / Options step through (game-loop.ts ZOOM_MIN..ZOOM_MAX). */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;

export const DEFAULT_OPTIONS: Readonly<OptionsSettings> = Object.freeze({
  audioMuted: false,
  volumeMaster: 1.0,
  volumeSfx: 0.8,
  volumeMusic: 0.5,
  particlesDisabled: false,
  keyboardLayout: 'qwerty',
  leaderboardVisible: true,
  zoomLevel: 1,
  noticeY: 80,
  privateMessages: 'everyone',
});

export function serializeOptions(settings: OptionsSettings): string {
  return JSON.stringify({
    audioMuted: settings.audioMuted,
    volumeMaster: settings.volumeMaster,
    volumeSfx: settings.volumeSfx,
    volumeMusic: settings.volumeMusic,
    particlesDisabled: settings.particlesDisabled,
    keyboardLayout: settings.keyboardLayout,
    leaderboardVisible: settings.leaderboardVisible,
    zoomLevel: settings.zoomLevel,
    noticeY: settings.noticeY,
    privateMessages: settings.privateMessages,
  });
}

export function parseOptions(json: string | null): OptionsSettings {
  const out: OptionsSettings = { ...DEFAULT_OPTIONS };
  if (!json) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return out;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.audioMuted === 'boolean') out.audioMuted = r.audioMuted;
  if (typeof r.volumeMaster === 'number' && r.volumeMaster >= 0 && r.volumeMaster <= 1)
    out.volumeMaster = r.volumeMaster;
  if (typeof r.volumeSfx === 'number' && r.volumeSfx >= 0 && r.volumeSfx <= 1)
    out.volumeSfx = r.volumeSfx;
  if (typeof r.volumeMusic === 'number' && r.volumeMusic >= 0 && r.volumeMusic <= 1)
    out.volumeMusic = r.volumeMusic;
  if (typeof r.particlesDisabled === 'boolean') out.particlesDisabled = r.particlesDisabled;
  if (r.keyboardLayout === 'qwerty' || r.keyboardLayout === 'azerty')
    out.keyboardLayout = r.keyboardLayout;
  if (typeof r.leaderboardVisible === 'boolean') out.leaderboardVisible = r.leaderboardVisible;
  if (typeof r.zoomLevel === 'number' && r.zoomLevel >= ZOOM_MIN && r.zoomLevel <= ZOOM_MAX)
    out.zoomLevel = r.zoomLevel;
  if (typeof r.noticeY === 'number' && r.noticeY >= 0 && r.noticeY <= 1000) out.noticeY = r.noticeY;
  if (PRIVATE_MESSAGES.includes(r.privateMessages as PrivateMessages))
    out.privateMessages = r.privateMessages as PrivateMessages;
  return out;
}
