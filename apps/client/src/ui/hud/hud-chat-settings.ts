// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-chat-settings.ts
// Options > Chat: the chat console's preferences as Options rows (a label on
// the left, the choices as buttons on the right with the current one lit),
// grouped under Appearance, Behaviour and Notifications. The console's gear
// opens Options on this tab. The console's width and height are set by
// dragging its corner (hud-chat.ts saves them); this pane only resets them.

import {
  defaultChatSettings,
  NOTICE_CHANNELS,
  type ChatSettings,
  type NoticeChannel,
  type NoticeMode,
} from '../../chat/chat-settings';
import { icon } from '../dom/icons';

export interface ChatSettingsHooks {
  /** The settings object changed: persist and re-apply it. */
  change(): void;
  /** Put the console back to its default width and height. */
  resetSize?(): void;
}

const NOTICE_LABELS: Record<NoticeChannel, string> = {
  local: 'Local',
  global: 'Global',
  clan: 'Clan',
  private: 'Private',
  admin: 'Admin',
};

const NOTICE_MODES: [NoticeMode, string][] = [
  ['off', 'Off'],
  ['mentions', 'Mentions'],
  ['all', 'All'],
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function btn(text: string, className = 'dv-btn'): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  return b;
}

export function chatSettingsPanel(
  settings: ChatSettings,
  hooks: ChatSettingsHooks | (() => void),
): HTMLElement {
  const { change, resetSize } = typeof hooks === 'function' ? { change: hooks } : hooks;
  const panel = el('div', 'dv-settings hud-chat-settings');
  panel.setAttribute('aria-label', 'Chat settings');

  const heading = (title: string, first = false): HTMLElement => {
    const head = el('div', `dv-settings-head${first ? ' is-first' : ''}`);
    head.append(el('span', 'dv-settings-head-title', title));
    panel.append(head);
    return head;
  };
  const row = (label: string, extra = ''): HTMLElement => {
    const rowEl = el('div', `dv-settings-row is-chat${extra}`);
    rowEl.append(el('div', 'dv-settings-label', label));
    const choices = el('div', 'dv-settings-choices');
    rowEl.append(choices);
    panel.append(rowEl);
    return choices;
  };
  /** A row of mutually exclusive buttons; `get` reads the lit one, `set` stores a pick. */
  const choice = <T>(label: string, options: [T, string][], get: () => T, set: (v: T) => void) => {
    const choices = row(label);
    const buttons = options.map(([value, text]) => {
      const b = btn(text);
      b.setAttribute('aria-label', `${label}: ${text}`);
      b.addEventListener('click', () => {
        if (get() === value) return;
        set(value);
        light();
        change();
      });
      choices.append(b);
      return b;
    });
    const light = () =>
      buttons.forEach((b, i) => {
        const on = options[i]![0] === get();
        b.classList.toggle('is-primary', on);
        b.setAttribute('aria-pressed', String(on));
      });
    light();
  };
  const slider = (
    label: string,
    min: number,
    max: number,
    step: number,
    get: () => number,
    set: (v: number) => void,
    show: (v: number) => string,
  ) => {
    const choices = row(label);
    const range = el('input', 'dv-range');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(get());
    range.setAttribute('aria-label', label);
    const value = el('output', 'dv-settings-value hud-chat-settings-value', show(get()));
    range.addEventListener('input', () => {
      set(Number(range.value));
      value.textContent = show(get());
      change();
    });
    choices.append(range, value);
  };

  heading('Appearance', true);
  slider(
    'Text size',
    12,
    18,
    1,
    () => settings.fontSize,
    (v) => (settings.fontSize = v),
    (v) => `${v}px`,
  );
  choice<ChatSettings['font']>(
    'Message font',
    [
      ['readable', 'Readable'],
      ['game', 'Game'],
    ],
    () => settings.font,
    (v) => (settings.font = v),
  );
  // Stored as 0.45..1; the slider works in whole percent so steps stay round.
  slider(
    'Background',
    45,
    100,
    5,
    () => Math.round(settings.opacity * 100),
    (v) => (settings.opacity = v / 100),
    (v) => `${v}%`,
  );
  choice(
    'Timestamps',
    [
      [true, 'Show'],
      [false, 'Hide'],
    ],
    () => settings.timestamps,
    (v) => (settings.timestamps = v),
  );
  choice(
    'When not in use',
    [
      [true, 'Fade'],
      [false, 'Stay'],
    ],
    () => settings.idleFade,
    (v) => (settings.idleFade = v),
  );
  const size = row('Size');
  const resetSizeBtn = btn('Reset size');
  resetSizeBtn.addEventListener('click', () => {
    const defaults = defaultChatSettings();
    settings.width = defaults.width;
    settings.height = defaults.height;
    resetSize?.();
    change();
  });
  size.append(resetSizeBtn);
  panel.append(
    el(
      'p',
      'dv-muted dv-settings-note is-tight',
      'Drag the corner of the chat to resize it. Options › Interface scales the whole chat.',
    ),
  );

  heading('Behaviour');
  choice(
    'After sending',
    [
      [false, 'Close'],
      [true, 'Keep typing'],
    ],
    () => settings.stayTyping,
    (v) => (settings.stayTyping = v),
  );
  choice(
    'Speech bubbles',
    [
      [true, 'Show'],
      [false, 'Hide'],
    ],
    () => settings.bubbles,
    (v) => (settings.bubbles = v),
  );

  heading('Pop-ups for unread messages');
  for (const channel of NOTICE_CHANNELS) {
    const choices = row(NOTICE_LABELS[channel], ' is-chat-notice');
    const pref = settings.notifications[channel];
    const modes = NOTICE_MODES.map(([mode, text]) => {
      const b = btn(text);
      b.setAttribute('aria-label', `${NOTICE_LABELS[channel]} pop-ups: ${text}`);
      b.addEventListener('click', () => {
        if (pref.mode === mode) return;
        pref.mode = mode;
        light();
        change();
      });
      choices.append(b);
      return b;
    });
    const sound = btn('', 'dv-btn is-icon hud-chat-settings-sound');
    sound.addEventListener('click', () => {
      pref.sound = !pref.sound;
      light();
      change();
    });
    choices.append(sound);
    const light = () => {
      modes.forEach((b, i) => {
        const on = NOTICE_MODES[i]![0] === pref.mode;
        b.classList.toggle('is-primary', on);
        b.setAttribute('aria-pressed', String(on));
      });
      sound.innerHTML = icon(pref.sound ? 'sound_on' : 'sound_off');
      sound.classList.toggle('is-off', !pref.sound);
      sound.setAttribute('aria-pressed', String(pref.sound));
      sound.setAttribute('aria-label', `${NOTICE_LABELS[channel]} pop-up sound`);
      sound.title = pref.sound ? 'Sound on' : 'Sound off';
      sound.disabled = pref.mode === 'off';
    };
    light();
  }

  const footer = el('div', 'hud-chat-settings-footer');
  const reset = btn('Reset chat settings', 'dv-btn is-small');
  reset.addEventListener('click', () => {
    Object.assign(settings, defaultChatSettings());
    resetSize?.();
    change();
    panel.replaceWith(chatSettingsPanel(settings, hooks));
  });
  footer.append(reset);
  panel.append(footer);
  return panel;
}
