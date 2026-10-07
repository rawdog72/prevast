// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { accountProfile } from './profile';

it('projects private account progress without exposing hidden stats or locked secret text', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prevast-profile-'));
  try {
    await mkdir(path.join(root, 'dist/content'), { recursive: true });
    await mkdir(path.join(root, 'data/XML'), { recursive: true });
    const table = async (name: string, entries: unknown) =>
      writeFile(
        path.join(root, `dist/content/${name}.json`),
        JSON.stringify({ name, version: 1, hash: 'test', attributes: {}, entries }),
      );
    await table('stats', {
      kills: { key: 'kills', id: 1, name: 'Ghouls killed' },
      hidden: { key: 'hidden', id: 2, name: 'Private', public: false },
      old: { key: 'old', id: 3, name: 'Retired', retired: true },
    });
    await table('achievements', {
      hunter: {
        key: 'hunter',
        id: 1,
        name: 'Hunter',
        requires: [{ stat: 'kills', atLeast: 10 }],
        points: 5,
      },
      secret: { key: 'secret', id: 2, secret: true },
      another: { key: 'another', id: 3, secret: true },
      retired: { key: 'retired', id: 4, retired: true, name: 'Old award' },
      unavailable: { key: 'unavailable', id: 5, retired: true, name: 'Unavailable' },
    });
    await writeFile(
      path.join(root, 'data/XML/achievements.xml'),
      '<achievements><achievement key="secret" id="2" name="Discovered" description="Found a secret" points="10"/><achievement key="another" id="3" name="Must stay hidden" description="Hidden description" points="20"/></achievements>',
    );
    const profile = await accountProfile(root, {
      stats: { 1: 5, 2: 99, 3: 99 },
      achievements: [
        { id: 2, unlockedAt: 1000 },
        { id: 4, unlockedAt: 2000 },
      ],
    });
    expect(profile.stats).toEqual([{ id: 1, name: 'Ghouls killed', value: 5 }]);
    expect(profile.achievements.find((a) => a.id === 1)).toMatchObject({
      progress: 0.5,
      unlockedAt: null,
    });
    expect(profile.achievements.find((a) => a.id === 2)).toMatchObject({
      name: 'Discovered',
      description: 'Found a secret',
      points: 10,
      progress: 1,
    });
    expect(profile.achievements.find((a) => a.id === 3)).toMatchObject({
      name: 'Secret achievement',
      progress: 0,
      points: 0,
    });
    expect(profile.achievements.map((a) => a.id)).toEqual([1, 2, 3, 4]);
    expect(JSON.stringify(profile)).not.toContain('Must stay hidden');
  } finally {
    await rm(root, { recursive: true });
  }
});
