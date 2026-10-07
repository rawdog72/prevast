// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import {
  defaultChatSettings,
  NOTICE_CHANNELS,
  type ChatSettings,
  type NoticeMode,
} from '../../chat/chat-settings';

export function chatSettingsPanel(settings: ChatSettings, change: () => void): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'hud-chat-settings';
  panel.setAttribute('aria-label', 'Chat settings');
  const heading = document.createElement('strong');
  heading.textContent = 'Chat settings';
  panel.append(heading);
  const row = (name: string, control: HTMLElement) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'hud-chat-setting';
    const label = document.createElement('span');
    label.textContent = name;
    wrapper.append(label, control);
    panel.append(wrapper);
  };
  for (const [key, label, min, max, step] of [
    ['width', 'Width', 300, 900, 10],
    ['height', 'Height', 180, 600, 10],
    ['fontSize', 'Text size', 12, 18, 1],
    ['opacity', 'Background opacity', 0.45, 1, 0.05],
  ] as const) {
    const group = document.createElement('span');
    group.className = 'hud-chat-setting-range';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(settings[key]);
    input.setAttribute('aria-label', label);
    const output = document.createElement('output');
    const show = () => {
      output.value =
        key === 'opacity' ? `${Math.round(settings[key] * 100)}%` : `${settings[key]}px`;
    };
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      show();
      change();
    });
    show();
    group.append(input, output);
    row(label, group);
  }
  const font = document.createElement('select');
  font.setAttribute('aria-label', 'Message font');
  for (const [value, label] of [
    ['readable', 'Readable'],
    ['game', 'Game font'],
  ]) {
    const option = document.createElement('option');
    option.value = value!;
    option.textContent = label!;
    font.append(option);
  }
  font.value = settings.font;
  font.addEventListener('change', () => {
    settings.font = font.value as ChatSettings['font'];
    change();
  });
  row('Message font', font);
  for (const [key, label] of [
    ['timestamps', 'Show timestamps'],
    ['stayTyping', 'Stay typing after sending'],
    ['bubbles', 'Show local speech bubbles'],
  ] as const) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = settings[key];
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      change();
    });
    row(label, input);
  }
  const noticeHeading = document.createElement('strong');
  noticeHeading.textContent = 'Notifications when unread';
  panel.append(noticeHeading);
  for (const channel of NOTICE_CHANNELS) {
    const group = document.createElement('span');
    group.className = 'hud-chat-setting-notice';
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${channel} notifications`);
    for (const [value, label] of [
      ['off', 'Off'],
      ['mentions', 'Mentions'],
      ['all', 'All messages'],
    ]) {
      const option = document.createElement('option');
      option.value = value!;
      option.textContent = label!;
      select.append(option);
    }
    select.value = settings.notifications[channel].mode;
    select.addEventListener('change', () => {
      settings.notifications[channel].mode = select.value as NoticeMode;
      change();
    });
    const soundLabel = document.createElement('label');
    soundLabel.className = 'hud-chat-sound';
    const sound = document.createElement('input');
    sound.type = 'checkbox';
    sound.checked = settings.notifications[channel].sound;
    sound.setAttribute('aria-label', `${channel} notification sound`);
    sound.addEventListener('change', () => {
      settings.notifications[channel].sound = sound.checked;
      change();
    });
    soundLabel.append(sound, 'Sound');
    group.append(select, soundLabel);
    row(
      channel === 'private' ? 'Private messages' : channel[0]!.toUpperCase() + channel.slice(1),
      group,
    );
  }
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Reset chat settings';
  reset.addEventListener('click', () => {
    Object.assign(settings, defaultChatSettings());
    change();
    panel.replaceWith(chatSettingsPanel(settings, change));
  });
  panel.append(reset);
  return panel;
}
