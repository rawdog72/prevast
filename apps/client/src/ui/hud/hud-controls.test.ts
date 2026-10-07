// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { HudControls, type HudControlsState } from './hud-controls';
import { DEFAULT_UI_SCALE } from '../ui-scale';

describe('HudControls strip (under the minimap: Craft, Clan, Quests, Map, Options)', () => {
  const defaultState: HudControlsState = {
    audioMuted: false,
    volumeMaster: 1.0,
    volumeSfx: 0.8,
    volumeMusic: 0.5,
    particlesDisabled: false,
    zoomLevel: 1.0,
    keyboardLayout: 'qwerty',
    leaderboardVisible: true,
    profilerVisible: false,
    statsVisible: false,
    skillPoints: 0,
    uiScale: { ...DEFAULT_UI_SCALE },
    noticeY: 80,
    privateMessages: 'everyone',
  };

  function mount(state = defaultState, onAction = vi.fn()) {
    const root = document.createElement('div');
    const controls = new HudControls();
    controls.mount(root, state, onAction);
    const buttons = () => Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
    return { root, controls, onAction, buttons };
  }

  it('mounts exactly the five buttons, in order, with their hints', () => {
    const { buttons } = mount();
    expect(buttons().map((b) => b.getAttribute('data-hint'))).toEqual([
      'Crafting [C]',
      'Teams & clan [T]',
      'Quests [J]',
      'Map [M]',
      'Options',
    ]);
  });

  it('routes each click to its action', () => {
    const { buttons, onAction } = mount();
    buttons().forEach((b) => b.click());
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([
      'toggle_craft',
      'toggle_team',
      'toggle_quests',
      'toggle_map',
      'toggle_options',
    ]);
  });

  it('shows unspent skill points as a badge on the craft button (old bouncing skillPointIcon)', () => {
    const { root, controls, buttons } = mount();
    expect(root.querySelector('.hud-btn-badge')).toBeNull();
    controls.update({ ...defaultState, skillPoints: 3 });
    const badge = buttons()[0].querySelector('.hud-btn-badge')!;
    expect(badge.textContent).toBe('3');
    controls.update({ ...defaultState, skillPoints: 0 });
    expect(root.querySelector('.hud-btn-badge')).toBeNull();
  });
});
