// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/windows/options-window.ts
// GameUI.settings as DOM: one row per setting -- a label on the left and the
// choices as buttons on the right with the current one lit, a rule between
// rows. It carries everything the old toolbar buttons did (sound, particles,
// keyboard layout, leaderboard) plus the profiler (F2) and the zoom the mouse
// wheel drives. Picking a choice fires the same HudControlAction the toolbar
// used to, so the game loop keeps one handler. Stats is the small fps / ping
// line under the minimap cluster. The rows do not all fit one page, so the
// window has two tabs: General (the rows above) and Interface ("Interface
// size": one step row per HUD region and one for everything on top of the
// window fit, with a Reset in the heading -- see ui-scale.ts), Audio, and
// Privacy (who may send us a private message). The tab last looked at is
// kept for the next open.

import type { HudAction, HudControlAction, HudControlsState } from '../hud/hud-controls';
import { PRIVATE_MESSAGES, type PrivateMessages } from '../options-settings';
import { UI_SCALE_REGIONS, type UiScaleRegion } from '../ui-scale';

const PRIVATE_MESSAGE_LABELS: Record<PrivateMessages, string> = {
  everyone: 'Everyone',
  clan: 'Clan only',
  nobody: 'Nobody',
};

interface ToggleRow {
  kind: 'toggle';
  label: string;
  options: [string, string];
  /** Index of the lit option for this state. */
  value: (s: HudControlsState) => 0 | 1;
  action: HudControlAction;
}

interface StepRow {
  kind: 'step';
  label: string;
  value: (s: HudControlsState) => string;
  decrease: HudControlAction;
  increase: HudControlAction;
}

type Row = ToggleRow | StepRow;

const SIZE_LABELS: Record<UiScaleRegion, string> = {
  hud: 'Everything',
  inventory: 'Inventory',
  vitals: 'Vitals',
  minimap: 'Minimap',
  leaderboard: 'Leaderboard',
  windows: 'Windows',
  chat: 'Chat',
  notices: 'Pop-outs',
};

function percent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

const ROWS: Row[] = [
  {
    kind: 'toggle',
    label: 'Particles',
    options: ['On', 'Off'],
    value: (s) => (s.particlesDisabled ? 1 : 0),
    action: 'toggle_particles',
  },
  {
    kind: 'toggle',
    label: 'Keyboard',
    options: ['QWERTY', 'AZERTY'],
    value: (s) => (s.keyboardLayout === 'azerty' ? 1 : 0),
    action: 'toggle_keyboard',
  },
  {
    kind: 'toggle',
    label: 'Leaderboard',
    options: ['Show', 'Hide'],
    value: (s) => (s.leaderboardVisible ? 0 : 1),
    action: 'toggle_leaderboard',
  },
  {
    kind: 'toggle',
    label: 'Stats',
    options: ['Show', 'Hide'],
    value: (s) => (s.statsVisible ? 0 : 1),
    action: 'toggle_stats',
  },
  {
    kind: 'toggle',
    label: 'Profiler',
    options: ['Show', 'Hide'],
    value: (s) => (s.profilerVisible ? 0 : 1),
    action: 'toggle_profiler',
  },
  {
    kind: 'step',
    label: 'Zoom',
    value: (s) => `${Math.round(s.zoomLevel * 100)}%`,
    decrease: 'zoom_out',
    increase: 'zoom_in',
  },
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

type OptionsTab = 'general' | 'interface' | 'audio' | 'privacy';
const TABS: { id: OptionsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'interface', label: 'Interface' },
  { id: 'audio', label: 'Audio' },
  { id: 'privacy', label: 'Privacy' },
];

