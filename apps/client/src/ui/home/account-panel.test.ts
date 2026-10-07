// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountApiError, type AccountApi, type AccountInfo } from './account-api';
import { AccountPanel, avatarHue, SESSION_EXPIRED, type AccountState } from './account-panel';
import { accountControlsStub } from './account-test-utils';

const html = readFileSync(path.resolve(process.cwd(), 'apps/client/public/index.html'), 'utf8');
const bodyMarkup = html
  .slice(html.indexOf('<body'), html.indexOf('</body>'))
  .replace(/^<body[^>]*>/, '');
const alice: AccountInfo = { id: 1, name: 'Alice', groupId: 1, createdAt: Date.UTC(2026, 8, 1) };
const flush = () => new Promise((r) => setTimeout(r, 0));
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const accountView = () => $<HTMLElement>('#dv-account-view');
const isOpen = () => !accountView().hidden;
const alert = () => $<HTMLElement>('[data-auth-alert]');
const errorOf = (id: string) => $<HTMLElement>(`#${id}-error`);

function api(overrides: Partial<AccountApi> = {}): AccountApi {
  return {
    ...accountControlsStub(),
    me: vi.fn(async () => ({ enabled: true })),
    register: vi.fn(async () => alice),
    login: vi.fn(async () => alice),
    logout: vi.fn(async () => {}),
    changePassword: vi.fn(async () => {}),
    ticket: vi.fn(async () => 'T'),
    ...overrides,
  };
}

async function build(a: AccountApi, refresh = true) {
  document.body.innerHTML = bodyMarkup;
  const states: AccountState[] = [];
  const panel = new AccountPanel(document, a, (s) => states.push(s));
  panel.mount();
  if (refresh) await panel.refresh();
  return { panel, states };
}

