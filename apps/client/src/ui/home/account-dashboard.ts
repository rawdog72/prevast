// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { AccountCommunityPanel } from './account-community';
import type {
  AccountProgressInfo,
  AccountSessionInfo,
} from '../../../../../shared/typescript/account-profile';
import { emailError } from '../../../../../shared/typescript/account-rules';
import { AccountApiError, type AccountApi } from './account-api';
import { sectionTabs } from './section-tabs';

/** A spacious account workspace; each task has its own page. */
export class AccountDashboard {
  private community?: AccountCommunityPanel;
  private generation = 0;
  private working = false;
  private id: number | null = null;
  private page = 'overview';
  private selectPage: (page: string) => void;
  constructor(
    private readonly root: HTMLElement,
    private readonly api: AccountApi,
    private readonly signedOut: () => void,
    managementForm?: HTMLFormElement,
  ) {
    // Authored markup only. All server-provided values below use textContent.
    root.innerHTML = `
      <aside class="dv-workspace-sidebar">
        <div data-dashboard-profile></div>
        <nav class="dv-workspace-nav" aria-label="Account sections" aria-orientation="vertical">
          <button type="button" data-page="overview">Overview<span>Stats & achievements</span></button>
          <button type="button" data-page="activity">Activity<span>Sessions & golden caps</span></button>
          <button type="button" data-page="clan">Clan<span>Members & management</span></button>
          <button type="button" data-page="security">Security<span>Password & recovery</span></button>
        </nav>
        <div data-dashboard-signout></div>
      </aside>
      <div class="dv-workspace-content">
        <div class="dv-account-section-head"><div><p class="dv-eyebrow">SURVIVOR ACCOUNT</p><h3 data-page-title>Overview</h3></div><button type="button" class="dv-btn is-small" data-refresh>Refresh</button></div>
        <section data-dashboard-page="overview">
          <p class="dv-account-hint">Your lifetime progress and achievements. Recent play may take a moment to appear.</p>
          <div data-community-summary></div>
          <div data-progress aria-live="polite"></div>
        </section>
        <section data-dashboard-page="activity" hidden><p class="dv-account-hint">Track your survivor sessions and how you earn and spend golden caps.</p><div data-community-activity></div></section>
        <section data-dashboard-page="clan" hidden><p class="dv-account-hint">Build your permanent clan and compete together throughout the season.</p><div data-community></div></section>
        <section data-dashboard-page="security" hidden>
          <p class="dv-account-hint">Manage your password, recovery options and signed-in devices.</p>
          <div class="dv-security-grid">
          <section class="dv-workspace-card" data-password-panel></section>
          <section class="dv-workspace-card"><h4>Account recovery</h4>
        <p data-security-status></p>
        <label class="dv-field">Recovery email<input data-email type="email" maxlength="255" autocomplete="email"></label>
        <label class="dv-field">Current password<input data-password type="password" maxlength="128" autocomplete="current-password"></label>
        <div class="dv-account-actions"><button type="button" class="dv-btn" data-verify>Send verification email</button><button type="button" class="dv-btn" data-code>Create recovery code</button></div>
        <p class="dv-account-hint">A recovery code works once. Creating another code or changing your password invalidates the old code.</p>
        <label class="dv-field" data-code-result hidden>Save this code somewhere private. It will only be shown here once.<textarea data-code-value readonly rows="2" spellcheck="false"></textarea></label>
          </section></div>
      <section class="dv-workspace-card dv-devices-card"><h4>Signed-in devices</h4>
        <p class="dv-account-hint">These are browser sign-ins. Signing out does not immediately close games already connected.</p>
        <div data-sessions></div><button type="button" class="dv-btn" data-revoke-all>Sign out everywhere</button>
      </section></section><p data-dashboard-status role="status" aria-live="polite" hidden></p></div>`;
    if (managementForm) {
      const profile = this.get('[data-dashboard-profile]');
      for (const selector of ['.dv-profile', '.dv-profile-facts']) {
        const element = managementForm.querySelector(selector);
        if (element) profile.append(element);
      }
      const signout = managementForm.querySelector('.dv-auth-foot');
      if (signout) this.get('[data-dashboard-signout]').append(signout);
      this.get('[data-password-panel]').append(managementForm);
    } else this.get('[data-password-panel]').hidden = true;
    const pages = Object.fromEntries(
      [...root.querySelectorAll<HTMLElement>('[data-dashboard-page]')].map((page) => [
        page.dataset.dashboardPage!,
        page,
      ]),
    );
    this.selectPage = sectionTabs(this.get('.dv-workspace-nav'), pages, 'dv-account', (page) => {
      this.page = page;
      const window = this.root.closest<HTMLElement>('#dv-start-window');
      if (window) window.scrollTop = 0;
      this.get('[data-page-title]').textContent =
        { overview: 'Overview', activity: 'Activity', clan: 'Your clan', security: 'Security' }[
          page
        ] ?? page;
      if (page === 'security') {
        const password =
          managementForm?.querySelector<HTMLDetailsElement>('[data-account-security]');
        if (password) password.open = true;
      }
    });
    this.selectPage('overview');
    if (api.community)
      this.community = new AccountCommunityPanel(
        this.get<HTMLElement>('[data-community]'),
        api.community,
        {
          summary: this.get('[data-community-summary]'),
          activity: this.get('[data-community-activity]'),
        },
      );
    else {
      this.get<HTMLButtonElement>('[data-page="activity"]').hidden = true;
      this.get<HTMLButtonElement>('[data-page="clan"]').hidden = true;
    }
    this.get<HTMLButtonElement>('[data-refresh]').onclick = () => {
      if (this.id !== null && !this.working) void this.show(this.id);
    };
    this.get<HTMLButtonElement>('[data-verify]').onclick = () =>
      void this.run(async () => {
        const generation = this.generation;
        const email = this.get<HTMLInputElement>('[data-email]').value.trim();
        const problem = !email ? 'Enter your email address.' : emailError(email);
        if (problem) throw new Error(problem);
        await api.verifyEmail(email, this.password());
        if (generation !== this.generation) return;
        this.message('Verification email sent. Open its link, then refresh your account here.');
      });
    this.get<HTMLButtonElement>('[data-code]').onclick = () =>
      void this.run(async () => {
        const generation = this.generation;
        const code = await api.recoveryCode(this.password());
        if (generation !== this.generation) return;
        this.get<HTMLTextAreaElement>('[data-code-value]').value = code;
        this.get<HTMLElement>('[data-code-result]').hidden = false;
        this.get<HTMLTextAreaElement>('[data-code-value]').focus();
        this.message('Recovery code created. Save it before closing your account.');
      });
    this.get<HTMLButtonElement>('[data-revoke-all]').onclick = () => void this.revoke('all');
  }

