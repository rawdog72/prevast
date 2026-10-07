// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The start page's account strip and inline views (markup in public/index.html,
// styles in public/css/ui.css). Everything goes through AccountApi, so it is
// testable under jsdom.
//
// Sign-in stays compact; management expands into a tabbed workspace.
// The play form stays mounted so returning preserves the setup.
import {
  accountNameError,
  emailError,
  passwordError,
} from '../../../../../shared/typescript/account-rules';
import { AccountApiError, type AccountApi, type AccountInfo } from './account-api';
import { AccountForm } from './account-form';
import { AccountDashboard } from './account-dashboard';
import { AccountRecovery } from './account-recovery';

export interface AccountState {
  /** The web host runs accounts at all. */
  enabled: boolean;
  account: AccountInfo | null;
  /** Logged in and wants to join as the account (else as a guest). */
  playAsAccount: boolean;
}

export type AccountView = 'login' | 'register' | 'manage';

export interface AccountPanelOptions {
  /** How long a notice under the account strip stays up. */
  noticeMs?: number;
  onViewChange?: () => void;
}

const NOTICE_MS = 6_000;

const HEADINGS: Record<AccountView, { title: string; sub: string }> = {
  login: { title: 'Welcome back', sub: 'Your survivor profile is ready when you are.' },
  register: {
    title: 'Create your account',
    sub: 'Keep your achievements and build your survivor profile.',
  },
  manage: { title: 'Your account', sub: 'Your survivor, your clan, your next chapter.' },
};

export const SESSION_EXPIRED = 'Your session has expired. Sign in again to play with your account.';

const required = (message: string) => (value: string) => (value === '' ? message : null);

function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing account element in apps/client/public/index.html');
  return value;
}

export function groupLabel(groupId: number): string {
  return groupId <= 1 ? 'Player' : 'Staff';
}

export function memberSince(createdAt: number, locale?: string): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return '';
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
    new Date(createdAt),
  );
}

