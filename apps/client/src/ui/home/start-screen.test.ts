// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { accountControlsStub } from './account-test-utils';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListedServer } from '../../../../../shared/typescript/server-list';
import { StartScreen, type JoinRequest, type StartScreenOptions } from './start-screen';

const html = readFileSync(path.resolve(process.cwd(), 'apps/client/public/index.html'), 'utf8');
const bodyMarkup = html
  .slice(html.indexOf('<body'), html.indexOf('</body>'))
  .replace(/^<body[^>]*>/, '');

const server = (extra: Partial<ListedServer>): ListedServer => ({
  id: 'x',
  name: 'Local',
  type: 'survival',
  location: '',
  host: '127.0.0.1',
  port: 7172,
  tls: false,
  statusPort: 7171,
  players: 2,
  max: 40,
  mapX: 0,
  mapY: 0,
  state: 'open',
  ...extra,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const screens: StartScreen[] = [];
function trackScreen(options: StartScreenOptions): StartScreen {
  const screen = new StartScreen(options);
  screens.push(screen);
  return screen;
}

class ListingStream extends EventTarget {
  close = vi.fn();
  snapshot(servers: ListedServer[]): void {
    this.dispatchEvent(new MessageEvent('servers', { data: JSON.stringify(servers) }));
  }
}

function build(
  list: ListedServer[],
  ping = vi.fn(async () => ({ rttMs: 12 })),
  extra: Partial<StartScreenOptions> = {},
) {
  document.body.innerHTML = bodyMarkup;
  const onJoin = vi.fn<(r: JoinRequest) => void>();
  const screen = trackScreen({ document, onJoin, fetchList: async () => list, ping, ...extra });
  return { screen, onJoin, ping };
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;

describe('StartScreen', () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });
  afterEach(() => {
    for (const screen of screens.splice(0)) screen.hide();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('shows the list, selects the first open server and enables Play', async () => {
    const { screen } = build([
      server({ id: 'a', state: 'closed', name: 'Closed' }),
      server({ id: 'b', port: 7173, name: 'Open' }),
    ]);
    screen.show();
    await flush();
    const options = [...$('#servers').querySelectorAll('option')];
    expect(options.map((o) => o.textContent)).toEqual([
      'Closed  -  2/40 players  -  12 ms  (closed)',
      'Open  -  2/40 players  -  12 ms',
    ]);
    expect(options[0].disabled).toBe(true);
    expect($<HTMLSelectElement>('#servers').value).toBe('127.0.0.1:7173');
    expect($<HTMLButtonElement>('.dv-play').disabled).toBe(false);
    expect($('#prevast-home').hidden).toBe(false);
  });

  it('disables Play and explains when the mode has no servers', async () => {
    const { screen } = build([server({})]);
    screen.show();
    await flush();
    $<HTMLSelectElement>('#dv-mode').value = 'ghoul';
    $('#dv-mode').dispatchEvent(new Event('change'));
    expect($<HTMLButtonElement>('.dv-play').disabled).toBe(true);
    expect($('.dv-status').textContent).toBe('No servers available.');
  });

  it('changes modes through the picker without submitting and locks both pickers during a join', async () => {
    const { screen, onJoin } = build([server({})]);
    screen.show();
    await flush();
    $('#dv-mode-trigger').click();
    const custom = [
      ...document.querySelectorAll<HTMLElement>('#dv-mode-listbox [role="option"]'),
    ].find((option) => option.textContent?.includes('Custom server'))!;
    custom.click();
    expect(screen.mode).toBe('custom');
    expect($('[data-custom]').hidden).toBe(false);
    expect($('[data-listed]').inert).toBe(true);
    expect(onJoin).not.toHaveBeenCalled();
    screen.setBusy(true);
    expect($<HTMLButtonElement>('#dv-mode-trigger').disabled).toBe(true);
    expect($<HTMLButtonElement>('#servers-trigger').disabled).toBe(true);
    expect($('#dv-mode-trigger').getAttribute('aria-expanded')).toBe('false');
    screen.endJoin();
    expect($<HTMLButtonElement>('#dv-mode-trigger').disabled).toBe(false);
  });

  it('keeps an open server picker stable during stream updates and blocks removed servers', async () => {
    vi.useFakeTimers();
    const stream = new ListingStream();
    const { screen, onJoin } = build([server({})], undefined, { createEventSource: () => stream });
    screen.show();
    await vi.advanceTimersByTimeAsync(0);
    $('#servers-trigger').click();
    const row = $('#servers-listbox [role="option"]');
    stream.snapshot([server({ players: 10 }), server({ port: 7173, name: 'Second' })]);
    await vi.advanceTimersByTimeAsync(6000);
    expect($('#servers-listbox [role="option"]')).toBe(row);
    expect(row.textContent).toContain('10/40 players');
    expect(document.querySelectorAll('#servers-listbox [role="option"]')).toHaveLength(1);
    stream.snapshot([server({ port: 7173, name: 'Second' })]);
    expect(row.getAttribute('aria-disabled')).toBe('true');
    row.click();
    expect(onJoin).not.toHaveBeenCalled();
    $('#servers-trigger').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect($('#servers-trigger').textContent).toContain('Second');
    expect($('#servers-trigger').getAttribute('aria-expanded')).toBe('false');
  });

  it('submits the selected server, remembers it and the nickname, and goes busy', async () => {
    const { screen, onJoin } = build([server({})]);
    screen.show();
    await flush();
    $<HTMLInputElement>('#nicknameInput').value = 'Survivor';
    $<HTMLInputElement>('#passwordInput').value = 'pw';
    $('form.dv-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onJoin).toHaveBeenCalledWith({
      nickname: 'Survivor',
      password: 'pw',
      address: { host: '127.0.0.1', port: 7172, tls: false },
      server: server({}),
      playAsAccount: false,
    });
    expect(window.localStorage.getItem('lastServer')).toBe('127.0.0.1:7172');
    expect(window.localStorage.getItem('nickname')).toBe('Survivor');
    expect($('.dv-play').textContent).toBe('Cancel');
    expect($<HTMLInputElement>('#nicknameInput').disabled).toBe(true);
    // A second press while busy is Cancel, not a second join.
    $('form.dv-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onJoin).toHaveBeenCalledTimes(1);
    // An error releases the form and shows the message.
    screen.error('Could not connect.');
    expect($('.dv-status').textContent).toBe('Could not connect.');
    expect($<HTMLButtonElement>('.dv-play').disabled).toBe(false);
  });

  it('joins a custom address, and reports parse errors in the status line', async () => {
    const { screen, onJoin } = build([]);
    screen.show();
    await flush();
    $<HTMLSelectElement>('#dv-mode').value = 'custom';
    $('#dv-mode').dispatchEvent(new Event('change'));
    expect($('[data-custom]').hidden).toBe(false);
    expect($('[data-listed]').hidden).toBe(true);
    $<HTMLInputElement>('#dv-address').value = 'host:7172/path';
    $('form.dv-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onJoin).not.toHaveBeenCalled();
    expect($('.dv-status').textContent).toMatch(/without a path/);
    $<HTMLInputElement>('#dv-address').value = 'wss://play.example:4433';
    $('form.dv-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onJoin).toHaveBeenCalledWith(
      expect.objectContaining({
        address: { host: 'play.example', port: 4433, tls: true },
        server: null,
      }),
    );
  });

  it('restores the remembered server and nickname', async () => {
    window.localStorage.setItem('lastServer', '127.0.0.1:7173');
    window.localStorage.setItem('nickname', 'Back');
    const { screen } = build([server({ id: 'a' }), server({ id: 'b', port: 7173 })]);
    screen.show();
    await flush();
    expect($<HTMLSelectElement>('#servers').value).toBe('127.0.0.1:7173');
    expect($<HTMLInputElement>('#nicknameInput').value).toBe('Back');
  });

  it('fetches in the background but defers dropdown replacement while the player is interacting', async () => {
    vi.useFakeTimers();
    let list = [server({})];
    const fetchList = vi.fn(async () => list);
    document.body.innerHTML = bodyMarkup;
    const screen = trackScreen({
      document,
      onJoin: () => {},
      fetchList,
      ping: async () => ({ rttMs: 1 }),
      refreshIntervalMs: 1000,
      touchGraceMs: 1500,
    });
    screen.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchList).toHaveBeenCalledTimes(1);
    const option = $('#servers').firstElementChild;
    list = [server({}), server({ id: 'b', port: 7173 })];
    $('#servers').dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchList).toHaveBeenCalledTimes(2);
    expect($('#servers').children.length).toBe(1);
    expect($('#servers').firstElementChild).toBe(option);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchList).toHaveBeenCalledTimes(3);
    expect($('#servers').children.length).toBe(2);
    screen.hide();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchList).toHaveBeenCalledTimes(3);
  });

  it('locks the name to the account and joins as the account', async () => {
    document.body.innerHTML = bodyMarkup;
    const onJoin = vi.fn<(r: JoinRequest) => void>();
    const account = { id: 1, name: 'Alice', groupId: 1, createdAt: 0 };
    const screen = trackScreen({
      document,
      onJoin,
      fetchList: async () => [server({ id: 'a' })],
      ping: vi.fn(async () => ({ rttMs: 1 })),
      accountApi: {
        ...accountControlsStub(),
        me: vi.fn(async () => ({ enabled: true, account })),
        register: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(async () => {}),
        changePassword: vi.fn(),
        ticket: vi.fn(),
      },
    });
    $<HTMLInputElement>('#nicknameInput').value = 'Guesty';
    screen.show();
    await flush();
    await flush();
    const nick = $<HTMLInputElement>('#nicknameInput');
    expect(nick.value).toBe('Alice');
    expect(nick.readOnly).toBe(true);
    $<HTMLFormElement>('form.dv-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onJoin).toHaveBeenCalledWith(
      expect.objectContaining({ nickname: 'Alice', playAsAccount: true }),
    );
    expect($('#nickname').classList.contains('is-locked')).toBe(true);
    expect($('#dv-nickname-account-hint').getAttribute('aria-hidden')).toBe('false');
    expect(nick.getAttribute('aria-describedby')).toBe('dv-nickname-account-hint');
    const guest = $<HTMLInputElement>('#dv-play-as-guest');
    guest.checked = true;
    guest.dispatchEvent(new Event('change'));
    expect(nick.readOnly).toBe(false);
    expect($('#dv-nickname-account-hint').getAttribute('aria-hidden')).toBe('true');
    expect($('#dv-nickname-guest-hint').getAttribute('aria-hidden')).toBe('false');
    expect(nick.getAttribute('aria-describedby')).toBe('dv-nickname-guest-hint');
  });

  it('keeps the chosen server and guest name through account views and sign-in', async () => {
    const account = { id: 1, name: 'Alice', groupId: 1, createdAt: 0 };
    const { screen, onJoin } = build([server({}), server({ id: 'b', port: 7173 })], undefined, {
      accountApi: {
        ...accountControlsStub(),
        me: vi.fn(async () => ({ enabled: true })),
        login: vi.fn(async () => account),
        register: vi.fn(),
        logout: vi.fn(),
        changePassword: vi.fn(),
        ticket: vi.fn(),
      },
    });
    screen.show();
    await flush();
    $<HTMLInputElement>('#nicknameInput').value = 'Wanderer';
    $<HTMLSelectElement>('#servers').value = '127.0.0.1:7173';
    $('#servers').dispatchEvent(new Event('change'));
    $<HTMLButtonElement>('#servers-trigger').click();
    $<HTMLButtonElement>('[data-account-login]').click();
    expect($('#servers-trigger').getAttribute('aria-expanded')).toBe('false');
    expect($('#dv-play-view').hidden).toBe(true);
    $('form.dv-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onJoin).not.toHaveBeenCalled();
    $<HTMLInputElement>('#dv-login-name').value = 'Alice';
    $<HTMLInputElement>('#dv-login-password').value = 'password1';
    $('#dv-form-login').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect($('#dv-play-view').hidden).toBe(false);
    expect($<HTMLSelectElement>('#servers').value).toBe('127.0.0.1:7173');
    expect($<HTMLInputElement>('#nicknameInput').value).toBe('Alice');
    expect(document.activeElement).toBe($('[data-account-manage]'));
    $<HTMLInputElement>('#dv-play-as-guest').click();
    expect($<HTMLInputElement>('#nicknameInput').value).toBe('Wanderer');
    $('form.dv-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onJoin).toHaveBeenCalledWith(
      expect.objectContaining({
        nickname: 'Wanderer',
        playAsAccount: false,
        server: expect.objectContaining({ port: 7173 }),
      }),
    );
  });

  it('triggers onEditor when the map editor button is clicked', async () => {
    document.body.innerHTML = bodyMarkup;
    const onEditor = vi.fn();
    const screen = trackScreen({
      document,
      onJoin: () => {},
      onEditor,
      fetchList: async () => [],
    });
    screen.show();

    const editorBtn = document.querySelector<HTMLButtonElement>('[data-editor]');
    expect(editorBtn).not.toBeNull();
    editorBtn?.click();

    expect(onEditor).toHaveBeenCalledTimes(1);
  });

  it('takes a server/admin password as long as the server accepts (MAX_LOGIN_PASSWORD_LENGTH)', () => {
    build([]);
    expect($<HTMLInputElement>('#passwordInput').maxLength).toBe(32);
  });

  it('turns Play into Cancel while joining, and Cancel or Escape cancels', async () => {
    const onCancel = vi.fn();
    const { screen, onJoin } = build([server({})], undefined, { onCancel });
    screen.show();
    await flush();
    $('form.dv-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect($<HTMLButtonElement>('.dv-play').disabled).toBe(false);
    $('form.dv-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onJoin).toHaveBeenCalledTimes(1);
    screen.endJoin();
    expect($('.dv-play').textContent).toBe('Play');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('shows join progress without a made-up percentage, then clears it after cancellation', async () => {
    const { screen } = build([server({})]);
    screen.show();
    await flush();
    $('form.dv-form').dispatchEvent(new Event('submit', { cancelable: true }));
    screen.setProgress('Connecting to Local…');
    expect($('.dv-loading-detail').textContent).toBe('Connecting to Local…');
    expect($('.dv-loading').dataset.kind).toBe('indeterminate');
    expect($('.dv-loading-track').hasAttribute('aria-valuenow')).toBe(false);
    screen.endJoin();
    expect($('.dv-loading-detail').textContent).toBe('Updating servers…');
    await flush();
    expect($('.dv-status').textContent).toBe('');
    expect($('.dv-loading').getAttribute('aria-hidden')).toBe('true');
  });

  it('shows real visual-preload progress without blocking Play, then fades out completion', async () => {
    vi.useFakeTimers();
    const { screen } = build([server({})]);
    screen.show();
    await vi.advanceTimersByTimeAsync(0);
    screen.setPreload({ done: 47, total: 100 });
    expect($('.dv-loading').getAttribute('aria-hidden')).toBe('false');
    expect($('.dv-loading-track').getAttribute('aria-valuenow')).toBe('47');
    expect($('.dv-loading-track').style.getPropertyValue('--dv-load-progress')).toBe('0.47');
    expect($('.dv-loading-percent').textContent).toBe('47%');
    expect($<HTMLButtonElement>('.dv-play').disabled).toBe(false);
    screen.setPreload({ done: 100, total: 100 });
    expect($('.dv-loading').dataset.kind).toBe('complete');
    await vi.advanceTimersByTimeAsync(1100);
    expect($('.dv-loading').getAttribute('aria-hidden')).toBe('true');
    expect($('.dv-loading-title').textContent).toBe('Preparation complete');
  });

  it('keeps join and error messages above background preload updates', async () => {
    const { screen } = build([server({})]);
    screen.show();
    await flush();
    screen.setPreload({ done: 10, total: 100 });
    screen.setBusy(true);
    screen.setProgress('Connecting to Local…');
    screen.setPreload({ done: 60, total: 100 });
    expect($('.dv-loading-detail').textContent).toBe('Connecting to Local…');
    expect($('.dv-loading-track').hasAttribute('aria-valuenow')).toBe(false);
    screen.endJoin();
    await flush();
    expect($('.dv-loading-track').getAttribute('aria-valuenow')).toBe('60');
    screen.error('Could not connect.');
    screen.setPreload({ done: 90, total: 100 });
    expect($('.dv-loading').getAttribute('aria-hidden')).toBe('true');
    expect($('.dv-status').textContent).toBe('Could not connect.');
  });

  it('clears unknown or failed preload work and cancels old completion timers on a retry', async () => {
    vi.useFakeTimers();
    const { screen } = build([server({})]);
    screen.show();
    await vi.advanceTimersByTimeAsync(0);
    screen.setPreload({ done: 0, total: 0 });
    expect($('.dv-loading').dataset.kind).toBe('indeterminate');
    screen.setPreload(null);
    expect($('.dv-loading').getAttribute('aria-hidden')).toBe('true');
    screen.setPreload({ done: 10, total: 10 });
    screen.setPreload({ done: 1, total: 10 });
    await vi.advanceTimersByTimeAsync(1200);
    expect($('.dv-loading-track').getAttribute('aria-valuenow')).toBe('10');
    expect($('.dv-loading').getAttribute('aria-hidden')).toBe('false');
  });

  it('shows a failure notice with its actions and unlocks the form', async () => {
    const reload = vi.fn();
    const { screen, onJoin } = build([server({})], undefined, { reload });
    screen.show();
    await flush();
    $('form.dv-form').dispatchEvent(new Event('submit', { cancelable: true }));
    screen.showFailure({
      tone: 'warn',
      title: 'Server is full',
      message: 'All 40 slots are taken.',
      detail: 'd',
      actions: ['retry', 'choose-server', 'refresh'],
    });
    const box = $('.dv-notice');
    expect(box.hidden).toBe(false);
    screen.setPreload({ done: 50, total: 100 });
    expect($('.dv-loading').getAttribute('aria-hidden')).toBe('true');
    expect(box.dataset.tone).toBe('warn');
    expect($('.dv-notice-title').textContent).toBe('Server is full');
    expect($('.dv-notice-message').textContent).toBe('All 40 slots are taken.');
    expect($('.dv-notice-detail').textContent).toBe('d');
    const buttons = [...box.querySelectorAll<HTMLButtonElement>('.dv-notice-actions button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Retry', 'Choose server', 'Refresh page']);
    expect($<HTMLInputElement>('#nicknameInput').disabled).toBe(false);
    expect($('.dv-play').textContent).toBe('Play');

    buttons[1]!.click();
    expect(document.activeElement).toBe($('#servers-trigger'));
    buttons[2]!.click();
    expect(reload).toHaveBeenCalledTimes(1);
    buttons[0]!.click();
    expect(onJoin).toHaveBeenCalledTimes(2);
    expect(box.hidden).toBe(true);
  });

  it('clears the notice when the player changes the server', async () => {
    const { screen } = build([server({}), server({ port: 7173, name: 'B' })]);
    screen.show();
    await flush();
    screen.showFailure({ tone: 'error', title: 'x', message: '', detail: '', actions: [] });
    $('#servers').dispatchEvent(new Event('change'));
    expect($('.dv-notice').hidden).toBe(true);
  });

  it('distinguishes loading, failed, updating and empty states without clearing join feedback', async () => {
    vi.useFakeTimers();
    const fetchList = vi
      .fn<() => Promise<ListedServer[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([]);
    const stream = new ListingStream();
    const { screen } = build([], undefined, { fetchList, createEventSource: () => stream });
    screen.show();
    expect($('.dv-loading-detail').textContent).toBe('Loading servers…');
    await vi.advanceTimersByTimeAsync(0);
    expect($('.dv-status').textContent).toBe('Server list unavailable. Retrying…');
    stream.snapshot([]);
    expect($('.dv-status').textContent).toBe('No servers available.');
    stream.snapshot([server({})]);
    stream.dispatchEvent(new Event('error'));
    expect($('.dv-loading-detail').textContent).toBe('Updating servers…');
    expect($('#servers').children.length).toBe(1);
    screen.error('Wrong password.');
    stream.snapshot([server({ players: 3 })]);
    expect($('.dv-status').textContent).toBe('Wrong password.');
  });

  it('updates streamed counts, preserves unchanged options and selection, and caches RTT independently', async () => {
    vi.useFakeTimers();
    const list = [server({}), server({ id: 'b', port: 7173, name: 'Second' })];
    window.localStorage.setItem('lastServer', '127.0.0.1:7173');
    const fetchList = vi.fn(async () => list);
    const ping = vi.fn(async () => ({ rttMs: 12, players: 99, max: 99 }));
    const stream = new ListingStream();
    const { screen } = build(list, ping, { fetchList, createEventSource: () => stream });
    screen.show();
    await vi.advanceTimersByTimeAsync(0);
    const options = [...$('#servers').children];
    stream.snapshot(list);
    expect([...$('#servers').children]).toEqual(options);
    stream.snapshot([server({ players: 10 }), list[1]]);
    expect($('#servers').children[0].textContent).toContain('10/40 players');
    expect($<HTMLSelectElement>('#servers').value).toBe('127.0.0.1:7173');
    expect(ping).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchList).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ping).toHaveBeenCalledTimes(4);
  });

  it('probes the selected server first with at most two concurrent status sockets', async () => {
    vi.useFakeTimers();
    const list = [server({}), server({ id: 'b', port: 7173 }), server({ id: 'c', port: 7174 })];
    window.localStorage.setItem('lastServer', '127.0.0.1:7174');
    const pending: ((result: { rttMs: number }) => void)[] = [];
    const ping = vi.fn(() => new Promise<{ rttMs: number }>((resolve) => pending.push(resolve)));
    const { screen } = build(list, ping);
    screen.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(ping.mock.calls.map((call) => (call as unknown as [ListedServer])[0].port)).toEqual([
      7174, 7172,
    ]);
    pending[0]({ rttMs: 8 });
    await vi.advanceTimersByTimeAsync(0);
    expect(ping).toHaveBeenCalledTimes(3);
    expect((ping.mock.calls[2] as unknown as [ListedServer])[0].port).toBe(7173);
  });

  it('closes streams and cancels status work while hidden, then reconnects with a fresh snapshot', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const streams: ListingStream[] = [];
    const createEventSource = vi.fn(() => {
      const stream = new ListingStream();
      streams.push(stream);
      return stream;
    });
    const fetchList = vi.fn(async () => [server({})]);
    let finishPing!: (result: { rttMs: number }) => void;
    const ping = vi.fn(
      (_server: ListedServer, _signal?: AbortSignal) =>
        new Promise<{ rttMs: number }>((resolve) => {
          finishPing = resolve;
        }),
    );
    const { screen } = build([], ping, { fetchList, createEventSource });
    screen.show();
    await vi.advanceTimersByTimeAsync(0);
    streams[0].snapshot([server({})]);
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(streams[0].close).toHaveBeenCalledTimes(1);
    expect(ping.mock.calls[0][1]?.aborted).toBe(true);
    streams[0].snapshot([]);
    finishPing({ rttMs: 99 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchList).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(1);
    expect($('#servers').children.length).toBe(1);
    expect($('#servers').children[0].textContent).not.toContain('99 ms');
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    streams[1].snapshot([server({ name: 'Fresh' })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(createEventSource).toHaveBeenCalledTimes(2);
    expect($('#servers').children[0].textContent).toContain('Fresh');
    screen.hide();
    expect(streams[1].close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchList).toHaveBeenCalledTimes(2);
  });

  it('suspends the subscription for a custom address and while joining', async () => {
    vi.useFakeTimers();
    const streams: ListingStream[] = [];
    const { screen } = build([server({})], undefined, {
      createEventSource: () => {
        const stream = new ListingStream();
        streams.push(stream);
        return stream;
      },
    });
    screen.show();
    await vi.advanceTimersByTimeAsync(0);
    $<HTMLSelectElement>('#dv-mode').value = 'custom';
    $('#dv-mode').dispatchEvent(new Event('change'));
    expect(streams[0].close).toHaveBeenCalledTimes(1);
    $<HTMLSelectElement>('#dv-mode').value = 'survival';
    $('#dv-mode').dispatchEvent(new Event('change'));
    expect(streams).toHaveLength(2);
    $('form.dv-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(streams[1].close).toHaveBeenCalledTimes(1);
    screen.endJoin();
    expect(streams).toHaveLength(3);
  });
});