export class OptionsWindow {
  private state!: HudControlsState;
  private readonly toggles: { row: ToggleRow; buttons: HTMLButtonElement[] }[] = [];
  private readonly values: { row: StepRow; el: HTMLElement }[] = [];
  private readonly sizes: { region: UiScaleRegion; el: HTMLElement }[] = [];
  private readonly volumeSliders = new Map<
    'master' | 'sfx' | 'music',
    { range: HTMLInputElement; valSpan: HTMLElement; get: (s: HudControlsState) => number }
  >();
  private audioSoundToggle?: { buttons: HTMLButtonElement[] };
  private privateMessageButtons: HTMLButtonElement[] = [];
  private noticeYRange?: HTMLInputElement;
  private lastSignature = '';
  private tab: OptionsTab = 'general';
  private tabButtons = new Map<OptionsTab, HTMLButtonElement>();
  private panes = new Map<OptionsTab, HTMLElement>();

  mount(body: HTMLElement, state: HudControlsState, onAction: (action: HudAction) => void): void {
    this.state = state;
    this.toggles.length = 0;
    this.values.length = 0;
    this.sizes.length = 0;
    this.volumeSliders.clear();
    this.audioSoundToggle = undefined;
    this.privateMessageButtons = [];
    this.lastSignature = '';
    this.tabButtons.clear();
    this.panes.clear();
    body.innerHTML = '';

    const strip = el('div', 'dv-options-tabs');
    for (const { id, label } of TABS) {
      const btn = el('button', 'dv-tab', label);
      btn.type = 'button';
      btn.addEventListener('click', () => this.showTab(id));
      strip.appendChild(btn);
      this.tabButtons.set(id, btn);
    }
    body.appendChild(strip);

    const general = el('div', 'dv-options-pane');
    general.dataset.tab = 'general';
    general.appendChild(this.buildGeneral(onAction));
    const iface = el('div', 'dv-options-pane');
    iface.dataset.tab = 'interface';
    const sizes = el('div', 'dv-settings');
    sizes.appendChild(this.buildSizeBlock(onAction));
    iface.appendChild(sizes);
    const audioPane = el('div', 'dv-options-pane');
    audioPane.dataset.tab = 'audio';
    audioPane.appendChild(this.buildAudio(onAction));

    const privacyPane = el('div', 'dv-options-pane');
    privacyPane.dataset.tab = 'privacy';
    privacyPane.appendChild(this.buildPrivacy(onAction));

    body.append(general, iface, audioPane, privacyPane);
    this.panes.set('general', general);
    this.panes.set('interface', iface);
    this.panes.set('audio', audioPane);
    this.panes.set('privacy', privacyPane);
    this.showTab(this.tab);
    this.refresh(state);
  }

  private showTab(tab: OptionsTab): void {
    this.tab = tab;
    for (const [id, btn] of this.tabButtons) btn.classList.toggle('is-active', id === tab);
    for (const [id, pane] of this.panes) pane.hidden = id !== tab;
  }

  /** The GameUI.settings rows: sound, particles, keyboard, leaderboard, stats, profiler, zoom. */
  private buildGeneral(onAction: (action: HudAction) => void): HTMLElement {
    const list = el('div', 'dv-settings');
    for (const row of ROWS) {
      const rowEl = el('div', 'dv-settings-row');
      rowEl.appendChild(el('div', 'dv-settings-label', row.label));
      const choices = el('div', 'dv-settings-choices');
      if (row.kind === 'toggle') {
        const buttons = row.options.map((label, i) => {
          const btn = el('button', 'dv-btn', label);
          btn.type = 'button';
          btn.addEventListener('click', () => {
            // The lit choice is the current state: only a different pick toggles.
            if (row.value(this.state) !== i) onAction(row.action);
          });
          choices.appendChild(btn);
          return btn;
        });
        this.toggles.push({ row, buttons });
      } else {
        const minus = el('button', 'dv-btn', '−');
        minus.type = 'button';
        minus.setAttribute('aria-label', `${row.label} out`);
        minus.addEventListener('click', () => onAction(row.decrease));
        const value = el('span', 'dv-settings-value');
        const plus = el('button', 'dv-btn', '+');
        plus.type = 'button';
        plus.setAttribute('aria-label', `${row.label} in`);
        plus.addEventListener('click', () => onAction(row.increase));
        choices.append(minus, value, plus);
        this.values.push({ row, el: value });
      }
      rowEl.appendChild(choices);
      list.appendChild(rowEl);
    }
    return list;
  }