function fill(values: Record<string, string>): void {
  for (const [id, value] of Object.entries(values)) {
    const input = $<HTMLInputElement>(`#${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
}

function submit(view: string): void {
  $<HTMLFormElement>(`form[data-account-form="${view}"]`).dispatchEvent(
    new Event('submit', { cancelable: true }),
  );
}

describe('AccountPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('opens a wide workspace, navigates to security by keyboard and restores the play layout', async () => {
    const { panel } = await build(
      api({ me: vi.fn(async () => ({ enabled: true, account: alice })) }),
    );
    panel.open('manage');
    await flush();
    expect($('.dv-home-layout').classList.contains('is-managing')).toBe(true);
    expect($('[data-dashboard-page="overview"]').hidden).toBe(false);
    expect($('[data-dashboard-page="security"]').hidden).toBe(true);
    $('#dv-account-tab-overview').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    );
    expect(document.activeElement?.id).toBe('dv-account-tab-security');
    expect($('[data-dashboard-page="security"]').hidden).toBe(false);
    expect($<HTMLDetailsElement>('[data-account-security]').open).toBe(true);
    expect($('[data-dashboard-page="overview"]').hidden).toBe(true);
    panel.close();
    expect($('.dv-home-layout').classList.contains('is-managing')).toBe(false);
    expect($('#dv-play-view').hidden).toBe(false);
    panel.open('manage');
    expect($('[data-dashboard-page="overview"]').hidden).toBe(false);
  });

  it('keeps the account signed in and shows a retryable error when logout fails', async () => {
    const { panel } = await build(
      api({
        me: vi.fn(async () => ({ enabled: true, account: alice })),
        logout: vi.fn(async () => {
          throw new Error('Network unavailable.');
        }),
      }),
    );
    panel.open('manage');
    $<HTMLButtonElement>('[data-account-logout]').click();
    await flush();
    expect(panel.state.account).toEqual(alice);
    expect(isOpen()).toBe(true);
    expect(alert().textContent).toContain('Sign out failed');
    expect($<HTMLButtonElement>('[data-account-logout]').disabled).toBe(false);
  });

  it('sends the chosen remembered-login preference', async () => {
    const a = api();
    await build(a);
    $<HTMLButtonElement>('[data-account-login]').click();
    fill({ 'dv-login-name': 'Alice', 'dv-login-password': 'password1' });
    $<HTMLInputElement>('#dv-form-login input[name=remember]').checked = false;
    submit('login');
    await flush();
    expect(a.login).toHaveBeenCalledWith('Alice', 'password1', false);
  });

  it('shows a placeholder until the host answers, hides disabled accounts and keeps sign-in available on network errors', async () => {
    const { panel } = await build(api({ me: vi.fn(async () => ({ enabled: false })) }), false);
    expect($('#dv-account').hidden).toBe(false);
    expect($('[data-account-loading]').hidden).toBe(false);
    await panel.refresh();
    expect($('#dv-account').hidden).toBe(true);
    await build(api({ me: vi.fn(async () => Promise.reject(new Error('down'))) }));
    expect($('#dv-account').hidden).toBe(false);
    expect($('#dv-account-notice').textContent).toContain('could not be refreshed');
  });

  it('preserves the signed-in identity on a failed refresh and clears the dashboard when the session expires', async () => {
    const me = vi
      .fn<AccountApi['me']>()
      .mockResolvedValueOnce({ enabled: true, account: alice })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ enabled: true });
    const { panel } = await build(api({ me }));
    panel.open('manage');
    await flush();
    await panel.refresh();
    expect(panel.state.account).toEqual(alice);
    expect(panel.openView).toBe('manage');
    await panel.refresh();
    expect(panel.state.account).toBeNull();
    expect(panel.openView).toBeNull();
    expect($('[data-progress]').textContent).toBe('');
    expect($('[data-sessions]').textContent).toBe('');
  });

  it('ignores an old refresh response after signing out', async () => {
    let resolve!: (value: Awaited<ReturnType<AccountApi['me']>>) => void;
    const me = vi
      .fn<AccountApi['me']>()
      .mockResolvedValueOnce({ enabled: true, account: alice })
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
    const { panel } = await build(api({ me }));
    panel.open('manage');
    const pending = panel.refresh();
    $<HTMLButtonElement>('[data-account-logout]').click();
    await flush();
    resolve({ enabled: true, account: alice });
    await pending;
    expect(panel.state.account).toBeNull();
  });

  it('signs in within the start card and reports the account', async () => {
    const a = api();
    const { states } = await build(a);
    expect($('[data-account-out]').hidden).toBe(false);
    $<HTMLButtonElement>('[data-account-login]').click();
    expect(isOpen()).toBe(true);
    expect($('form[data-account-form="login"]').hidden).toBe(false);
    expect(document.activeElement?.id).toBe('dv-login-name');
    fill({ 'dv-login-name': ' Alice ', 'dv-login-password': 'password1' });
    submit('login');
    await flush();
    expect(a.login).toHaveBeenCalledWith('Alice', 'password1', true);
    expect(states.at(-1)).toEqual({ enabled: true, account: alice, playAsAccount: true });
    expect(isOpen()).toBe(false);
    expect($('[data-account-in]').hidden).toBe(false);
    expect($('[data-account-name]').textContent).toBe('Alice');
    expect($('[data-account-role]').textContent).toMatch(/^Player · since /);
    expect($('#dv-account-notice').textContent).toBe('Signed in as Alice.');
    expect($<HTMLInputElement>('#dv-login-password').value).toBe('');
  });

  it('checks empty fields before calling the host', async () => {
    const a = api();
    await build(a);
    $<HTMLButtonElement>('[data-account-login]').click();
    submit('login');
    await flush();
    expect(a.login).not.toHaveBeenCalled();
    expect(errorOf('dv-login-name').hidden).toBe(false);
    expect(errorOf('dv-login-password').textContent).toBe('Enter your password.');
    expect(document.activeElement?.id).toBe('dv-login-name');
    // Fixing a flagged field clears its message as you type.
    fill({ 'dv-login-name': 'Alice' });
    expect(errorOf('dv-login-name').hidden).toBe(true);
  });

  it('keeps the sign-in view open on a wrong password, clears it and says why', async () => {
    const a = api({
      login: vi.fn(async () => Promise.reject(new AccountApiError(401, 'Wrong name or password.'))),
    });
    const { states } = await build(a);
    $<HTMLButtonElement>('[data-account-login]').click();
    fill({ 'dv-login-name': 'Alice', 'dv-login-password': 'nope-nope' });
    submit('login');
    await flush();
    expect(isOpen()).toBe(true);
    expect(alert().hidden).toBe(false);
    expect(alert().textContent).toBe('Wrong name or password.');
    expect($<HTMLInputElement>('#dv-login-password').value).toBe('');
    expect($<HTMLInputElement>('#dv-login-name').value).toBe('Alice');
    expect(document.activeElement?.id).toBe('dv-login-password');
    expect($<HTMLFieldSetElement>('#dv-form-login fieldset').disabled).toBe(false);
    expect(states.at(-1)?.account).toBeNull();
  });

  it('disables the form while signing in and refuses to close or submit twice', async () => {
    let finish!: (a: AccountInfo) => void;
    const a = api({ login: vi.fn(() => new Promise<AccountInfo>((r) => (finish = r))) });
    await build(a);
    $<HTMLButtonElement>('[data-account-login]').click();
    fill({ 'dv-login-name': 'Alice', 'dv-login-password': 'password1' });
    submit('login');
    submit('login');
    expect(a.login).toHaveBeenCalledTimes(1);
    expect($<HTMLFieldSetElement>('#dv-form-login fieldset').disabled).toBe(true);
    expect($('#dv-form-login [data-label]').textContent).toBe('Signing in…');
    expect($<HTMLButtonElement>('#dv-tab-register').disabled).toBe(true);
    $<HTMLButtonElement>('#dv-tab-register').click();
    submit('register');
    expect(a.register).not.toHaveBeenCalled();
    expect($('form[data-account-form="login"]').hidden).toBe(false);
    const cancel = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    accountView().dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    $<HTMLButtonElement>('[data-auth-close]').click();
    expect(isOpen()).toBe(true);
    finish(alice);
    await flush();
    expect(isOpen()).toBe(false);
    expect($('#dv-form-login [data-label]').textContent).toBe('Sign in');
    expect($<HTMLButtonElement>('#dv-tab-register').disabled).toBe(false);
  });

  it('replaces the play view, ignores outside clicks and restores focus and setup on return', async () => {
    const { panel } = await build(api());
    $('#prevast-home').hidden = false;
    fill({ nicknameInput: 'Wanderer', 'dv-address': 'localhost:8172' });
    const trigger = $<HTMLButtonElement>('[data-account-register]');
    trigger.focus();
    trigger.click();
    expect(panel.openView).toBe('register');
    expect(accountView().closest('#dv-start-window')).not.toBeNull();
    expect($('#dv-play-view').hidden).toBe(true);
    fill({ 'dv-register-name': 'Alice', 'dv-register-password': 'hunter22' });
    $('#prevast-home').click();
    expect(isOpen()).toBe(true);
    accountView().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(isOpen()).toBe(false);
    expect($('#dv-play-view').hidden).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect($<HTMLInputElement>('#nicknameInput').value).toBe('Wanderer');
    expect($<HTMLInputElement>('#dv-address').value).toBe('localhost:8172');
    expect($<HTMLInputElement>('#dv-register-password').value).toBe('');
    expect($<HTMLInputElement>('#dv-register-name').value).toBe('Alice');
  });

  it('checks the host rules while registering and shows a taken name on the field', async () => {
    const a = api({
      register: vi.fn(async () => Promise.reject(new AccountApiError(409, 'That name is taken.'))),
    });
    await build(a);
    $<HTMLButtonElement>('[data-account-register]').click();
    fill({
      'dv-register-name': '12',
      'dv-register-password': 'short',
      'dv-register-confirm': 'other',
      'dv-register-email': 'nope',
    });
    submit('register');
    await flush();
    expect(a.register).not.toHaveBeenCalled();
    expect(errorOf('dv-register-name').textContent).toMatch(/3-16 characters/);
    expect(errorOf('dv-register-password').textContent).toMatch(/at least 8/);
    expect(errorOf('dv-register-confirm').textContent).toBe('The passwords do not match.');
    expect(errorOf('dv-register-email').textContent).toMatch(/email/);

    fill({
      'dv-register-name': 'Alice',
      'dv-register-password': 'password1',
      'dv-register-confirm': 'password1',
      'dv-register-email': '',
    });
    expect(errorOf('dv-register-confirm').hidden).toBe(true);
    submit('register');
    await flush();
    expect(a.register).toHaveBeenCalledWith('Alice', 'password1', '', true);
    expect(errorOf('dv-register-name').textContent).toBe('That name is taken.');
    expect($<HTMLInputElement>('#dv-register-name').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement?.id).toBe('dv-register-name');
    expect(isOpen()).toBe(true);
  });

  it('re-checks the confirmation when the password changes', async () => {
    await build(api());
    $<HTMLButtonElement>('[data-account-register]').click();
    fill({ 'dv-register-password': 'password1', 'dv-register-confirm': 'password1' });
    $('#dv-register-confirm').dispatchEvent(new Event('blur'));
    expect(errorOf('dv-register-confirm').hidden).toBe(true);
    fill({ 'dv-register-password': 'password2' });
    expect(errorOf('dv-register-confirm').textContent).toBe('The passwords do not match.');
  });

  it('registers, welcomes the player and signs them in', async () => {
    const a = api();
    const { states } = await build(a);
    $<HTMLButtonElement>('[data-account-register]').click();
    fill({
      'dv-register-name': 'Alice',
      'dv-register-password': 'password1',
      'dv-register-confirm': 'password1',
      'dv-register-email': ' a@b.c ',
    });
    submit('register');
    await flush();
    expect(a.register).toHaveBeenCalledWith('Alice', 'password1', 'a@b.c', true);
    expect(states.at(-1)?.account).toEqual(alice);
    expect($('#dv-account-notice').textContent).toMatch(/Welcome, Alice/);
    expect($<HTMLInputElement>('#dv-register-name').value).toBe('');
  });

  it('switches tabs, carrying the name and clearing messages', async () => {
    await build(api());
    $<HTMLButtonElement>('[data-account-login]').click();
    fill({ 'dv-login-name': 'Alice' });
    submit('login');
    await flush();
    expect(errorOf('dv-login-password').hidden).toBe(false);
    $<HTMLButtonElement>('#dv-tab-register').click();
    expect($('form[data-account-form="register"]').hidden).toBe(false);
    expect($('form[data-account-form="login"]').hidden).toBe(true);
    expect($('#dv-tab-register').getAttribute('aria-selected')).toBe('true');
    expect($('[data-auth-title]').textContent).toBe('Create your account');
    expect($<HTMLInputElement>('#dv-register-name').value).toBe('Alice');
    expect(document.activeElement?.id).toBe('dv-register-password');
    $<HTMLButtonElement>('#dv-tab-login').click();
    expect(errorOf('dv-login-password').hidden).toBe(true);
  });

  it('shows and hides a password', async () => {
    await build(api());
    $<HTMLButtonElement>('[data-account-login]').click();
    const input = $<HTMLInputElement>('#dv-login-password');
    const reveal = $<HTMLButtonElement>('#dv-form-login [data-reveal]');
    reveal.click();
    expect(input.type).toBe('text');
    expect(reveal.getAttribute('aria-pressed')).toBe('true');
    fill({ 'dv-login-password': 'visible1' });
    $<HTMLButtonElement>('[data-auth-close]').click();
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
  });

  it('changes the password and handles a wrong current password', async () => {
    const changePassword = vi
      .fn<AccountApi['changePassword']>()
      .mockRejectedValueOnce(new AccountApiError(403, 'Current password is wrong.'))
      .mockResolvedValueOnce(undefined);
    await build(
      api({ me: vi.fn(async () => ({ enabled: true, account: alice })), changePassword }),
    );
    $<HTMLButtonElement>('[data-account-manage]').click();
    expect($('[data-account-field="name"]').textContent).toBe('Alice');
    expect($('[data-account-field="group"]').textContent).toBe('Player');
    expect($('[role="tablist"]').hidden).toBe(true);
    expect($<HTMLDetailsElement>('[data-account-security]').open).toBe(false);
    expect(document.activeElement?.id).toBe('dv-auth-title');
    $<HTMLElement>('[data-account-security] summary').click();
    fill({
      'dv-manage-current': 'old-password',
      'dv-manage-next': 'old-password',
      'dv-manage-confirm': 'old-password',
    });
    submit('manage');
    await flush();
    expect(changePassword).not.toHaveBeenCalled();
    expect(errorOf('dv-manage-next').textContent).toMatch(/different/);

    fill({ 'dv-manage-next': 'new-password', 'dv-manage-confirm': 'new-password' });
    submit('manage');
    await flush();
    expect(errorOf('dv-manage-current').textContent).toBe('Current password is wrong.');
    expect($<HTMLInputElement>('#dv-manage-current').value).toBe('');

    fill({ 'dv-manage-current': 'right-password' });
    submit('manage');
    await flush();
    expect(changePassword).toHaveBeenLastCalledWith('right-password', 'new-password');
    expect(alert().dataset['tone']).toBe('success');
    expect($<HTMLInputElement>('#dv-manage-next').value).toBe('');
    expect(isOpen()).toBe(true);
    expect($<HTMLDetailsElement>('[data-account-security]').open).toBe(false);
    expect(document.activeElement).toBe($('[data-account-security] summary'));
  });

  it('keeps sign-out and password updates mutually exclusive', async () => {
    let finish!: () => void;
    const a = api({
      me: vi.fn(async () => ({ enabled: true, account: alice })),
      changePassword: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const { panel } = await build(a);
    panel.open('manage');
    $<HTMLElement>('[data-account-security] summary').click();
    fill({
      'dv-manage-current': 'old-password',
      'dv-manage-next': 'new-password',
      'dv-manage-confirm': 'new-password',
    });
    submit('manage');
    expect($<HTMLButtonElement>('[data-account-logout]').disabled).toBe(true);
    $<HTMLButtonElement>('[data-account-logout]').click();
    $<HTMLElement>('[data-account-security] summary').click();
    panel.close();
    expect($<HTMLDetailsElement>('[data-account-security]').open).toBe(true);
    expect(panel.openView).toBe('manage');
    expect(a.logout).not.toHaveBeenCalled();
    finish();
    await flush();
    expect($<HTMLButtonElement>('[data-account-logout]').disabled).toBe(false);
  });

  it('signs out locally when the host has forgotten the session', async () => {
    const { states } = await build(
      api({
        me: vi.fn(async () => ({ enabled: true, account: alice })),
        changePassword: vi.fn(async () =>
          Promise.reject(new AccountApiError(401, 'Log in first.')),
        ),
      }),
    );
    $<HTMLButtonElement>('[data-account-manage]').click();
    $<HTMLElement>('[data-account-security] summary').click();
    fill({
      'dv-manage-current': 'old-password',
      'dv-manage-next': 'new-password',
      'dv-manage-confirm': 'new-password',
    });
    submit('manage');
    await flush();
    expect(states.at(-1)?.account).toBeNull();
    expect(isOpen()).toBe(false);
    expect($('#dv-account-notice').textContent).toBe(SESSION_EXPIRED);
    expect($('#dv-account-notice').dataset['tone']).toBe('warn');
  });

  it('switches between playing as the account and as a guest, and signs out', async () => {
    const a = api({ me: vi.fn(async () => ({ enabled: true, account: alice })) });
    const { states } = await build(a);
    expect($<HTMLInputElement>('#dv-play-as-account').checked).toBe(true);
    const guest = $<HTMLInputElement>('#dv-play-as-guest');
    guest.checked = true;
    guest.dispatchEvent(new Event('change'));
    expect(states.at(-1)!.playAsAccount).toBe(false);
    $<HTMLButtonElement>('[data-account-manage]').click();
    $<HTMLButtonElement>('[data-account-logout]').click();
    await flush();
    expect(a.logout).toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ enabled: true, account: null, playAsAccount: true });
    expect(isOpen()).toBe(false);
    expect($('[data-account-out]').hidden).toBe(false);
  });

  it('ignores the account buttons while the start screen is connecting', async () => {
    const { panel } = await build(api());
    panel.setLocked(true);
    expect($<HTMLButtonElement>('[data-account-login]').disabled).toBe(true);
    panel.open('login');
    expect(isOpen()).toBe(false);
    panel.setLocked(false);
    panel.open('login');
    expect(isOpen()).toBe(true);
  });

  it('gives each name its own avatar colour', () => {
    expect(avatarHue('Alice')).toBe(avatarHue('alice'));
    expect(avatarHue('Alice')).not.toBe(avatarHue('Bob'));
  });
});
