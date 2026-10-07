// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { HudStats } from './hud-stats';

function setup(visible = true) {
  const root = document.createElement('div');
  const stats = new HudStats();
  stats.mount(root);
  stats.setVisible(visible);
  return { root, stats };
}

describe('HudStats (the small fps / ping line)', () => {
  it('is hidden until switched on, and shows nothing before the first half-second window closes', () => {
    const { root, stats } = setup(false);
    expect(root.hidden).toBe(true);
    stats.setVisible(true);
    expect(root.hidden).toBe(false);
    for (let t = 0; t < 400; t += 16) stats.update(t, 40);
    expect(root.textContent).toBe('');
  });

  it('counts the frames it is fed and prints fps with the last ping', () => {
    const { root, stats } = setup();
    // 60 frames over one second.
    for (let i = 0; i <= 60; i++) stats.update(i * (1000 / 60), 42.4);
    expect(root.textContent).toBe('60 fps · 42 ms');
  });

  it('prints a dash for the ping until a pong has been timed, and only rewrites the DOM on change', () => {
    const { root, stats } = setup();
    for (let i = 0; i <= 32; i++) stats.update(i * (1000 / 60), -1);
    expect(root.textContent).toBe('60 fps · – ms');
    const before = root.textContent;
    let writes = 0;
    const observer = new MutationObserver(() => writes++);
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    for (let i = 33; i <= 60; i++) stats.update(i * (1000 / 60), -1);
    expect(root.textContent).toBe(before);
    observer.disconnect();
    expect(writes).toBe(0);
  });

  it('starts a fresh window when shown again so a long hidden stretch never reads as 0 fps', () => {
    const { root, stats } = setup();
    for (let i = 0; i <= 32; i++) stats.update(i * (1000 / 60), 20);
    stats.setVisible(false);
    stats.setVisible(true);
    for (let i = 0; i <= 32; i++) stats.update(100000 + i * (1000 / 60), 20);
    expect(root.textContent).toBe('60 fps · 20 ms');
  });
});
