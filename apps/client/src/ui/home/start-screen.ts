// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// DOM behaviour of the home screen. Markup lives in apps/client/public/index.html, styles
// in public/css/ui.css. Everything the screen needs from outside (server list,
// pings, what "Play" does) is injected so this is testable under jsdom.
import type { ListedServer } from '../../../../../shared/typescript/server-list';
import { readSetting, writeSetting } from '../../core/storage';
import { queryServerStatus } from '../../net/status-query';
import type { AccountApi } from './account-api';
import { AccountPanel, type AccountState } from './account-panel';
import { mountPublicRankings } from './account-community';
import { parseCustomAddress, type ServerAddress } from './custom-address';
import { dismissOnBackdrop } from './dialog-dismiss';
import { HomeSelect } from './home-select';
import { JOIN_ACTION_LABELS, type FailureNotice, type JoinAction } from './join-messages';
import { ServerListFeed, type ListingEventStream, type ListingState } from './server-list-feed';
import {
  HOME_MODES,
  fetchServerList,
  optionLabel,
  serverKey,
  serversForMode,
  type HomeMode,
  type PingResult,
} from './server-list';

export interface JoinRequest {
  nickname: string;
  password: string;
  address: ServerAddress;
  /** The listed entry, or null for a custom address. */
  server: ListedServer | null;
  /** Join with an account ticket (logged in and "Play as account" ticked). */
  playAsAccount: boolean;
}

export interface PreloadProgress {
  done: number;
  total: number;
}

export interface StartScreenOptions {
  document: Document;
  onJoin: (request: JoinRequest) => void;
  onEditor?: () => void;
  fetchList?: (signal?: AbortSignal) => Promise<ListedServer[]>;
  ping?: (server: ListedServer, signal?: AbortSignal) => Promise<PingResult>;
  /** Set null to use HTTP only. Injected fetchList defaults to HTTP only. */
  createEventSource?: ((url: string) => ListingEventStream) | null;
  /** HTTP fallback interval while live updates are disconnected. */
  refreshIntervalMs?: number;
  /** How long after the player last touched the dropdown a refresh stays away. */
  touchGraceMs?: number;
  now?: () => number;
  /** Omit to run without the account area (tests, editor). */
  accountApi?: AccountApi;
  /** Cancel while a join is in progress (the Play button, or Escape). */
  onCancel?: () => void;
  /** "Refresh page" on a notice; defaults to location.reload(). */
  reload?: () => void;
}

const REFRESH_INTERVAL_MS = 20_000;
const TOUCH_GRACE_MS = 5_000;
const PING_CACHE_MS = 30_000;
const PING_CONCURRENCY = 2;
const NICKNAME_KEY = 'nickname';
const LAST_SERVER_KEY = 'lastServer';

export async function defaultPing(server: ListedServer, signal?: AbortSignal): Promise<PingResult> {
  if (server.statusPort === null) return { rttMs: null };
  const probe = await queryServerStatus({
    host: server.host,
    port: server.statusPort,
    tls: server.tls,
    signal,
  });
  return { rttMs: probe.rttMs };
}

function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing element in apps/client/public/index.html');
  return value;
}

export class StartScreen {
  private readonly doc: Document;
  private readonly onJoin: (request: JoinRequest) => void;
  private readonly onEditor?: () => void;
  private readonly feed: ServerListFeed;
  private readonly ping: (server: ListedServer, signal?: AbortSignal) => Promise<PingResult>;
  private readonly touchGraceMs: number;
  private readonly now: () => number;
  private readonly accountApi?: AccountApi;
  private readonly onCancel?: () => void;
  private readonly reload: () => void;

  private root!: HTMLElement;
  private form!: HTMLFormElement;
  private nickname!: HTMLInputElement;
  private password!: HTMLInputElement;
  private modeSelect!: HTMLSelectElement;
  private serverSelect!: HTMLSelectElement;
  private modePicker!: HomeSelect;
  private serverPicker!: HomeSelect;
  private address!: HTMLInputElement;
  private play!: HTMLButtonElement;
  private status!: HTMLElement;
  private loading!: HTMLElement;
  private loadingTitle!: HTMLElement;
  private loadingDetail!: HTMLElement;
  private loadingPercent!: HTMLElement;
  private loadingTrack!: HTMLElement;
  private notice!: HTMLElement;
  private dialog!: HTMLDialogElement;

