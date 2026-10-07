// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { AccountDashboard } from './account-dashboard';
import { accountControlsStub } from './account-test-utils';
import type { AccountApi } from './account-api';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('account dashboard', () => {
  it('renders persisted progress safely and revokes a chosen session', async () => {
    const api = {
      ...accountControlsStub(),
      progress: vi.fn(async () => ({
        stats: [{ id: 1, name: 'Ghouls killed', value: 25 }],
        achievements: [
          {
            id: 1,
            name: '<img onerror=alert(1)>',
            description: 'Kill ten ghouls',
            points: 5,
            unlockedAt: 1000,
            progress: 1,
          },
        ],
      })),
      sessions: vi.fn(async () => [
        {
          id: 'remote',
          device: 'Firefox on Windows',
          createdAt: 10,
          lastUsedAt: 20,
          expiresAt: 50000,
          current: false,
        },
      ]),
    } as unknown as AccountApi;
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const signedOut = vi.fn();
    const dashboard = new AccountDashboard(root, api, signedOut);
    await dashboard.show(1);
    expect(root.textContent).toContain('25');
    expect(root.textContent).toContain('1 / 1 achievements');
    expect(root.querySelector('img')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-sessions] button')!.click();
    await flush();
    expect(api.revokeSession).toHaveBeenCalledWith('remote');
    expect(signedOut).not.toHaveBeenCalled();
  });

  it('clears one-time recovery codes and ignores a result received after the account view closes', async () => {
    let resolve!: (value: string) => void;
    const api = {
      ...accountControlsStub(),
      recoveryCode: vi.fn(
        () =>
          new Promise<string>((r) => {
            resolve = r;
          }),
      ),
    } as unknown as AccountApi;
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const dashboard = new AccountDashboard(root, api, vi.fn());
    await dashboard.show(1);
    root.querySelector<HTMLInputElement>('[data-password]')!.value = 'password1';
    root.querySelector<HTMLButtonElement>('[data-code]')!.click();
    dashboard.clear();
    resolve('private-recovery-code');
    await flush();
    expect(root.querySelector<HTMLTextAreaElement>('[data-code-value]')!.value).toBe('');
    expect(root.hidden).toBe(true);
  });
});
