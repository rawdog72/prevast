// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { PlayerAlerts } from './player-alerts';

describe('PlayerAlerts (old client _playerNotification)', () => {
  it('shows the head of each player queue for 3 s, fading in over 500 ms with a 15px rise and out over the last 500 ms drifting 40px up', () => {
    const alerts = new PlayerAlerts();
    alerts.push(4, 1, 2); // hunger, critical
    alerts.push(4, 2, 0); // cold, queued behind it

    expect(alerts.frame(4)).toEqual({ sprite: 'alert1_2', alpha: 0, offsetY: 15 });

    alerts.update(250);
    expect(alerts.frame(4)).toEqual({ sprite: 'alert1_2', alpha: 0.5, offsetY: 7.5 });

    alerts.update(1000);
    expect(alerts.frame(4)).toEqual({ sprite: 'alert1_2', alpha: 1, offsetY: 0 });

    alerts.update(1500); // t = 2750: 250 ms into the fade-out
    expect(alerts.frame(4)).toEqual({ sprite: 'alert1_2', alpha: 0.5, offsetY: -20 });

    alerts.update(300); // t >= 3000: next one starts from scratch
    expect(alerts.frame(4)).toEqual({ sprite: 'alert2_0', alpha: 0, offsetY: 15 });

    alerts.update(3100);
    expect(alerts.frame(4)).toBeNull();
    expect(alerts.frame(9)).toBeNull();
  });

  it("clear(pid) drops a player's queue (death / removal)", () => {
    const alerts = new PlayerAlerts();
    alerts.push(4, 0, 1);
    alerts.clear(4);
    expect(alerts.frame(4)).toBeNull();
  });
});
