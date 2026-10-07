// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/windows/achievements-panel.ts
// The journal's Achievements tab: points, every achievement (unlocked with its
// date, locked with progress when one stat decides it, secret as ???), then
// the account's public stats. Definitions are the content tables; what the
// account has is ProgressStore.

import type { AchievementEntry, StatEntry } from '../../../../../shared/typescript/content-schema';
import type { ProgressStore } from '../../world/progress-store';
import { icon } from '../dom/icons';

export interface AchievementsDeps {
  progress: ProgressStore;
  achievements: Readonly<Record<string, AchievementEntry>> | undefined;
  stats: Readonly<Record<string, StatEntry>> | undefined;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

const dateOf = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function renderAchievements(d: AchievementsDeps): HTMLElement {
  const root = el('div', 'dv-achievements');
  if (!d.progress.enabled) {
    root.append(el('p', 'dv-quest-empty', d.progress.guest
      ? 'Log in to earn achievements. They stay with your account on every server.'
      : 'This server does not record achievements.'));
    return root;
  }
  if (!d.progress.loaded) {
    root.append(el('p', 'dv-quest-empty', 'Loading your achievements…'));
    return root;
  }
  const statsById = new Map<number, StatEntry>();
  const statsByKey = new Map<string, StatEntry>();
  for (const s of Object.values(d.stats ?? {})) {
    statsById.set(s.id, s);
    statsByKey.set(s.key, s);
  }
  const all = Object.values(d.achievements ?? {})
    .filter((a) => !a.retired || d.progress.unlocked.has(a.id))
    .sort((a, b) => Number(d.progress.unlocked.has(b.id)) - Number(d.progress.unlocked.has(a.id)) || a.id - b.id);
  const unlocked = all.filter((a) => d.progress.unlocked.has(a.id));
  const points = unlocked.reduce((sum, a) => sum + (a.points ?? 0), 0);

  const summary = el('div', 'dv-achievements-summary');
  summary.append(el('strong', 'dv-achievements-points', `${points} points`), el('span', '', `${unlocked.length} of ${all.length} unlocked`));
  root.append(summary);

  const grid = el('div', 'dv-achievements-grid');
  for (const a of all) {
    const has = d.progress.unlocked.get(a.id);
    const secretText = d.progress.secrets.get(a.id);
    const hidden = a.secret && !has;
    const card = el('section', 'dv-achievement');
    card.classList.toggle('is-unlocked', has !== undefined);
    card.classList.toggle('is-fresh', d.progress.fresh.has(a.id));
    card.classList.toggle('is-secret', hidden);
    const head = el('div', 'dv-achievement-head');
    const mark = el('span', 'dv-achievement-mark');
    mark.innerHTML = icon(has !== undefined ? 'check' : hidden ? 'lock' : 'skills');
    head.append(mark, el('h4', 'dv-achievement-name', hidden ? '???' : (a.name ?? secretText?.name ?? a.key)));
    if (a.points) head.append(el('span', 'dv-achievement-points', `${a.points}`));
    card.append(head);
    card.append(el('p', 'dv-achievement-text', hidden ? 'A secret. Keep playing.' : (a.description ?? secretText?.description ?? '')));
    if (has !== undefined) {
      card.append(el('span', 'dv-achievement-date', `Unlocked ${dateOf(has)}`));
    } else if (!hidden && a.requires?.length === 1) {
      const need = a.requires[0]!;
      const stat = statsByKey.get(need.stat);
      const current = stat ? Math.min(d.progress.stat(stat.id), need.atLeast) : 0;
      const bar = el('div', 'dv-achievement-bar');
      const fill = el('span', 'dv-achievement-fill');
      fill.style.width = `${Math.round((current / need.atLeast) * 100)}%`;
      bar.append(fill);
      card.append(bar, el('span', 'dv-achievement-progress', `${current.toLocaleString()} / ${need.atLeast.toLocaleString()}`));
    }
    grid.append(card);
  }
  root.append(grid);

  const visible = [...statsById.values()].filter((s) => s.public !== false && !s.retired).sort((a, b) => a.id - b.id);
  if (visible.length) {
    root.append(el('h4', 'dv-quest-subhead', 'Stats'));
    const list = el('dl', 'dv-stats-list');
    for (const s of visible) list.append(el('dt', '', s.name), el('dd', '', d.progress.stat(s.id).toLocaleString()));
    root.append(list);
  }
  return root;
}
