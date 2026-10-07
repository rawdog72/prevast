// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRecovery } from './account-recovery';
import { accountControlsStub } from './account-test-utils';
import type { AccountApi } from './account-api';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, '', '/');
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});
describe('account recovery UI', () => {
  it('removes email tokens from history and only verifies after the player confirms', async () => {
    const api = accountControlsStub() as AccountApi;
    const token = 'A'.repeat(43);
    history.replaceState(null, '', `/#account-verify=${token}`);
    const changed = vi.fn();
    new AccountRecovery(document, api, changed).readLink();
    expect(location.hash).toBe('');
    expect(api.confirmEmail).not.toHaveBeenCalled();
    document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(api.confirmEmail).toHaveBeenCalledWith(token);
    expect(changed).toHaveBeenCalledOnce();
  });

  it('requires matching passwords when using a recovery code and clears secrets after success', async () => {
    const api = accountControlsStub() as AccountApi;
    new AccountRecovery(document, api, vi.fn()).open('code');
    const set = (name: string, value: string) => {
      document.querySelector<HTMLInputElement>(`input[name=${name}]`)!.value = value;
    };
    set('name', 'Alice');
    set('code', 'private-code');
    set('next', 'new-password');
    set('confirm', 'different-password');
    const form = document.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(api.resetPassword).not.toHaveBeenCalled();
    set('confirm', 'new-password');
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(api.resetPassword).toHaveBeenCalledWith({
      name: 'Alice',
      code: 'private-code',
      next: 'new-password',
    });
    expect(document.querySelector<HTMLInputElement>('input[name=code]')!.value).toBe('');
  });
});
