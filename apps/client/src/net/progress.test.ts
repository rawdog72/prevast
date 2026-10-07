// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { AchievementEntry, StatEntry } from '../../../../shared/typescript/content-schema';
import { ProgressStore } from '../world/progress-store';
import { renderAchievements } from '../ui/windows/achievements-panel';
import { BinaryWriter } from './binary-stream';
import { dispatchServerMessage } from './dispatcher';
import { NetEventBus } from './events';

const statePacket = (state: unknown) => {
  const w = new BinaryWriter(); w.u8(106); w.str(JSON.stringify(state)); return w.build();
};
const updatePacket = (stats: [number, number][]) => {
  const w = new BinaryWriter(); w.u8(107); w.u8(stats.length);
  for (const [id, value] of stats) { w.u16(id); w.u32(value); }
  return w.build();
};
const unlockPacket = (id: number, at: number, name: string, description: string) => {
  const w = new BinaryWriter(); w.u8(108); w.u16(id); w.u32(at); w.str(JSON.stringify({ name, description })); return w.build();
};

const STATS: Record<string, StatEntry> = {
  kills_ghoul: { key: 'kills_ghoul', id: 1, name: 'Ghouls killed' },
  hidden: { key: 'hidden', id: 2, name: 'Internal', public: false },
};
const ACHIEVEMENTS: Record<string, AchievementEntry> = {
  ghoul_hunter: { key: 'ghoul_hunter', id: 1, name: 'Ghoul Hunter', description: 'Kill 10 ghouls.', points: 5, requires: [{ stat: 'kills_ghoul', atLeast: 10 }] },
  road_warden: { key: 'road_warden', id: 12, points: 5, secret: true },
  old: { key: 'old', id: 3, name: 'Old', description: 'Retired.', retired: true },
};

function setup() {
  const bus = new NetEventBus(), progress = new ProgressStore();
  progress.attachBus(bus);
  return { bus, progress };
}

describe('account progress', () => {
  it('PROGRESS_STATE replaces everything; PROGRESS_UPDATE and ACHIEVEMENT_UNLOCKED change parts', () => {
    const { bus, progress } = setup();
    dispatchServerMessage(statePacket({ enabled: true, loaded: true, stats: [[1, 4]], achievements: [], secrets: [] }), bus);
    expect([progress.enabled, progress.loaded, progress.stat(1)]).toEqual([true, true, 4]);
    dispatchServerMessage(updatePacket([[1, 9], [2, 3]]), bus);
    expect([progress.stat(1), progress.stat(2)]).toEqual([9, 3]);
    dispatchServerMessage(unlockPacket(12, 1_700_000_000, 'Road Warden', 'Clear the road.'), bus);
    expect(progress.unlocked.get(12)).toBe(1_700_000_000);
    expect(progress.secrets.get(12)?.name).toBe('Road Warden');
    expect(progress.fresh.has(12)).toBe(true);
  });

  it('drops malformed and trailing messages whole', () => {
    const { bus, progress } = setup();
    const before = progress.version;
    dispatchServerMessage(statePacket({ enabled: true, loaded: true, stats: [[0, 1]], achievements: [], secrets: [] }), bus);
    dispatchServerMessage(new Uint8Array([...updatePacket([[1, 2]]), 0]), bus);
    dispatchServerMessage(updatePacket([[1, 2]]).slice(0, 5), bus);
    expect(progress.version).toBe(before);
  });

  it('the Achievements tab shows points, progress, secrets as ??? and public stats only', () => {
    const { bus, progress } = setup();
    dispatchServerMessage(statePacket({ enabled: true, loaded: true, stats: [[1, 4]], achievements: [], secrets: [] }), bus);
    let panel = renderAchievements({ progress, achievements: ACHIEVEMENTS, stats: STATS });
    expect(panel.querySelector('.dv-achievements-points')!.textContent).toBe('0 points');
    expect(panel.querySelector('.dv-achievement-progress')!.textContent).toBe('4 / 10');
    expect([...panel.querySelectorAll('.dv-achievement-name')].map((n) => n.textContent)).toEqual(['Ghoul Hunter', '???']);
    expect([...panel.querySelectorAll('.dv-stats-list dt')].map((n) => n.textContent)).toEqual(['Ghouls killed']);

    dispatchServerMessage(unlockPacket(12, 1_700_000_000, 'Road Warden', 'Clear the road for Rook.'), bus);
    panel = renderAchievements({ progress, achievements: ACHIEVEMENTS, stats: STATS });
    expect(panel.querySelector('.dv-achievements-points')!.textContent).toBe('5 points');
    expect(panel.querySelector('.dv-achievement.is-unlocked .dv-achievement-name')!.textContent).toBe('Road Warden');
    expect(panel.querySelector('.dv-achievement.is-unlocked .dv-achievement-text')!.textContent).toBe('Clear the road for Rook.');
  });

  it('guests and loading accounts get a message instead of the grid', () => {
    const { bus, progress } = setup();
    expect(renderAchievements({ progress, achievements: ACHIEVEMENTS, stats: STATS }).textContent).toContain('Log in');
    dispatchServerMessage(statePacket({ enabled: true, loaded: false, stats: [], achievements: [], secrets: [] }), bus);
    expect(renderAchievements({ progress, achievements: ACHIEVEMENTS, stats: STATS }).textContent).toContain('Loading');
  });
});
