// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readSetting, writeSetting } from '../core/storage';
import { ChatChannel } from '../net/opcodes';
import type { ChatArrival } from './chat-model';

export type NoticeMode = 'off' | 'mentions' | 'all';
export type NoticeChannel = 'local' | 'global' | 'clan' | 'private' | 'admin';
export const NOTICE_CHANNELS: NoticeChannel[] = ['local', 'global', 'clan', 'private', 'admin'];
export interface ChatSettings {
  width: number;
  height: number;
  fontSize: number;
  font: 'readable' | 'game';
  opacity: number;
  timestamps: boolean;
  stayTyping: boolean;
  bubbles: boolean;
  notifications: Record<NoticeChannel, { mode: NoticeMode; sound: boolean }>;
}

export function defaultChatSettings(): ChatSettings {
  return {
    width: 440,
    height: 260,
    fontSize: 14,
    font: 'readable',
    opacity: 0.94,
    timestamps: true,
    stayTyping: false,
    bubbles: true,
    notifications: {
      local: { mode: 'mentions', sound: true },
      global: { mode: 'mentions', sound: true },
      clan: { mode: 'mentions', sound: true },
      private: { mode: 'all', sound: false },
      admin: { mode: 'all', sound: false },
    },
  };
}

export function parseChatSettings(json: string | null): ChatSettings {
  const settings = defaultChatSettings();
  try {
    const raw = JSON.parse(json ?? 'null');
    if (!raw || typeof raw !== 'object') return settings;
    for (const [key, min, max] of [
      ['width', 300, 900],
      ['height', 180, 600],
      ['fontSize', 12, 18],
      ['opacity', 0.45, 1],
    ] as const) {
      if (typeof raw[key] === 'number' && Number.isFinite(raw[key]))
        settings[key] = Math.max(min, Math.min(max, raw[key]));
    }
    for (const key of ['timestamps', 'stayTyping', 'bubbles'] as const)
      if (typeof raw[key] === 'boolean') settings[key] = raw[key];
    if (raw.font === 'readable' || raw.font === 'game') settings.font = raw.font;
    for (const channel of NOTICE_CHANNELS) {
      const value = raw.notifications?.[channel];
      if (['off', 'mentions', 'all'].includes(value?.mode))
        settings.notifications[channel].mode = value.mode;
      if (typeof value?.sound === 'boolean') settings.notifications[channel].sound = value.sound;
    }
  } catch {
    /* Defaults also cover unavailable or corrupt storage. */
  }
  return settings;
}

export function loadChatSettings(): ChatSettings {
  return parseChatSettings(readSetting('prevast.chat.settings'));
}
export function saveChatSettings(settings: ChatSettings): void {
  writeSetting('prevast.chat.settings', JSON.stringify(settings));
}

export function chatNotification(
  settings: ChatSettings,
  arrival: ChatArrival,
): { show: boolean; sound: boolean } {
  const { tab, line, unseen } = arrival;
  if (!unseen || line.self || line.kind !== 'say') return { show: false, sound: false };
  const channel = (
    {
      [ChatChannel.LOCAL]: 'local',
      [ChatChannel.GLOBAL]: 'global',
      [ChatChannel.CLAN]: 'clan',
      [ChatChannel.PRIVATE]: 'private',
      [ChatChannel.ADMIN]: 'admin',
    } as const
  )[tab.channel as ChatChannel];
  if (!channel) return { show: false, sound: false };
  const preference = settings.notifications[channel];
  const show = preference.mode === 'all' || (preference.mode === 'mentions' && !!line.mention);
  return { show, sound: show && preference.sound };
}