  private get<T extends HTMLElement>(selector: string): T {
    return this.root.querySelector<T>(selector)!;
  }
  private password(): string {
    const password = this.get<HTMLInputElement>('[data-password]').value;
    if (!password) throw new Error('Enter your current password.');
    return password;
  }
  private message(text: string, error = false): void {
    const status = this.get<HTMLElement>('[data-dashboard-status]');
    status.textContent = text;
    status.hidden = false;
    status.dataset.tone = error ? 'error' : 'success';
  }

  clear(): void {
    this.community?.clear();
    this.id = null;
    this.generation++;
    this.root.hidden = true;
    this.get<HTMLInputElement>('[data-password]').value = '';
    this.get<HTMLInputElement>('[data-email]').value = '';
    this.get<HTMLTextAreaElement>('[data-code-value]').value = '';
    this.get<HTMLElement>('[data-code-result]').hidden = true;
    this.get<HTMLElement>('[data-dashboard-status]').hidden = true;
    for (const selector of ['[data-progress]', '[data-sessions]', '[data-security-status]'])
      this.get<HTMLElement>(selector).replaceChildren();
    this.root.querySelectorAll('details').forEach((section) => {
      section.open = false;
    });
  }

  async show(id: number): Promise<void> {
    const page = this.id === id ? this.page : 'overview';
    this.clear();
    this.id = id;
    this.root.hidden = false;
    this.selectPage(page);
    void this.community?.show();
    const generation = this.generation;
    const progress = this.get<HTMLElement>('[data-progress]');
    const sessions = this.get<HTMLElement>('[data-sessions]');
    const security = this.get<HTMLElement>('[data-security-status]');
    progress.textContent = 'Loading your progress…';
    sessions.textContent = 'Loading devices…';
    security.textContent = 'Loading recovery settings…';
    const results = await Promise.allSettled([
      this.api.progress(),
      this.api.sessions(),
      this.api.security(),
    ] as const);
    if (generation !== this.generation) return;
    const [p, s, r] = results;
    if (
      results.some(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof AccountApiError &&
          result.reason.status === 401,
      )
    ) {
      this.signedOut();
      return;
    }
    if (p.status === 'fulfilled') this.renderProgress(p.value);
    else progress.textContent = 'Progress could not be loaded. Try Refresh.';
    if (s.status === 'fulfilled') this.renderSessions(s.value);
    else sessions.textContent = 'Devices could not be loaded. Try Refresh.';
    if (r.status === 'fulfilled') {
      security.textContent = `${r.value.emailVerified ? 'Recovery email verified.' : 'No verified recovery email.'} ${r.value.hasRecoveryCode ? 'A recovery code is active.' : 'No recovery code saved.'}`;
      if (!r.value.emailAvailable)
        security.textContent += ' Email delivery is unavailable; use a recovery code.';
      this.get<HTMLInputElement>('[data-email]').value = r.value.email;
      this.get<HTMLButtonElement>('[data-verify]').disabled = !r.value.emailAvailable;
    } else security.textContent = 'Recovery settings could not be loaded. Try Refresh.';
  }