  private mounted = false;
  private servers: ListedServer[] = [];
  private readonly pings = new Map<string, { result: PingResult; at: number }>();
  private readonly pingJobs = new Map<string, AbortController>();
  private pingQueue: ListedServer[] = [];
  private listingState: ListingState = 'loading';
  private snapshotSignature = '';
  private busy = false;
  private feedback = '';
  private preload: PreloadProgress | null = null;
  private preloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** The join stage line while busy. */
  private progress = '';
  private touchedAt = -Infinity;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private accounts: AccountPanel | null = null;
  private rankings: ReturnType<typeof mountPublicRankings> | null = null;
  private guestNickname = '';

  constructor(options: StartScreenOptions) {
    this.doc = options.document;
    this.onJoin = options.onJoin;
    this.onEditor = options.onEditor;
    this.ping = options.ping ?? defaultPing;
    this.touchGraceMs = options.touchGraceMs ?? TOUCH_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.accountApi = options.accountApi;
    this.onCancel = options.onCancel;
    this.reload = options.reload ?? (() => this.doc.defaultView?.location.reload());
    this.feed = new ServerListFeed({
      fetchList: options.fetchList ?? ((signal) => fetchServerList(fetch, signal)),
      createEventSource:
        options.createEventSource !== undefined
          ? options.createEventSource
          : !options.fetchList && typeof EventSource !== 'undefined'
            ? (url) => new EventSource(url)
            : null,
      fallbackIntervalMs: options.refreshIntervalMs ?? REFRESH_INTERVAL_MS,
      onSnapshot: (servers) => this.receiveList(servers),
      onState: (state) => {
        this.listingState = state;
        this.refresh();
      },
    });
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    const doc = this.doc;
    this.root = must(doc.getElementById('prevast-home'));
    this.form = must(this.root.querySelector<HTMLFormElement>('form.dv-form'));
    this.nickname = must(doc.getElementById('nicknameInput') as HTMLInputElement | null);
    this.password = must(doc.getElementById('passwordInput') as HTMLInputElement | null);
    this.modeSelect = must(doc.getElementById('dv-mode') as HTMLSelectElement | null);
    this.serverSelect = must(doc.getElementById('servers') as HTMLSelectElement | null);
    this.address = must(doc.getElementById('dv-address') as HTMLInputElement | null);
    this.play = must(this.form.querySelector<HTMLButtonElement>('.dv-play'));
    this.status = must(this.form.querySelector<HTMLElement>('.dv-status'));
    this.loading = must(this.form.querySelector<HTMLElement>('.dv-loading'));
    this.loadingTitle = must(this.loading.querySelector<HTMLElement>('.dv-loading-title'));
    this.loadingDetail = must(this.loading.querySelector<HTMLElement>('.dv-loading-detail'));
    this.loadingPercent = must(this.loading.querySelector<HTMLElement>('.dv-loading-percent'));
    this.loadingTrack = must(this.loading.querySelector<HTMLElement>('.dv-loading-track'));
    this.notice = must(this.form.querySelector<HTMLElement>('.dv-notice'));
    this.dialog = must(doc.getElementById('dv-info') as HTMLDialogElement | null);
    this.modePicker = new HomeSelect(this.modeSelect, this.root);
    this.serverPicker = new HomeSelect(this.serverSelect, this.root, {
      empty: () =>
        this.listingState === 'loading'
          ? { title: 'Finding servers…', detail: 'Looking for an available world.' }
          : this.listingState === 'unavailable'
            ? { title: 'Server list unavailable', detail: 'Reconnecting automatically…' }
            : { title: 'No open servers', detail: 'Try another game mode or a custom address.' },
      onInteraction: () => {
        this.touchedAt = this.now();
      },
      onClose: () => this.renderWhenIdle(),
    });

    this.modeSelect.addEventListener('change', () => {
      if (this.busy) return;
      this.feedback = '';
      this.clearNotice();
      this.password.value = '';
      this.touchedAt = this.now();
      // All modes share the same snapshot and subscription.
      this.renderServers();
      this.refresh();
      this.syncListingActivity();
      this.queuePings();
    });
    for (const type of ['pointerdown', 'keydown', 'change']) {
      this.serverSelect.addEventListener(type, () => {
        this.touchedAt = this.now();
      });
    }
    this.serverSelect.addEventListener('change', () => {
      this.password.value = '';
      this.feedback = '';
      this.clearNotice();
      this.refresh();
      this.queuePings();
    });
    this.address.addEventListener('input', () => {
      this.password.value = '';
      this.feedback = '';
      this.clearNotice();
      this.refresh();
    });
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-info]').forEach((button) => {
      button.addEventListener('click', () => {
        this.showInfo(button.dataset.info === 'controls' ? 'controls' : 'updates');
      });
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-editor]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!this.busy) this.onEditor?.();
      });
    });
    dismissOnBackdrop(this.dialog, must(this.dialog.querySelector<HTMLElement>('.dv-window')), () =>
      this.dialog.close(),
    );
    // Keep game keyboard/mouse listeners from consuming native form input.
    for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup', 'touchstart', 'touchend']) {
      this.root.addEventListener(type, (event) => event.stopPropagation());
    }
    // Capture phase: the root stops keydown from bubbling (above), and Escape
    // must cancel wherever focus is while a join is running.
    doc.addEventListener(
      'keydown',
      (event) => {
        if (this.busy && event.key === 'Escape' && !this.root.hidden) {
          event.preventDefault();
          this.onCancel?.();
        }
      },
      true,
    );

    this.nickname.value = readSetting(NICKNAME_KEY) ?? '';
    doc.addEventListener('visibilitychange', () => this.syncListingActivity());
    if (this.accountApi) {
      this.accounts = new AccountPanel(doc, this.accountApi, (state) => this.applyAccount(state), {
        onViewChange: () => {
          this.modePicker.close();
          this.serverPicker.close();
          must(doc.getElementById('dv-start-window')).scrollTop = 0;
        },
      });
      this.accounts.mount();
      if (this.accountApi.community)
        this.rankings = mountPublicRankings(doc, this.accountApi.community);
      void this.accounts.refresh();
    }
    const params = new URLSearchParams(doc.defaultView?.location.search ?? '');
    if (params.has('admin') || params.has('member') || params.has('moderator')) {
      must(this.form.querySelector('details')).open = true;
    }
    this.refresh();
  }

  get mode(): HomeMode {
    const value = this.modeSelect.value;
    return (HOME_MODES as readonly string[]).includes(value) ? (value as HomeMode) : 'survival';
  }

  show(): void {
    this.mount();
    this.feedback = '';
    this.clearNotice();
    this.root.hidden = false;
    void this.rankings?.refresh();
    this.doc.body.classList.add('dv-home-active');
    this.renderServers();
    this.setBusy(false);
  }

  hide(): void {
    if (!this.mounted) return;
    if (this.preloadTimer !== null) {
      clearTimeout(this.preloadTimer);
      this.preloadTimer = null;
      this.preload = null;
    }
    this.modePicker.close();
    this.serverPicker.close();
    if (this.dialog.open) this.dialog.close();
    const active = this.doc.activeElement;
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur();
    this.root.hidden = true;
    this.doc.body.classList.remove('dv-home-active');
    this.syncListingActivity();
  }

  error(message: string): void {
    this.feedback = message;
    this.setBusy(false);
  }

  /** Background visual preparation never blocks Play; only actual asset counts drive the bar. */
  setPreload(progress: PreloadProgress | null): void {
    if (this.preloadTimer !== null) clearTimeout(this.preloadTimer);
    this.preloadTimer = null;
    this.preload = progress;
    if (progress && progress.total > 0 && progress.done >= progress.total) {
      this.preloadTimer = setTimeout(() => {
        this.preloadTimer = null;
        this.preload = null;
        if (this.mounted) this.renderFeedback();
      }, 1_100);
    }
    if (this.mounted) this.renderFeedback();
  }

  setBusy(value: boolean): void {
    this.busy = value;
    if (value) this.feedback = '';
    this.progress = '';
    if (!this.mounted) return;
    this.form.setAttribute('aria-busy', String(value));
    this.form.querySelectorAll('input').forEach((input) => {
      input.disabled = value;
    });
    this.play.textContent = value ? 'Cancel' : 'Play';
    this.accounts?.setLocked(value);
    this.refresh();
    this.syncListingActivity();
  }

  refresh(): void {
    if (!this.mounted) return;
    const custom = this.mode === 'custom';
    must(this.form.querySelector<HTMLElement>('[data-listed]')).hidden = custom;
    must(this.form.querySelector<HTMLElement>('[data-custom]')).hidden = !custom;
    must(this.form.querySelector<HTMLElement>('[data-listed]')).inert = custom;
    must(this.form.querySelector<HTMLElement>('[data-custom]')).inert = !custom;
    const valid = this.selectedServer() !== null;
    this.serverSelect.disabled = this.busy;
    this.modeSelect.disabled = this.busy;
    this.modePicker.sync();
    this.serverPicker.sync();
    if (custom) this.serverPicker.close();
    // While busy the button is Cancel, which is always available.
    this.play.disabled = !this.busy && !custom && !valid;
    this.renderFeedback();
  }

  private renderFeedback(): void {
    const custom = this.mode === 'custom';
    const valid = this.selectedServer() !== null;
    const listingFeedback = custom
      ? ''
      : this.listingState === 'loading'
        ? 'Loading servers…'
        : this.listingState === 'unavailable'
          ? 'Server list unavailable. Retrying…'
          : this.listingState === 'updating'
            ? 'Updating servers…'
            : !valid
              ? 'No servers available.'
              : '';
    let title = '';
    let detail = '';
    let percent: number | null = null;
    if (this.busy) {
      title = 'Getting ready';
      detail = this.progress || 'Preparing your session…';
    } else if (!this.feedback && this.notice.hidden) {
      if (!custom && (this.listingState === 'loading' || this.listingState === 'updating')) {
        title = this.listingState === 'loading' ? 'Finding a world' : 'Refreshing worlds';
        detail = listingFeedback;
      } else if (!listingFeedback && this.preload) {
        const { done, total } = this.preload;
        if (total > 0) percent = Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
        title = percent === 100 ? 'Preparation complete' : 'Loading game visuals';
        detail =
          percent === 100
            ? 'Choose a server and press Play.'
            : 'You can choose a server while this loads.';
      }
    }
    this.status.textContent = title || !this.notice.hidden ? '' : this.feedback || listingFeedback;
    this.loading.setAttribute('aria-hidden', String(!title));
    if (!title) return; // Keep the last contents in place for the fade-out.
    const kind = percent === 100 ? 'complete' : percent === null ? 'indeterminate' : 'progress';
    this.loading.dataset.kind = kind;
    // Stable text avoids announcing every asset completion through the live region.
    if (this.loadingTitle.textContent !== title) this.loadingTitle.textContent = title;
    if (this.loadingDetail.textContent !== detail) this.loadingDetail.textContent = detail;
    const percentage = percent === null ? '' : `${percent}%`;
    if (this.loadingPercent.textContent !== percentage)
      this.loadingPercent.textContent = percentage;
    this.loadingTrack.setAttribute('aria-label', title);
    if (percent === null) this.loadingTrack.removeAttribute('aria-valuenow');
    else this.loadingTrack.setAttribute('aria-valuenow', String(percent));
    this.loadingTrack.style.setProperty('--dv-load-progress', String((percent ?? 0) / 100));
  }

  /** The join's current stage, shown while busy. */
  setProgress(text: string): void {
    this.progress = text;
    if (this.mounted && this.busy) this.renderFeedback();
  }

  /** The join ended without an error to show (cancelled). */
  endJoin(): void {
    this.setBusy(false);
  }

  /** The join failed: unlock the form and explain, with the actions that make sense. */
  showFailure(notice: FailureNotice): void {
    this.setBusy(false);
    if (!this.mounted) return;
    this.notice.dataset.tone = notice.tone;
    must(this.notice.querySelector('.dv-notice-title')).textContent = notice.title;
    must(this.notice.querySelector('.dv-notice-message')).textContent = notice.message;
    must(this.notice.querySelector('.dv-notice-detail')).textContent = notice.detail;
    must(this.notice.querySelector('.dv-notice-actions')).replaceChildren(
      ...notice.actions.map((action, i) => {
        const button = this.doc.createElement('button');
        button.type = 'button';
        button.className = i === 0 ? 'dv-btn is-primary' : 'dv-btn';
        button.textContent = JOIN_ACTION_LABELS[action];
        button.addEventListener('click', () => this.runAction(action));
        return button;
      }),
    );
    this.notice.hidden = false;
    this.renderFeedback();
  }

  private runAction(action: JoinAction): void {
    if (action === 'refresh') {
      this.reload();
      return;
    }
    this.clearNotice();
    if (action === 'sign-in') {
      this.accounts?.sessionExpired();
      this.accounts?.open('login');
    } else if (action === 'guest') {
      this.accounts?.playAsGuest();
      this.submit();
    } else if (action === 'retry') this.submit();
    else (this.mode === 'custom' ? this.address : this.serverPicker.trigger).focus();
  }

  private clearNotice(): void {
    if (!this.mounted) return;
    this.notice.hidden = true;
    must(this.notice.querySelector('.dv-notice-actions')).replaceChildren();
    this.renderFeedback();
  }

  selectedServer(): ListedServer | null {
    const key = this.serverSelect.value;
    if (!key) return null;
    const server = this.servers.find((s) => serverKey(s) === key) ?? null;
    return server && server.state === 'open' ? server : null;
  }

  async reloadList(): Promise<void> {
    await this.feed.refresh();
  }

  private receiveList(servers: ListedServer[]): void {
    const signature = JSON.stringify(servers);
    if (signature !== this.snapshotSignature) {
      this.snapshotSignature = signature;
      this.servers = servers;
      const keys = new Set(servers.map((server) => this.pingKey(server)));
      for (const key of this.pings.keys()) if (!keys.has(key)) this.pings.delete(key);
      this.updateLabels();
      this.renderWhenIdle();
    }
    this.queuePings();
  }

  private renderWhenIdle(): void {
    if (this.renderTimer !== null) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    if (!this.listingActive()) return;
    if (this.serverPicker.isOpen) return;
    const delay = this.touchGraceMs - (this.now() - this.touchedAt);
    if (delay > 0) {
      this.renderTimer = setTimeout(() => this.renderWhenIdle(), delay);
      return;
    }
    this.renderServers();
    this.refresh();
    this.queuePings();
  }

  showInfo(kind: 'controls' | 'updates'): void {
    const controls = kind === 'controls';
    must(this.dialog.querySelector('h2')).textContent = controls ? 'How to play' : 'Changelog';
    must(this.dialog.querySelector<HTMLElement>('[data-help-pane]')).hidden = !controls;
    must(this.dialog.querySelector<HTMLElement>('[data-updates-pane]')).hidden = controls;
    this.dialog.showModal();
  }

  /** Rebuilds the dropdown; keeps the selection by key, else the first open server. */
  private renderServers(): void {
    const previous = this.serverSelect.value || readSetting(LAST_SERVER_KEY) || '';
    const visible = serversForMode(this.servers, this.mode);
    this.serverSelect.replaceChildren(
      ...visible.map((server) => {
        const option = this.doc.createElement('option');
        option.value = serverKey(server);
        this.describeServer(option, server);
        return option;
      }),
    );
    const keep =
      visible.find((s) => serverKey(s) === previous && s.state === 'open') ??
      visible.find((s) => s.state === 'open');
    this.serverSelect.value = keep ? serverKey(keep) : '';
    this.serverPicker.sync();
  }

  /** Updates labels in place so an open dropdown is not rebuilt under the player. */
  private updateLabels(): void {
    for (const option of this.serverSelect.options) {
      const server = this.servers.find((s) => serverKey(s) === option.value);
      if (server) {
        this.describeServer(option, server);
      } else {
        option.disabled = true;
        option.dataset.badge = 'Offline';
        option.dataset.tone = 'muted';
      }
    }
    this.serverPicker.sync();
  }

  private describeServer(option: HTMLOptionElement, server: ListedServer): void {
    const ping = this.pings.get(this.pingKey(server))?.result;
    option.textContent = optionLabel(server, ping);
    option.disabled = server.state !== 'open';
    option.dataset.title = server.name;
    option.dataset.detail = [
      `${server.players}${server.max > 0 ? `/${server.max}` : ''} players`,
      server.location,
      server.mapX > 0 && server.mapY > 0 ? `${server.mapX} × ${server.mapY}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const full = server.max > 0 && server.players >= server.max;
    const state = { open: '', closed: 'Closed', maintenance: 'Maintenance', startup: 'Starting' }[
      server.state
    ];
    option.dataset.badge =
      state ||
      (full
        ? 'Full'
        : ping
          ? ping.rttMs === null
            ? 'No response'
            : `${ping.rttMs} ms`
          : server.statusPort === null
            ? 'Open'
            : 'Checking…');
    option.dataset.tone = state
      ? 'muted'
      : full || ping?.rttMs === null
        ? 'warn'
        : ping?.rttMs !== undefined
          ? ping.rttMs <= 100
            ? 'good'
            : ping.rttMs <= 200
              ? ''
              : 'warn'
          : '';
  }

  private pingKey(server: ListedServer): string {
    return `${serverKey(server)}:${server.statusPort}:${server.tls}`;
  }

  private queuePings(): void {
    if (!this.listingActive()) return;
    const selected = this.serverSelect.value;
    const targets = serversForMode(this.servers, this.mode);
    const visibleKeys = new Set(targets.map((server) => this.pingKey(server)));
    for (const [key, abort] of this.pingJobs) {
      if (!visibleKeys.has(key)) {
        abort.abort();
        this.pingJobs.delete(key);
      }
    }
    this.pingQueue = targets
      .filter((server) => {
        const key = this.pingKey(server);
        const cached = this.pings.get(key);
        return (
          server.statusPort !== null &&
          !this.pingJobs.has(key) &&
          (!cached || this.now() - cached.at >= PING_CACHE_MS)
        );
      })
      .sort((a, b) => Number(serverKey(b) === selected) - Number(serverKey(a) === selected));
    this.pumpPings();
  }

  private pumpPings(): void {
    while (
      this.listingActive() &&
      this.pingJobs.size < PING_CONCURRENCY &&
      this.pingQueue.length > 0
    ) {
      const server = this.pingQueue.shift()!;
      const key = this.pingKey(server);
      const abort = new AbortController();
      this.pingJobs.set(key, abort);
      void Promise.resolve()
        .then(() => this.ping(server, abort.signal))
        .catch(() => ({ rttMs: null }))
        .then((result) => {
          if (abort.signal.aborted || !this.listingActive()) return;
          this.pings.set(key, { result: { rttMs: result.rttMs }, at: this.now() });
          this.updateLabels();
        })
        .finally(() => {
          if (this.pingJobs.get(key) !== abort) return;
          this.pingJobs.delete(key);
          this.pumpPings();
        });
    }
  }

  /** The web host no longer knows the account session (a ticket request said so). */
  accountSessionExpired(): void {
    this.accounts?.sessionExpired();
  }

  /** Playing as an account shows (and locks) its name; a guest gets their own nickname back. */
  private applyAccount(state: AccountState): void {
    const asAccount = state.account !== null && state.playAsAccount;
    if (asAccount) {
      if (!this.nickname.readOnly) this.guestNickname = this.nickname.value;
      this.nickname.value = state.account!.name;
      this.nickname.readOnly = true;
    } else if (this.nickname.readOnly) {
      this.nickname.value = this.guestNickname;
      this.nickname.readOnly = false;
    }
    this.nickname.parentElement?.classList.toggle('is-locked', asAccount);
    must(this.doc.getElementById('dv-nickname-account-hint')).setAttribute(
      'aria-hidden',
      String(!asAccount),
    );
    must(this.doc.getElementById('dv-nickname-guest-hint')).setAttribute(
      'aria-hidden',
      String(asAccount),
    );
    this.nickname.setAttribute(
      'aria-describedby',
      asAccount ? 'dv-nickname-account-hint' : 'dv-nickname-guest-hint',
    );
  }

  private listingActive(): boolean {
    return (
      this.mounted &&
      !this.root.hidden &&
      !this.busy &&
      this.mode !== 'custom' &&
      this.doc.visibilityState !== 'hidden'
    );
  }

  private syncListingActivity(): void {
    if (this.listingActive()) {
      this.renderWhenIdle();
      this.feed.start();
      if (this.pingTimer === null)
        this.pingTimer = setInterval(() => this.queuePings(), PING_CACHE_MS);
      this.queuePings();
    } else {
      this.feed.stop();
      if (this.pingTimer !== null) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.renderTimer !== null) clearTimeout(this.renderTimer);
      this.renderTimer = null;
      for (const abort of this.pingJobs.values()) abort.abort();
      this.pingJobs.clear();
      this.pingQueue = [];
    }
  }

  private submit(): void {
    if (this.accounts?.openView) return;
    if (this.busy) {
      this.onCancel?.();
      return;
    }
    if (this.play.disabled) return;
    this.clearNotice();
    const nickname = this.nickname.value.trim();
    const playAsAccount = this.accounts?.state.account != null && this.accounts.state.playAsAccount;
    if (!playAsAccount) writeSetting(NICKNAME_KEY, nickname);
    let address: ServerAddress;
    let server: ListedServer | null = null;
    if (this.mode === 'custom') {
      try {
        address = parseCustomAddress(
          this.address.value,
          this.doc.defaultView?.location.protocol === 'https:',
        );
      } catch (error) {
        this.error((error as Error).message);
        return;
      }
    } else {
      server = this.selectedServer();
      if (!server) {
        this.error('Choose an available server first.');
        return;
      }
      address = { host: server.host, port: server.port, tls: server.tls };
      writeSetting(LAST_SERVER_KEY, serverKey(server));
    }
    this.setBusy(true);
    this.onJoin({ nickname, password: this.password.value, address, server, playAsAccount });
  }
}
