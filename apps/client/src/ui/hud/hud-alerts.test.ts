// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { HudAlerts } from './hud-alerts';

function mounted() {
  const root = document.createElement('div');
  const alerts = new HudAlerts();
  alerts.mount(root);
  return { root, alerts };
}

describe('HudAlerts', () => {
  // Life, radiation and cold are the screen-edge glow (render/status-vignette.ts), not banners.
  it('shows no banner without a temporary alert', () => {
    const { root, alerts } = mounted();
    alerts.render();
    expect(alerts.getActiveAlerts()).toEqual([]);
    expect(root.children.length).toBe(0);
  });

  it('shows a temporary alert for its duration, then clears it', () => {
    const { root, alerts } = mounted();
    alerts.triggerTempAlert('Needs a pickaxe', 1000);
    alerts.render();
    expect(root.querySelector('.hud-alert-title')?.textContent).toBe('WRONG TOOL');
    expect(root.querySelector('.hud-alert-sub')?.textContent).toBe('Needs a pickaxe');

    alerts.update(1000);
    alerts.render();
    expect(root.children.length).toBe(0);
  });

  it('shows each unlocked achievement for five seconds, one after the other', () => {
    const { root, alerts } = mounted();
    alerts.triggerAchievement('Ghoul Hunter', 5);
    alerts.triggerAchievement('Road Warden', 0);
    alerts.render();
    expect(root.querySelector('.hud-alert-title')?.textContent).toBe('ACHIEVEMENT UNLOCKED');
    expect(root.querySelector('.hud-alert-sub')?.textContent).toBe('Ghoul Hunter · +5 points');
    alerts.update(5000);
    alerts.render();
    expect(root.querySelector('.hud-alert-sub')?.textContent).toBe('Road Warden');
    alerts.update(5000);
    alerts.render();
    expect(root.children.length).toBe(0);
  });
});