  private async run(work: () => Promise<void>): Promise<void> {
    if (this.working || this.id === null) return;
    this.working = true;
    const generation = this.generation;
    this.root.setAttribute('aria-busy', 'true');
    try {
      await work();
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof AccountApiError && error.status === 401) this.signedOut();
      else
        this.message(
          error instanceof Error ? error.message : 'Something went wrong. Try again.',
          true,
        );
    } finally {
      this.working = false;
      this.root.removeAttribute('aria-busy');
      this.get<HTMLInputElement>('[data-password]').value = '';
    }
  }

  private async revoke(id: string): Promise<void> {
    await this.run(async () => {
      const generation = this.generation;
      const signedOut = await this.api.revokeSession(id);
      if (generation !== this.generation) return;
      if (signedOut) this.signedOut();
      else {
        const sessions = await this.api.sessions();
        if (generation !== this.generation) return;
        this.renderSessions(sessions);
        this.message('That browser session has been signed out.');
      }
    });
  }

  private element(tag: string, text: string, className = ''): HTMLElement {
    const element = this.root.ownerDocument.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
  }
  private renderSessions(sessions: AccountSessionInfo[]): void {
    const list = this.get<HTMLElement>('[data-sessions]');
    list.replaceChildren();
    for (const session of sessions) {
      const row = this.element('div', '', 'dv-account-device');
      const info = this.element('div', '');
      info.append(
        this.element('strong', `${session.device}${session.current ? ' · This device' : ''}`),
        this.element(
          'p',
          `Last used ${new Date(session.lastUsedAt).toLocaleString()}`,
          'dv-account-hint',
        ),
      );
      const button = this.element('button', 'Sign out', 'dv-link') as HTMLButtonElement;
      button.type = 'button';
      button.onclick = () => void this.revoke(session.id);
      row.append(info, button);
      list.append(row);
    }
  }
  private renderProgress(progress: AccountProgressInfo): void {
    const root = this.get<HTMLElement>('[data-progress]');
    root.replaceChildren();
    const unlocked = progress.achievements.filter((a) => a.unlockedAt !== null);
    root.append(
      this.element(
        'p',
        `${unlocked.length} / ${progress.achievements.length} achievements · ${unlocked.reduce((sum, a) => sum + a.points, 0)} points`,
        'dv-account-summary',
      ),
    );
    const stats = this.element('dl', '', 'dv-profile-facts');
    for (const stat of progress.stats)
      stats.append(this.element('dt', stat.name), this.element('dd', stat.value.toLocaleString()));
    root.append(stats);
    const list = this.element('section', '', 'dv-profile-achievements');
    list.append(this.element('h4', 'Achievements'));
    for (const achievement of [...progress.achievements].sort(
      (a, b) => Number(b.unlockedAt !== null) - Number(a.unlockedAt !== null),
    )) {
      const row = this.element('article', '', 'dv-account-achievement');
      row.append(
        this.element('strong', `${achievement.unlockedAt !== null ? '✓ ' : ''}${achievement.name}`),
        this.element('p', achievement.description),
      );
      if (achievement.unlockedAt !== null)
        row.append(
          this.element(
            'small',
            `Unlocked ${new Date(achievement.unlockedAt * 1000).toLocaleDateString()}`,
          ),
        );
      else if (achievement.progress > 0) {
        const bar = this.root.ownerDocument.createElement('progress');
        bar.max = 1;
        bar.value = achievement.progress;
        bar.setAttribute(
          'aria-label',
          `${achievement.name}: ${Math.round(achievement.progress * 100)}%`,
        );
        row.append(bar);
      }
      list.append(row);
    }
    root.append(list);
    if (!progress.achievements.length)
      list.append(
        this.element('p', 'Your achievements will appear here as you play.', 'dv-account-hint'),
      );
  }
}
