// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { HudControlsState } from '../hud/hud-controls';
import { DEFAULT_UI_SCALE } from '../ui-scale';
import { OptionsWindow } from './options-window';

describe('OptionsWindow (GameUI.settings rows: label + option buttons, the active one lit)', () => {
  const state: HudControlsState = {
    audioMuted: false,
    volumeMaster: 1.0,
    volumeSfx: 0.8,
    volumeMusic: 0.5,
    particlesDisabled: true,
    zoomLevel: 1.0,
    keyboardLayout: 'azerty',
    leaderboardVisible: true,
    profilerVisible: false,
    statsVisible: true,
    skillPoints: 0,
    uiScale: { ...DEFAULT_UI_SCALE },
    noticeY: 80,
    privateMessages: 'everyone',
  };

  function setup(s = state) {
    const body = document.createElement('div');
    const onAction = vi.fn();
    const win = new OptionsWindow();
    win.mount(body, s, onAction);
    const rows = () =>
      Array.from(
        body.querySelectorAll<HTMLElement>('.dv-settings-row:not(.is-size):not(.is-audio):not(.is-privacy)'),
      );
    const sizeRows = () =>
      Array.from(body.querySelectorAll<HTMLElement>('.dv-settings-row.is-size'));
    const sizeRow = (label: string) =>
      sizeRows().find((r) => r.querySelector('.dv-settings-label')!.textContent === label)!;
    const audioRows = () =>
      Array.from(body.querySelectorAll<HTMLElement>('.dv-settings-row.is-audio'));
    const audioRow = (label: string) =>
      audioRows().find((r) => r.querySelector('.dv-settings-label')!.textContent === label)!;
    const row = (label: string) =>
      rows().find((r) => r.querySelector('.dv-settings-label')!.textContent === label)!;
    const active = (label: string) =>
      Array.from(row(label).querySelectorAll<HTMLButtonElement>('.dv-btn')).find((b) =>
        b.classList.contains('is-primary'),
      )?.textContent;
    return { body, win, onAction, rows, row, active, sizeRows, sizeRow, audioRows, audioRow };
  }

  it('lists every setting the toolbar used to carry, with the current choice lit', () => {
    const { rows, active } = setup();
    expect(rows().map((r) => r.querySelector('.dv-settings-label')!.textContent)).toEqual([
      'Particles',
      'Keyboard',
      'Leaderboard',
      'Stats',
      'Profiler',
      'Zoom',
      'Pop-out Position',
    ]);
    expect(active('Particles')).toBe('Off');
    expect(active('Keyboard')).toBe('AZERTY');
    expect(active('Leaderboard')).toBe('Show');
    expect(active('Stats')).toBe('Show');
    expect(active('Profiler')).toBe('Hide');
  });

  it('fires the toggle only when a different choice is picked', () => {
    const { row, onAction } = setup();
    const [on, off] = Array.from(row('Particles').querySelectorAll<HTMLButtonElement>('.dv-btn'));
    off.click();
    expect(onAction).not.toHaveBeenCalled();
    on.click();
    expect(onAction).toHaveBeenCalledWith('toggle_particles');
    row('Profiler').querySelectorAll<HTMLButtonElement>('.dv-btn')[0].click();
    expect(onAction).toHaveBeenLastCalledWith('toggle_profiler');
    row('Stats').querySelectorAll<HTMLButtonElement>('.dv-btn')[1].click();
    expect(onAction).toHaveBeenLastCalledWith('toggle_stats');
  });

  it('shows the zoom as a percentage between - and + and refreshes when the state changes', () => {
    const { row, onAction, win } = setup();
    const zoom = row('Zoom');
    expect(zoom.querySelector('.dv-settings-value')!.textContent).toBe('100%');
    const [minus, plus] = Array.from(zoom.querySelectorAll<HTMLButtonElement>('.dv-btn'));
    minus.click();
    plus.click();
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['zoom_out', 'zoom_in']);
    win.refresh({ ...state, zoomLevel: 1.3, particlesDisabled: false });
    expect(zoom.querySelector('.dv-settings-value')!.textContent).toBe('130%');
    expect(
      row('Particles')
        .querySelectorAll<HTMLButtonElement>('.dv-btn')[0]
        .classList.contains('is-primary'),
    ).toBe(true);
  });

  describe('tabs (General | Interface | Audio)', () => {
    const tabs = (body: HTMLElement) =>
      Array.from(body.querySelectorAll<HTMLButtonElement>('.dv-options-tabs .dv-tab'));
    const pane = (body: HTMLElement, name: string) =>
      body.querySelector<HTMLElement>(`.dv-options-pane[data-tab="${name}"]`)!;

    it('opens on General with the size rows on the hidden Interface pane and audio on the Audio pane', () => {
      const { body } = setup();
      expect(tabs(body).map((t) => t.textContent)).toEqual([
        'General',
        'Interface',
        'Audio',
        'Privacy',
      ]);
      expect(tabs(body)[0].classList.contains('is-active')).toBe(true);
      expect(pane(body, 'general').hidden).toBe(false);
      expect(pane(body, 'interface').hidden).toBe(true);
      expect(pane(body, 'audio').hidden).toBe(true);
      expect(pane(body, 'general').querySelector('.dv-settings-row.is-size')).toBeNull();
      expect(pane(body, 'interface').querySelectorAll('.dv-settings-row.is-size').length).toBe(8);
      expect(pane(body, 'audio').querySelectorAll('.dv-settings-row.is-audio').length).toBe(4);
    });

    it('switches panes on a tab click and remembers the tab across a remount', () => {
      const { body, win } = setup();
      tabs(body)[1].click();
      expect(pane(body, 'interface').hidden).toBe(false);
      expect(pane(body, 'general').hidden).toBe(true);
      expect(tabs(body)[1].classList.contains('is-active')).toBe(true);
      const again = document.createElement('div');
      win.mount(again, state, vi.fn());
      expect(tabs(again)[1].classList.contains('is-active')).toBe(true);
      expect(pane(again, 'interface').hidden).toBe(false);
    });
  });

  describe('Privacy tab (who may message us privately)', () => {
    it('lights the current choice and fires private_messages_set for a different one', () => {
      const { body, win, onAction } = setup({ ...state, privateMessages: 'clan' });
      const pane = body.querySelector<HTMLElement>('.dv-options-pane[data-tab="privacy"]')!;
      expect(pane.hidden).toBe(true);
      const row = pane.querySelector<HTMLElement>('.dv-settings-row.is-privacy')!;
      expect(row.querySelector('.dv-settings-label')!.textContent).toBe('Private messages');
      const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>('.dv-btn'));
      expect(buttons.map((b) => b.textContent)).toEqual(['Everyone', 'Clan only', 'Nobody']);
      expect(buttons.map((b) => b.classList.contains('is-primary'))).toEqual([false, true, false]);

      buttons[1]!.click();
      expect(onAction).not.toHaveBeenCalled();
      buttons[2]!.click();
      expect(onAction).toHaveBeenCalledWith({ type: 'private_messages_set', value: 'nobody' });

      win.refresh({ ...state, privateMessages: 'nobody' });
      expect(buttons.map((b) => b.classList.contains('is-primary'))).toEqual([false, false, true]);
      // Staff are the exception, and the pane says so.
      expect(pane.textContent).toContain('Staff');
    });
  });

  describe('Audio tab (Sound toggle and volume sliders)', () => {
    it('shows Sound toggle and volume sliders, and fires volume_set on input', () => {
      const { body, audioRows, audioRow, onAction, win } = setup();
      const tabBtn = Array.from(
        body.querySelectorAll<HTMLButtonElement>('.dv-options-tabs .dv-tab'),
      ).find((b) => b.textContent === 'Audio')!;
      tabBtn.click();
      expect(body.querySelector<HTMLElement>('.dv-options-pane[data-tab="audio"]')!.hidden).toBe(false);

      expect(audioRows().map((r) => r.querySelector('.dv-settings-label')!.textContent)).toEqual([
        'Sound',
        'Master Volume',
        'Sound Effects',
        'Music',
      ]);

      const sound = audioRow('Sound');
      const [on, off] = Array.from(sound.querySelectorAll<HTMLButtonElement>('.dv-btn'));
      expect(on.classList.contains('is-primary')).toBe(true);
      off.click();
      expect(onAction).toHaveBeenCalledWith('toggle_audio');

      const master = audioRow('Master Volume');
      const masterRange = master.querySelector<HTMLInputElement>('input.dv-range')!;
      expect(masterRange.value).toBe('100');
      expect(master.querySelector('.dv-settings-value')!.textContent).toBe('100%');

      masterRange.value = '50';
      masterRange.dispatchEvent(new Event('input'));
      expect(onAction).toHaveBeenCalledWith({ type: 'volume_set', kind: 'master', value: 0.5 });
      expect(master.querySelector('.dv-settings-value')!.textContent).toBe('50%');

      win.refresh({ ...state, volumeMaster: 0.7, audioMuted: true });
      expect(master.querySelector('.dv-settings-value')!.textContent).toBe('70%');
      expect(
        audioRow('Sound').querySelectorAll<HTMLButtonElement>('.dv-btn')[1].classList.contains('is-primary'),
      ).toBe(true);
    });
  });

  describe('Interface size block (the HUD zoom per region, on top of the window fit)', () => {
    it('lists one step row per region under its own heading, at 100% by default', () => {
      const { body, sizeRows } = setup();
      expect(body.querySelector('.dv-settings-head')!.textContent).toContain('Interface size');
      expect(sizeRows().map((r) => r.querySelector('.dv-settings-label')!.textContent)).toEqual([
        'Everything',
        'Inventory',
        'Vitals',
        'Minimap',
        'Leaderboard',
        'Windows',
        'Chat',
        'Pop-outs',
      ]);
      for (const r of sizeRows()) {
        expect(r.querySelector('.dv-settings-value')!.textContent).toBe('100%');
      }
    });

    it('fires a ui_scale step for the region of the row', () => {
      const { sizeRow, onAction } = setup();
      const [minus, plus] = Array.from(
        sizeRow('Inventory').querySelectorAll<HTMLButtonElement>('.dv-btn'),
      );
      minus.click();
      expect(onAction).toHaveBeenLastCalledWith({
        type: 'ui_scale',
        region: 'inventory',
        direction: -1,
      });
      plus.click();
      expect(onAction).toHaveBeenLastCalledWith({
        type: 'ui_scale',
        region: 'inventory',
        direction: 1,
      });
      sizeRow('Everything').querySelectorAll<HTMLButtonElement>('.dv-btn')[1].click();
      expect(onAction).toHaveBeenLastCalledWith({ type: 'ui_scale', region: 'hud', direction: 1 });
    });

    it('has a Reset button in the heading that fires ui_scale_reset', () => {
      const { body, onAction } = setup();
      body.querySelector<HTMLButtonElement>('.dv-settings-head .dv-btn')!.click();
      expect(onAction).toHaveBeenLastCalledWith({ type: 'ui_scale_reset' });
    });

    it('shows the picked scale after a refresh', () => {
      const { sizeRow, win } = setup();
      win.refresh({ ...state, uiScale: { ...DEFAULT_UI_SCALE, vitals: 1.3, windows: 0.8 } });
      expect(sizeRow('Vitals').querySelector('.dv-settings-value')!.textContent).toBe('130%');
      expect(sizeRow('Windows').querySelector('.dv-settings-value')!.textContent).toBe('80%');
      expect(sizeRow('Inventory').querySelector('.dv-settings-value')!.textContent).toBe('100%');
    });
  });
});
