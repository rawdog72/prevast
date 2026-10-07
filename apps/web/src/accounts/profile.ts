// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import fs from 'node:fs/promises';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import {
  validateTable,
  type StatEntry,
  type AchievementEntry,
} from '../../../../shared/typescript/content-schema';
import type { AccountProgressInfo } from '../../../../shared/typescript/account-profile';
import type { ProgressSnapshot } from './store';

/** Public startup definitions only; locked secrets and private/retired stats never leak. */
export async function accountProfile(
  root: string,
  snapshot: ProgressSnapshot,
): Promise<AccountProgressInfo> {
  const [statJson, achievementJson] = await Promise.all(
    ['stats', 'achievements'].map((name) =>
      fs.readFile(path.join(root, 'dist/content', `${name}.json`), 'utf8'),
    ),
  );
  const stats = validateTable('stats', JSON.parse(statJson!)).entries as unknown as Record<
    string,
    StatEntry
  >;
  const achievements = validateTable('achievements', JSON.parse(achievementJson!))
    .entries as unknown as Record<string, AchievementEntry>;
  const unlocked = new Map(snapshot.achievements.map((a) => [a.id, a.unlockedAt]));
  // The browser export intentionally omits secret text. Only this private,
  // authenticated projection may reveal authored text for unlocked secrets.
  if (Object.values(achievements).some((a) => a.secret && unlocked.has(a.id))) {
    const authored = new DOMParser().parseFromString(
      await fs.readFile(path.join(root, 'data/XML/achievements.xml'), 'utf8'),
      'application/xml',
    );
    for (const node of Array.from(authored.getElementsByTagName('achievement'))) {
      const entry = achievements[node.getAttribute('key') ?? ''];
      if (entry?.secret && unlocked.has(entry.id) && entry.id === Number(node.getAttribute('id'))) {
        entry.name = node.getAttribute('name') ?? undefined;
        entry.description = node.getAttribute('description') ?? undefined;
        entry.points = Number(node.getAttribute('points') || 0);
      }
    }
  }
  return {
    stats: Object.values(stats)
      .filter((s) => !s.retired && s.public !== false)
      .map((s) => ({ id: s.id, name: s.name, value: snapshot.stats[s.id] ?? 0 })),
    achievements: Object.values(achievements)
      .filter((a) => !a.retired || unlocked.has(a.id))
      .map((a) => {
        const at = unlocked.get(a.id) ?? null;
        const requirements = a.requires ?? [];
        const fraction = requirements.length
          ? Math.min(
              ...requirements.map((r) => {
                const stat = stats[r.stat];
                return Math.min(
                  1,
                  (stat ? (snapshot.stats[stat.id] ?? 0) : 0) / Math.max(1, r.atLeast),
                );
              }),
            )
          : 0;
        return {
          id: a.id,
          name: a.name || 'Secret achievement',
          description:
            a.description || (at ? 'Unlocked in game.' : 'Discover this achievement in game.'),
          points: a.points ?? 0,
          unlockedAt: at,
          progress: at !== null ? 1 : fraction,
        };
      }),
  };
}