/** A stable hue per name, so the avatar colour is the player's own. */
export function avatarHue(name: string): number {
  let hash = 0;
  for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export class AccountPanel {
  private root!: HTMLElement;
  private panel!: HTMLElement;
  private playView!: HTMLElement;
  private window!: HTMLElement;
  private security!: HTMLDetailsElement;
  private dashboard!: AccountDashboard;
  private returnFocus: HTMLElement | null = null;
  private signingOut = false;
  private alert!: HTMLElement;
  private notice!: HTMLElement;
  private forms!: Record<AccountView, AccountForm>;
  private view: AccountView = 'login';
  private current: AccountState = { enabled: false, account: null, playAsAccount: true };
  private loaded = false;
  private refreshVersion = 0;
  private locked = false;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly noticeMs: number;
  private readonly onViewChange?: () => void;

  constructor(
    private readonly doc: Document,
    private readonly api: AccountApi,
    private readonly onChange: (state: AccountState) => void,
    options: AccountPanelOptions = {},
  ) {
    this.noticeMs = options.noticeMs ?? NOTICE_MS;
    this.onViewChange = options.onViewChange;
  }

  get state(): AccountState {
    return this.current;
  }

  get openView(): AccountView | null {
    return this.panel.hidden ? null : this.view;
  }

  mount(): void {
    const doc = this.doc;
    this.root = must(doc.getElementById('dv-account'));
    this.panel = must(doc.getElementById('dv-account-view'));
    this.playView = must(doc.getElementById('dv-play-view'));
    this.window = must(doc.getElementById('dv-start-window'));
    this.security = must(this.panel.querySelector<HTMLDetailsElement>('[data-account-security]'));
    this.alert = must(this.panel.querySelector<HTMLElement>('[data-auth-alert]'));
    this.notice = must(doc.getElementById('dv-account-notice'));
    const dashboardRoot = doc.createElement('div');
    dashboardRoot.className = 'dv-account-dashboard';
    dashboardRoot.hidden = true;
    this.panel.append(dashboardRoot);
    this.dashboard = new AccountDashboard(
      dashboardRoot,
      this.api,
      () => this.sessionExpired(),
      must(this.panel.querySelector<HTMLFormElement>('[data-account-form="manage"]')),
    );
    const recovery = new AccountRecovery(doc, this.api, () => void this.refresh());
    must(this.panel.querySelector<HTMLButtonElement>('[data-account-recover]')).onclick = () =>
      recovery.open();
    const form = (view: AccountView) =>
      must(this.panel.querySelector<HTMLFormElement>(`form[data-account-form="${view}"]`));

    this.forms = {
      login: new AccountForm(form('login'), {
        name: required('Enter your account name.'),
        password: required('Enter your password.'),
      }),
      register: new AccountForm(form('register'), {
        name: (value) => (value.trim() === '' ? 'Choose a name.' : accountNameError(value.trim())),
        password: (value) => (value === '' ? 'Choose a password.' : passwordError(value)),
        confirm: (value, f) =>
          value === ''
            ? 'Type the password again.'
            : value !== f.value('password')
              ? 'The passwords do not match.'
              : null,
        email: (value) => emailError(value.trim()),
      }),
      manage: new AccountForm(form('manage'), {
        current: required('Enter your current password.'),
        next: (value, f) =>
          value === ''
            ? 'Choose a new password.'
            : (passwordError(value) ??
              (value === f.value('current')
                ? 'The new password must be different from the current one.'
                : null)),
        confirm: (value, f) =>
          value === ''
            ? 'Type the new password again.'
            : value !== f.value('next')
              ? 'The passwords do not match.'
              : null,
      }),
    };
    for (const [view, f] of Object.entries(this.forms) as [AccountView, AccountForm][]) {
      f.el.addEventListener('submit', (event) => {
        event.preventDefault();
        void this.submit(view);
      });
    }

    const click = (scope: ParentNode, selector: string, action: (button: HTMLElement) => void) => {
      scope.querySelectorAll<HTMLElement>(selector).forEach((button) => {
        button.addEventListener('click', () => action(button));
      });
    };
    click(this.root, '[data-account-login]', () => this.open('login'));
    click(this.root, '[data-account-register]', () => this.open('register'));
    click(this.root, '[data-account-manage]', () => this.open('manage'));
    click(this.panel, '[data-auth-tab]', (button) =>
      this.switchTo(button.dataset['authTab'] as AccountView),
    );
    click(this.panel, '[data-auth-close]', () => this.close());
    click(this.panel, '[data-account-logout]', () => void this.logout());
    this.root.querySelectorAll<HTMLInputElement>('input[name="dv-play-as"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        if (radio.checked) this.set({ playAsAccount: radio.value === 'account' });
      });
    });
    // Arrow keys move between the two tabs, as in any tab list.
    must(this.panel.querySelector('[role="tablist"]')).addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
      event.preventDefault();
      if (this.busy) return;
      const next: AccountView = this.view === 'login' ? 'register' : 'login';
      this.switchTo(next);
      must(this.panel.querySelector<HTMLElement>(`[role="tab"][data-auth-tab="${next}"]`)).focus();
    });

    this.panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.close();
    });
    must(this.security.querySelector('summary')).addEventListener('click', (event) => {
      if (this.busy) event.preventDefault();
    });
    this.security.addEventListener('toggle', () => {
      if (!this.security.open && !this.busy) {
        this.forms.manage.clearSecrets();
        this.forms.manage.clearErrors();
      }
    });
    // The page's game input handlers must not see typing in account fields.
    for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup', 'touchstart', 'touchend']) {
      this.panel.addEventListener(type, (event) => event.stopPropagation());
    }
    this.render();
    recovery.readLink();
  }

  async refresh(): Promise<void> {
    if (this.busy) return;
    const version = ++this.refreshVersion;
    try {
      const status = await this.api.me();
      if (version !== this.refreshVersion) return;
      this.loaded = true;
      this.set({ enabled: status.enabled, account: status.account ?? null });
      if (this.openView === 'manage') {
        if (this.current.account) {
          this.renderProfile();
          void this.dashboard.show(this.current.account.id);
        } else {
          this.forms.manage.reset();
          this.close();
        }
      }
    } catch {
      if (version !== this.refreshVersion) return;
      const wasLoaded = this.loaded;
      this.loaded = true;
      // A network failure says nothing about the cookie's validity. Keep the
      // last known identity; joining still requires a fresh account ticket.
      this.set(wasLoaded ? {} : { enabled: true });
      this.say('Accounts could not be refreshed. Try again in a moment.', 'warn');
    }
  }

  open(view: AccountView): void {
    if (this.locked || this.busy) return;
    if (view === 'manage' && !this.current.account) view = 'login';
    if (this.panel.hidden) this.returnFocus = this.doc.activeElement as HTMLElement | null;
    this.switchTo(view, false);
    this.playView.hidden = true;
    this.panel.hidden = false;
    this.onViewChange?.();
    this.focusView();
  }

  close(): void {
    if (this.busy || this.panel.hidden) return;
    this.panel.hidden = true;
    this.playView.hidden = false;
    this.window.closest('.dv-home-layout')?.classList.remove('is-managing');
    this.window.setAttribute('aria-label', 'Play');
    this.security.open = false;
    this.afterClose();
    this.onViewChange?.();
    const target =
      this.returnFocus?.isConnected &&
      this.playView.contains(this.returnFocus) &&
      !this.returnFocus.closest('[hidden]')
        ? this.returnFocus
        : this.root.querySelector<HTMLElement>(
            this.current.account ? '[data-account-manage]' : '[data-account-login]',
          );
    target?.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  /** The start screen is connecting: nothing here may change the account under it. */
  setLocked(locked: boolean): void {
    this.locked = locked;
    this.root
      .querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')
      .forEach((control) => {
        control.disabled = locked;
      });
  }

  /** The host no longer knows our session (seen by a ticket or password request). */
  sessionExpired(): void {
    this.set({ account: null, playAsAccount: true });
    this.forms.manage.reset();
    this.close();
    this.say(SESSION_EXPIRED, 'warn');
  }

  playAsGuest(): void {
    this.set({ playAsAccount: false });
  }

  private get busy(): boolean {
    return this.signingOut || Object.values(this.forms).some((f) => f.busy);
  }

  private switchTo(view: AccountView, focus = true): void {
    if (this.busy || (view === this.view && !this.panel.hidden)) return;
    const from = this.forms[this.view];
    const to = this.forms[view];
    // A name typed on one tab follows to the other.
    if (view !== 'manage' && this.view !== 'manage' && view !== this.view) {
      const name = from.value('name').trim();
      if (name && to.value('name') === '') to.input('name').value = name;
      from.clearErrors();
    }
    this.view = view;
    this.showAlert(null);
    const signedIn = view === 'manage';
    for (const [key, f] of Object.entries(this.forms)) f.el.hidden = key !== view;
    must(this.panel.querySelector<HTMLElement>('[role="tablist"]')).hidden = signedIn;
    this.panel.querySelectorAll<HTMLElement>('[data-auth-tab]').forEach((tab) => {
      const selected = tab.dataset['authTab'] === view;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    must(this.panel.querySelector('[data-auth-title]')).textContent = HEADINGS[view].title;
    const sub = must(this.panel.querySelector<HTMLElement>('[data-auth-sub]'));
    sub.textContent = HEADINGS[view].sub;
    sub.hidden = HEADINGS[view].sub === '';
    this.window.setAttribute('aria-label', HEADINGS[view].title);
    this.window.closest('.dv-home-layout')?.classList.toggle('is-managing', signedIn);
    this.security.open = false;
    if (signedIn) {
      this.renderProfile();
      void this.dashboard.show(this.current.account!.id);
    } else this.dashboard.clear();
    if (focus) this.focusView();
  }

  private focusView(): void {
    if (this.view === 'manage')
      must(this.panel.querySelector<HTMLElement>('[data-auth-title]')).focus({
        preventScroll: true,
      });
    else this.forms[this.view].focusFirst();
  }

  private syncNavigation(): void {
    const busy = this.busy;
    this.panel.setAttribute('aria-busy', String(busy));
    this.panel
      .querySelectorAll<HTMLButtonElement>(
        '[data-auth-close], [data-auth-tab], [data-account-logout], .dv-workspace-nav button',
      )
      .forEach((button) => {
        button.disabled = busy;
      });
    must(this.security.querySelector('summary')).setAttribute('aria-disabled', String(busy));
  }

  private afterClose(): void {
    this.dashboard.clear();
    this.showAlert(null);
    for (const f of Object.values(this.forms)) {
      f.clearSecrets();
      f.clearErrors();
    }
  }

  private set(patch: Partial<AccountState>): void {
    this.refreshVersion++;
    if ('account' in patch && patch.account?.id !== this.current.account?.id)
      this.dashboard.clear();
    this.current = { ...this.current, ...patch };
    this.render();
    this.onChange(this.current);
  }

  private render(): void {
    const { enabled, account, playAsAccount } = this.current;
    this.root.hidden = this.loaded && !enabled;
    this.root.dataset['state'] = !this.loaded ? 'loading' : account ? 'in' : 'out';
    must(this.root.querySelector<HTMLElement>('[data-account-out]')).hidden =
      !this.loaded || account !== null;
    must(this.root.querySelector<HTMLElement>('[data-account-in]')).hidden = account === null;
    must(this.root.querySelector<HTMLElement>('[data-account-loading]')).hidden = this.loaded;
    this.root.querySelectorAll('[data-account-name]').forEach((el) => {
      el.textContent = account?.name ?? '';
    });
    must(this.root.querySelector('[data-account-role]')).textContent = account
      ? [
          groupLabel(account.groupId),
          memberSince(account.createdAt) && `since ${memberSince(account.createdAt)}`,
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
    this.paintAvatars(account);
    this.root.querySelectorAll<HTMLInputElement>('input[name="dv-play-as"]').forEach((radio) => {
      radio.checked = (radio.value === 'account') === playAsAccount;
    });
  }

  private renderProfile(): void {
    const account = this.current.account;
    if (!account) return;
    const field = (name: string) =>
      must(this.panel.querySelector(`[data-account-field="${name}"]`));
    field('name').textContent = account.name;
    field('group').textContent = groupLabel(account.groupId);
    field('created').textContent = memberSince(account.createdAt) || '—';
    // Tells a password manager which account the new password belongs to.
    (field('name-autofill') as HTMLInputElement).value = account.name;
    this.paintAvatars(account);
  }

  private paintAvatars(account: AccountInfo | null): void {
    this.doc.querySelectorAll<HTMLElement>('[data-account-avatar]').forEach((avatar) => {
      avatar.textContent = account ? account.name.charAt(0).toUpperCase() : '';
      if (account) avatar.style.setProperty('--dv-avatar-hue', String(avatarHue(account.name)));
    });
  }

  private showAlert(text: string | null, tone: 'error' | 'success' = 'error'): void {
    this.alert.textContent = text ?? '';
    this.alert.dataset['tone'] = tone;
    this.alert.hidden = text === null;
  }

  /** A short line under the account strip, e.g. after signing in or out. */
  private say(text: string, tone: 'info' | 'warn' = 'info'): void {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.notice.textContent = text;
    this.notice.dataset['tone'] = tone;
    this.notice.hidden = false;
    this.noticeTimer = setTimeout(() => {
      this.notice.hidden = true;
      this.noticeTimer = null;
    }, this.noticeMs);
  }

  private async submit(view: AccountView): Promise<void> {
    const form = this.forms[view];
    if (
      this.busy ||
      this.panel.hidden ||
      view !== this.view ||
      (view === 'manage' && !this.security.open)
    )
      return;
    this.showAlert(null);
    if (form.validateAll() !== null) return;
    this.refreshVersion++;
    const busyLabel = { login: 'Signing in…', register: 'Creating account…', manage: 'Updating…' }[
      view
    ];
    form.setBusy(true, busyLabel);
    this.syncNavigation();
    try {
      if (view === 'login') {
        const account = await this.api.login(
          form.value('name').trim(),
          form.value('password'),
          form.input('remember').checked,
        );
        this.signedIn(account, `Signed in as ${account.name}.`);
      } else if (view === 'register') {
        const account = await this.api.register(
          form.value('name').trim(),
          form.value('password'),
          form.value('email').trim(),
          form.input('remember').checked,
        );
        this.signedIn(account, `Welcome, ${account.name}! Your survivor profile is ready.`);
      } else {
        await this.api.changePassword(form.value('current'), form.value('next'));
        form.reset();
        this.security.open = false;
        must(this.security.querySelector<HTMLElement>('summary')).focus();
        this.showAlert(
          'Password updated. Other browser sessions and your old recovery code have been revoked.',
          'success',
        );
        if (this.current.account) void this.dashboard.show(this.current.account.id);
      }
    } catch (error) {
      form.setBusy(false);
      this.failed(view, form, error);
    } finally {
      this.syncNavigation();
    }
  }

  private signedIn(account: AccountInfo, message: string): void {
    for (const view of ['login', 'register'] as const) this.forms[view].reset();
    this.set({ account, playAsAccount: true });
    this.close();
    this.say(message);
  }

  private failed(view: AccountView, form: AccountForm, error: unknown): void {
    if (!(error instanceof AccountApiError)) {
      this.showAlert('Something went wrong. Try again in a moment.');
      return;
    }
    const { status, message } = error;
    if (view === 'login' && status === 401) {
      this.showAlert(message);
      form.input('password').value = '';
      form.input('password').focus();
    } else if (view === 'register' && status === 409) {
      form.fail('name', message);
    } else if (view === 'register' && status === 400) {
      // The same rules ran here first, so this is rare; point at the right field.
      const field = /email/i.test(message)
        ? 'email'
        : /password/i.test(message)
          ? 'password'
          : 'name';
      form.fail(field, message);
    } else if (view === 'manage' && status === 401) {
      this.sessionExpired();
    } else if (view === 'manage' && status === 403) {
      form.fail('current', message, true);
    } else if (view === 'manage' && status === 400) {
      form.fail('next', message);
    } else {
      this.showAlert(message);
    }
  }

  private async logout(): Promise<void> {
    if (this.busy) return;
    this.refreshVersion++;
    this.signingOut = true;
    const button = must(this.panel.querySelector<HTMLButtonElement>('[data-account-logout]'));
    button.textContent = 'Signing out…';
    this.syncNavigation();
    try {
      await this.api.logout();
    } catch (error) {
      this.signingOut = false;
      button.textContent = 'Sign out';
      this.syncNavigation();
      this.showAlert(
        error instanceof Error
          ? `Sign out failed. ${error.message}`
          : 'Sign out failed. Try again.',
      );
      return;
    }
    this.signingOut = false;
    button.textContent = 'Sign out';
    this.syncNavigation();
    this.set({ account: null, playAsAccount: true });
    this.forms.manage.reset();
    this.close();
    this.say('You have signed out. You can keep playing as a guest.');
  }
}
