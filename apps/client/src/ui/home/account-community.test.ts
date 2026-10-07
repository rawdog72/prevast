// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { AccountCommunityPanel, CommunityRankings, mountPublicRankings } from './account-community';
import type { AccountCommunityApi } from './account-api';
import type { CommunityProfile } from '../../../../../shared/typescript/account-community';
import { readFileSync } from 'node:fs';
const flush = () => new Promise((r) => setTimeout(r, 0));
const profile: CommunityProfile = {
  accountId: 1,
  name: 'Alice',
  completedRuns: 1,
  totalFinalScore: 99000,
  averageScore: 99000,
  bestScore: 99000,
  recentRuns: [],
  wallet: 9,
  transactions: [],
  clan: null,
  invitations: [],
  canJoinAt: 0,
  rules: { scorePerGoldenCap: 10000, clanCreationCost: 5, averageLeaderboardMinimumRuns: 10 },
};
const stub = () =>
  ({
    profile: vi.fn(async () => profile),
    command: vi.fn(async () => ({ clanId: 1 })),
    rankings: vi.fn(async () => ({
      season: '2026-10',
      metric: 'score',
      nextResetAt: 0,
      players: [],
      clans: [],
      nextOffset: null,
    })),
    roster: vi.fn(),
    clan: vi.fn(),
    player: vi.fn(),
  }) as unknown as AccountCommunityApi;
describe('account community screens', () => {
  it('shows guest leaderboards in player-then-clan order and retries a failed request', async () => {
    const html = readFileSync('apps/client/public/index.html', 'utf8');
    document.body.innerHTML = html
      .slice(html.indexOf('<body'), html.indexOf('</body>'))
      .replace(/^<body[^>]*>/, '');
    const api = stub();
    vi.mocked(api.rankings).mockRejectedValueOnce(new Error('offline'));
    const rankings = mountPublicRankings(document, api);
    await rankings.refresh();
    const sidebar = document.getElementById('dv-home-rankings')!;
    expect(sidebar.hidden).toBe(false);
    expect([...sidebar.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
      'Player leaderboard',
      'Clan leaderboard',
    ]);
    const retry = sidebar.querySelector<HTMLButtonElement>('[data-home-rankings-retry]')!;
    expect(retry.hidden).toBe(false);
    retry.click();
    await flush();
    expect(retry.hidden).toBe(true);
    expect(sidebar.textContent).toContain('No ranked players yet');
    expect(sidebar.textContent).toContain('No ranked clans yet');
    await rankings.refresh();
    expect(api.rankings).toHaveBeenCalledTimes(2);
    expect(api.profile).not.toHaveBeenCalled();
  });

  it('keeps clan actions on their own pages and preserves the selected page after a command', async () => {
    const root = document.createElement('div'),
      api = stub();
    vi.mocked(api.profile).mockResolvedValue({
      ...profile,
      clan: {
        id: 1,
        name: 'Wolves',
        tag: 'WOLF',
        rank: 1,
        role: 'owner',
        members: 2,
        contributors: 2,
        score: 100,
        average: 50,
        yourContribution: 50,
        roster: [{ id: 2, name: 'Bob', role: 'member', joinedAt: 1, contribution: 50 }],
        nextOffset: null,
        audit: [],
        trophies: [],
      },
    });
    const panel = new AccountCommunityPanel(root, api);
    await panel.show();
    const settings = root.querySelector<HTMLButtonElement>('[data-page="settings"]')!;
    settings.click();
    expect(root.querySelector<HTMLElement>('#dv-clan-page-members')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#dv-clan-page-settings')!.hidden).toBe(false);
    const tag = root.querySelector<HTMLInputElement>('#dv-clan-page-settings input')!;
    tag.value = 'WOLF';
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Disband clan')!.click();
    await flush();
    expect(api.command).toHaveBeenCalledWith({ action: 'disband', confirmTag: 'WOLF' });
    expect(root.querySelector<HTMLElement>('#dv-clan-page-settings')!.hidden).toBe(false);
  });

  it('reuses a creation receipt after a lost response and renders server text safely', async () => {
    const root = document.createElement('div'),
      api = stub();
    vi.mocked(api.command)
      .mockRejectedValueOnce(new Error('Response lost'))
      .mockResolvedValueOnce({ clanId: 1 });
    const panel = new AccountCommunityPanel(root, api);
    await panel.show();
    const [name, tag] = root.querySelectorAll('input');
    name!.value = 'Wolves';
    tag!.value = 'WOLF';
    const create = () =>
      [...root.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Create clan'))!;
    create().click();
    await flush();
    expect(root.textContent).toContain('Response lost');
    create().click();
    await flush();
    expect(vi.mocked(api.command).mock.calls[0]![0]).toEqual(
      vi.mocked(api.command).mock.calls[1]![0],
    );
    expect(root.textContent).toContain('9 golden caps');
    vi.mocked(api.profile).mockResolvedValue({
      ...profile,
      invitations: [{ clanId: 9, name: '<img src=x>', tag: 'IMG' }],
    });
    await panel.show();
    expect(root.querySelector('img')).toBeNull();
  });
  it('discards late private data after account logout', async () => {
    const root = document.createElement('div'),
      api = stub();
    let resolve!: (p: CommunityProfile) => void;
    vi.mocked(api.profile).mockReturnValue(new Promise((r) => (resolve = r)));
    const panel = new AccountCommunityPanel(root, api),
      pending = panel.show();
    panel.clear();
    resolve(profile);
    await pending;
    expect(root.textContent).toBe('');
  });
  it('shows both clan size and contributor averages, and mounts the public entry point', async () => {
    const root = document.createElement('div'),
      api = stub();
    vi.mocked(api.rankings).mockResolvedValue({
      season: '2026-10',
      metric: 'score',
      nextResetAt: 0,
      players: [],
      clans: [
        {
          id: 1,
          rank: 1,
          name: 'Wolves',
          tag: 'WOLF',
          score: 120000,
          members: 100,
          contributors: 2,
          average: 60000,
        },
      ],
      nextOffset: null,
    });
    new CommunityRankings(root, api).mount();
    await flush();
    expect(root.textContent).toContain('Average per player');
    expect(root.textContent).toContain('60,000');
    expect(root.textContent).toContain('100');
    document.body.innerHTML =
      '<main id="prevast-home"><footer class="dv-footer"><nav></nav></footer></main>';
    mountPublicRankings(document, api);
    expect(document.querySelector('nav button')?.textContent).toBe('Player & clan rankings');
    expect(document.querySelector('dialog')).not.toBeNull();
  });
});
