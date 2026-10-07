// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-alerts.ts
// DOM alert banners (top-center). Life / radiation / cold are not banners:
// they show as the screen-edge glow in render/status-vignette.ts.

import { icon, type IconName } from '../dom/icons';

export interface ActiveAlert {
  id: string;
  icon: IconName;
  title: string;
  subtitle: string;
  color: string;
  bgColor: string;
  pulse?: boolean;
}

const ACHIEVEMENT_MS = 5000;

export class HudAlerts {
  private mounted = false;
  private root!: HTMLElement;
  private tempAlertText: string | null = null;
  private tempAlertTimer = 0;
  private lastSignature = '';
  /** Unlocked achievements waiting for the banner, one at a time. */
  private readonly achievements: { name: string; points: number }[] = [];
  private achievementTimer = 0;

  triggerTempAlert(text: string, durationMs = 3000): void {
    this.tempAlertText = text;
    this.tempAlertTimer = durationMs;
  }

  /** ACHIEVEMENT_UNLOCKED: a banner of its own, queued behind any still showing. */
  triggerAchievement(name: string, points: number): void {
    this.achievements.push({ name, points });
    if (this.achievements.length === 1) this.achievementTimer = ACHIEVEMENT_MS;
  }

  update(deltaMs: number): void {
    if (this.tempAlertTimer > 0) {
      this.tempAlertTimer -= deltaMs;
      if (this.tempAlertTimer <= 0) {
        this.tempAlertText = null;
      }
    }
    if (this.achievements.length) {
      this.achievementTimer -= deltaMs;
      if (this.achievementTimer <= 0) {
        this.achievements.shift();
        this.achievementTimer = this.achievements.length ? ACHIEVEMENT_MS : 0;
      }
    }
  }

  getActiveAlerts(): ActiveAlert[] {
    const alerts: ActiveAlert[] = [];

    const achievement = this.achievements[0];
    if (achievement) {
      alerts.push({
        id: 'achievement',
        icon: 'skills',
        title: 'ACHIEVEMENT UNLOCKED',
        subtitle: achievement.points ? `${achievement.name} · +${achievement.points} points` : achievement.name,
        color: 'var(--dv-ok-text)',
        bgColor: 'var(--dv-surface)',
        pulse: true,
      });
    }

    if (this.tempAlertText) {
      alerts.push({
        id: 'tool',
        icon: 'broken_tool',
        title: 'WRONG TOOL',
        subtitle: this.tempAlertText,
        color: 'var(--dv-warn-text)',
        bgColor: 'var(--dv-surface)',
      });
    }

    return alerts;
  }

  mount(root: HTMLElement): void {
    if (this.mounted) return;
    this.mounted = true;
    this.root = root;
  }

  render(): void {
    const alerts = this.getActiveAlerts();

    const signature = alerts.map((a) => `${a.id}:${a.title}:${a.subtitle}`).join('|');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    this.root.innerHTML = '';

    for (const alert of alerts) {
      const el = document.createElement('div');
      el.className = alert.pulse ? 'hud-alert pulse' : 'hud-alert';
      el.style.setProperty('--c', alert.color);
      el.style.setProperty('--bg', alert.bgColor);

      const glyph = document.createElement('span');
      glyph.className = 'hud-alert-glyph';
      glyph.innerHTML = icon(alert.icon);

      const text = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'hud-alert-title';
      title.textContent = alert.title;
      const sub = document.createElement('div');
      sub.className = 'hud-alert-sub';
      sub.textContent = alert.subtitle;
      text.append(title, sub);

      el.append(glyph, text);
      this.root.appendChild(el);
    }
  }
}