  /** "Interface size" heading with Reset, then a compact - value + row per region. */
  private buildSizeBlock(onAction: (action: HudAction) => void): DocumentFragment {
    const frag = document.createDocumentFragment();
    const head = el('div', 'dv-settings-head is-first');
    head.appendChild(el('span', 'dv-settings-head-title', 'Interface size'));
    const reset = el('button', 'dv-btn', 'Reset');
    reset.type = 'button';
    reset.addEventListener('click', () => onAction({ type: 'ui_scale_reset' }));
    head.appendChild(reset);
    frag.appendChild(head);
    for (const region of UI_SCALE_REGIONS) {
      const rowEl = el('div', 'dv-settings-row is-size');
      rowEl.appendChild(el('div', 'dv-settings-label', SIZE_LABELS[region]));
      const choices = el('div', 'dv-settings-choices');
      const minus = el('button', 'dv-btn', '−');
      minus.type = 'button';
      minus.setAttribute('aria-label', `${SIZE_LABELS[region]} smaller`);
      minus.addEventListener('click', () => onAction({ type: 'ui_scale', region, direction: -1 }));
      const value = el('span', 'dv-settings-value');
      const plus = el('button', 'dv-btn', '+');
      plus.type = 'button';
      plus.setAttribute('aria-label', `${SIZE_LABELS[region]} bigger`);
      plus.addEventListener('click', () => onAction({ type: 'ui_scale', region, direction: 1 }));
      choices.append(minus, value, plus);
      rowEl.appendChild(choices);
      frag.appendChild(rowEl);
      this.sizes.push({ region, el: value });
    }
    const yRowEl = el('div', 'dv-settings-row');
    yRowEl.appendChild(el('div', 'dv-settings-label', 'Pop-out Position'));
    const yChoices = el('div', 'dv-settings-choices');
    const yRange = document.createElement('input');
    yRange.type = 'range';
    yRange.className = 'dv-range';
    yRange.min = '0';
    yRange.max = '400';
    yRange.step = '10';
    yRange.style.width = '120px';
    yRange.style.cursor = 'pointer';
    yRange.addEventListener('input', () => onAction({ type: 'notice_y_set', value: parseInt(yRange.value) }));
    this.noticeYRange = yRange;
    yChoices.appendChild(yRange);
    yRowEl.appendChild(yChoices);
    frag.appendChild(yRowEl);
    return frag;
  }

  /** The Audio pane: sound on/off toggle and master/sfx/music volume sliders. */
  private buildAudio(onAction: (action: HudAction) => void): HTMLElement {
    const list = el('div', 'dv-settings');

    const soundRow = el('div', 'dv-settings-row is-audio');
    soundRow.appendChild(el('div', 'dv-settings-label', 'Sound'));
    const soundChoices = el('div', 'dv-settings-choices');
    const soundButtons = ['On', 'Off'].map((label, i) => {
      const btn = el('button', 'dv-btn', label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if ((this.state.audioMuted ? 1 : 0) !== i) onAction('toggle_audio');
      });
      soundChoices.appendChild(btn);
      return btn;
    });
    soundRow.appendChild(soundChoices);
    list.appendChild(soundRow);
    this.audioSoundToggle = { buttons: soundButtons };

    const volumes: { kind: 'master' | 'sfx' | 'music'; label: string; get: (s: HudControlsState) => number }[] = [
      { kind: 'master', label: 'Master Volume', get: (s) => s.volumeMaster },
      { kind: 'sfx', label: 'Sound Effects', get: (s) => s.volumeSfx },
      { kind: 'music', label: 'Music', get: (s) => s.volumeMusic },
    ];

