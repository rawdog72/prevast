// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { ChatChannel } from '../net/opcodes';
import type { ChatArrival } from './chat-model';
import { chatNotification, defaultChatSettings, parseChatSettings } from './chat-settings';

describe('chat preferences', () => {
  it('restores defaults safely and bounds saved dimensions', () => {
    expect(parseChatSettings('{bad')).toEqual(defaultChatSettings());
    expect(
      parseChatSettings(
        JSON.stringify({
          width: 99999,
          height: -10,
          fontSize: 'large',
          bubbles: false,
          notifications: { clan: { mode: 'all', sound: false } },
        }),
      ),
    ).toMatchObject({
      width: 900,
      height: 180,
      fontSize: 14,
      bubbles: false,
      notifications: { clan: { mode: 'all', sound: false } },
    });
  });
  it('respects each channel mode and sound choice, without alerting on read messages or self echoes', () => {
    const settings = defaultChatSettings();
    const arrival: ChatArrival = {
      unseen: true,
      tab: {
        id: 'clan',
        label: 'Clan',
        channel: ChatChannel.CLAN,
        closable: false,
        lines: [],
        unread: 1,
      },
      line: {
        id: 1,
        kind: 'say',
        pid: 2,
        name: 'Bob',
        text: 'hello',
        time: 0,
        self: false,
        admin: false,
      },
    };
    expect(chatNotification(settings, arrival)).toEqual({ show: false, sound: false });
    arrival.line.mention = true;
    expect(chatNotification(settings, arrival)).toEqual({ show: true, sound: true });
    settings.notifications.clan.mode = 'off';
    expect(chatNotification(settings, arrival)).toEqual({ show: false, sound: false });
    settings.notifications.clan = { mode: 'all', sound: false };
    expect(chatNotification(settings, arrival)).toEqual({ show: true, sound: false });
    arrival.unseen = false;
    expect(chatNotification(settings, arrival).show).toBe(false);
    arrival.unseen = true;
    arrival.line.self = true;
    expect(chatNotification(settings, arrival).show).toBe(false);
  });
});
