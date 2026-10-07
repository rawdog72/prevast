// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-controls.ts
// The button strip under the minimap panel: the five things a player opens --
// Crafting, Clan, the Quest journal, the full Map and Options (GameUI's craft / clan / map /
// settings icons, hudHint label under the hovered one). The craft button
// carries a badge with the unspent skill points, standing in for the old
// client's skillPointIcon that bounced beside the minimap. Every other toggle
// (sound, particles, keyboard layout, leaderboard, profiler, zoom) lives in
// the Options window; the action union covers those too since the window
// routes through the same handler.

import { icon } from '../dom/icons';
import type { KeyboardLayout, PrivateMessages } from '../options-settings';
import type { UiScaleRegion, UiScaleSettings } from '../ui-scale';

export type HudControlAction =
  | 'toggle_audio'
  | 'toggle_particles'
  | 'zoom_in'
  | 'zoom_out'
  | 'toggle_keyboard'
  | 'toggle_chat'
  | 'toggle_leaderboard'
  | 'toggle_profiler'
  | 'toggle_stats'
  | 'toggle_craft'
  | 'toggle_skills'
  | 'toggle_team'
  | 'toggle_quests'
  | 'toggle_map'
  | 'toggle_options';

/** Options > Interface size: one notch for a region, or everything back to 100%. */
export type UiScaleAction =
  { type: 'ui_scale'; region: UiScaleRegion; direction: 1 | -1 } | { type: 'ui_scale_reset' };

/** Everything the Options window can fire; the toolbar only fires the string ones. */
export type HudAction =
  | HudControlAction
  | UiScaleAction
  | { type: 'notice_y_set'; value: number }
  | { type: 'volume_set'; kind: 'master' | 'sfx' | 'music'; value: number }
  | { type: 'private_messages_set'; value: PrivateMessages };

export interface HudControlsState {
  audioMuted: boolean;
  volumeMaster: number;
  volumeSfx: number;
  volumeMusic: number;
  particlesDisabled: boolean;
  zoomLevel: number;
  keyboardLayout: KeyboardLayout;
  leaderboardVisible: boolean;
  profilerVisible: boolean;
  /** The small fps / ping line under the minimap cluster (persisted). */
  statsVisible: boolean;
  /** Unspent skill points (inventory.skillPointsLeft), shown on the craft button. */
  skillPoints: number;
  /** The player's HUD / per-region sizes (persisted); the window fit multiplies them. */
  uiScale: UiScaleSettings;
  /** Pop-out notice Y axis offset */
  noticeY: number;
  /** Options > Privacy: who may message us privately (persisted, sent to the server). */
  privateMessages: PrivateMessages;
}

interface ButtonDef {
  id: HudControlAction;
  icon: Parameters<typeof icon>[0];
  hint: string;
  badge: number;
}

function buildDefs(state: HudControlsState): ButtonDef[] {
  return [
    { id: 'toggle_craft', icon: 'craft', hint: 'Crafting [C]', badge: state.skillPoints },
    { id: 'toggle_team', icon: 'team', hint: 'Teams & clan [T]', badge: 0 },
    { id: 'toggle_quests', icon: 'quest', hint: 'Quests [J]', badge: 0 },
    { id: 'toggle_map', icon: 'map', hint: 'Map [M]', badge: 0 },
    { id: 'toggle_options', icon: 'settings', hint: 'Options', badge: 0 },
  ];
}

export class HudControls {
  private mounted = false;
  private readonly buttons = new Map<HudControlAction, HTMLButtonElement>();
  private readonly rendered = new Map<HudControlAction, string>();

  mount(
    root: HTMLElement,
    state: HudControlsState,
    onAction: (action: HudControlAction) => void,
  ): void {
    if (this.mounted) return;
    this.mounted = true;
    root.innerHTML = '';

    for (const def of buildDefs(state)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hud-btn';
      btn.innerHTML = icon(def.icon);
      // GameUI.hudHint: the label appears under the hovered button (CSS ::after).
      btn.setAttribute('data-hint', def.hint);
      btn.setAttribute('aria-label', def.hint);
      btn.addEventListener('click', () => onAction(def.id));
      root.appendChild(btn);
      this.buttons.set(def.id, btn);
    }

    this.update(state);
  }

  update(state: HudControlsState): void {
    for (const def of buildDefs(state)) {
      const btn = this.buttons.get(def.id);
      if (!btn) continue;
      // Per frame: only touch the DOM when the badge changed.
      const key = String(def.badge);
      if (this.rendered.get(def.id) === key) continue;
      this.rendered.set(def.id, key);
      let badge = btn.querySelector<HTMLElement>('.hud-btn-badge');
      if (def.badge > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'hud-btn-badge';
          btn.appendChild(badge);
        }
        badge.textContent = String(def.badge);
      } else if (badge) {
        badge.remove();
      }
    }
  }
}