    for (const v of volumes) {
      const rowEl = el('div', 'dv-settings-row is-audio');
      rowEl.appendChild(el('div', 'dv-settings-label', v.label));
      const choices = el('div', 'dv-settings-choices');
      const range = document.createElement('input');
      range.type = 'range';
      range.className = 'dv-range';
      range.min = '0';
      range.max = '100';
      range.step = '5';
      range.style.flex = '1';
      range.style.cursor = 'pointer';
      range.value = String(Math.round(v.get(this.state) * 100));

      const valSpan = el('span', 'dv-settings-value', `${Math.round(v.get(this.state) * 100)}%`);
      valSpan.style.width = '48px';
      valSpan.style.flex = '0 0 48px';

      range.addEventListener('input', () => {
        const val = parseInt(range.value, 10);
        valSpan.textContent = `${val}%`;
        onAction({ type: 'volume_set', kind: v.kind, value: val / 100 });
      });

      choices.append(range, valSpan);
      rowEl.appendChild(choices);
      list.appendChild(rowEl);
      this.volumeSliders.set(v.kind, { range, valSpan, get: v.get });
    }

    return list;
  }

  /** The Privacy pane: who may message us privately. Blocking one player is on their right-click menu. */
  private buildPrivacy(onAction: (action: HudAction) => void): HTMLElement {
    const list = el('div', 'dv-settings');
    const row = el('div', 'dv-settings-row is-privacy');
    row.appendChild(el('div', 'dv-settings-label', 'Private messages'));
    const choices = el('div', 'dv-settings-choices');
    this.privateMessageButtons = PRIVATE_MESSAGES.map((value) => {
      const btn = el('button', 'dv-btn', PRIVATE_MESSAGE_LABELS[value]);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (this.state.privateMessages !== value) onAction({ type: 'private_messages_set', value });
      });
      choices.appendChild(btn);
      return btn;
    });
    row.appendChild(choices);
    list.appendChild(row);
    list.appendChild(
      el(
        'p',
        'dv-muted dv-settings-note',
        'Staff can always reach you. To stop one player, right-click their name and pick Block, or type !block=<name>.',
      ),
    );
    return list;
  }

  /** Called every frame with the live state; writes only when a value changed. */
  refresh(state: HudControlsState): void {
    this.state = state;
    const signature =
      this.toggles.map((t) => t.row.value(state)).join(',') +
      '|' +
      this.values.map((v) => v.row.value(state)).join(',') +
      '|' +
      this.sizes.map((s) => state.uiScale[s.region]).join(',') +
      '|' +
      state.noticeY +
      '|' +
      (state.audioMuted ? '1' : '0') +
      '|' +
      state.volumeMaster +
      ',' +
      state.volumeSfx +
      ',' +
      state.volumeMusic +
      '|' +
      state.privateMessages;
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    for (const { row, buttons } of this.toggles) {
      const active = row.value(state);
      buttons.forEach((btn, i) => btn.classList.toggle('is-primary', i === active));
    }
    for (const { row, el: node } of this.values) node.textContent = row.value(state);
    for (const { region, el: node } of this.sizes)
      node.textContent = percent(state.uiScale[region]);
    if (this.noticeYRange && this.noticeYRange.value !== state.noticeY.toString()) {
      this.noticeYRange.value = state.noticeY.toString();
    }
    this.privateMessageButtons.forEach((btn, i) =>
      btn.classList.toggle('is-primary', PRIVATE_MESSAGES[i] === state.privateMessages),
    );
    if (this.audioSoundToggle) {
      const active = state.audioMuted ? 1 : 0;
      this.audioSoundToggle.buttons.forEach((btn, i) => btn.classList.toggle('is-primary', i === active));
    }
    for (const [, { range, valSpan, get }] of this.volumeSliders) {
      const pct = Math.round(get(state) * 100);
      if (range.value !== pct.toString()) {
        range.value = pct.toString();
      }
      valSpan.textContent = `${pct}%`;
    }
  }
}
