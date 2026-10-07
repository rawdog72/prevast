// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { emailError, passwordError } from '../../../../../shared/typescript/account-rules';
import type { AccountApi } from './account-api';

type Mode = 'request' | 'code' | 'reset' | 'verify';

export class AccountRecovery {
  private dialog: HTMLDialogElement | null = null;
  private busy = false;
  constructor(
    private readonly doc: Document,
    private readonly api: AccountApi,
    private readonly changed: () => void,
  ) {}

  /** Fragments never reach the HTTP server or referrer. Remove them from history immediately. */
  readLink(): void {
    const view = this.doc.defaultView;
    if (!view) return;
    const match = /^#account-(verify|reset)=([A-Za-z0-9_-]{43})$/.exec(view.location.hash);
    if (!match) return;
    view.history.replaceState(null, '', view.location.pathname + view.location.search);
    this.open(match[1] as Mode, match[2]!);
  }

  open(mode: Mode = 'request', token = ''): void {
    if (this.busy) return;
    this.dialog?.remove();
    const dialog = this.doc.createElement('dialog');
    this.dialog = dialog;
    dialog.className = 'dv-recovery-dialog';
    dialog.setAttribute('aria-labelledby', 'dv-recovery-title');
    const title =
      mode === 'verify'
        ? 'Verify recovery email'
        : mode === 'request'
          ? 'Recover your account'
          : 'Choose a new password';
    const input = (name: string, label: string, type: string, autocomplete: string, max: number) =>
      `<label class="dv-field" for="dv-recovery-${name}">${label}<input id="dv-recovery-${name}" name="${name}" type="${type}" autocomplete="${autocomplete}" maxlength="${max}" required></label>`;
    dialog.innerHTML = `<h2 id="dv-recovery-title">${title}</h2><form novalidate><fieldset>
      ${mode === 'request' || mode === 'code' ? input('name', 'Account name', 'text', 'username', 16) : ''}
      ${mode === 'request' ? input('email', 'Verified recovery email', 'email', 'email', 255) : ''}
      ${mode === 'code' ? input('code', 'Recovery code', 'text', 'off', 64) : ''}
      ${mode === 'reset' || mode === 'code' ? input('next', 'New password', 'password', 'new-password', 128) + input('confirm', 'Confirm new password', 'password', 'new-password', 128) : ''}
      ${mode === 'verify' ? '<p>Confirm this address as your account’s recovery email.</p>' : ''}
      <p data-result role="status" aria-live="polite" hidden></p>
      <button type="submit" class="dv-btn is-primary">${mode === 'verify' ? 'Verify email' : mode === 'request' ? 'Send reset link' : 'Reset password'}</button>
      ${mode === 'request' ? '<button type="button" class="dv-link" data-code>Use a recovery code</button>' : ''}
      </fieldset><button type="button" class="dv-link" data-close>Close</button></form>`;
    const result = dialog.querySelector<HTMLElement>('[data-result]')!;
    const form = dialog.querySelector('form')!;
    const fields = dialog.querySelector('fieldset')!;
    const submit = dialog.querySelector<HTMLButtonElement>('button[type=submit]')!;
    const close = dialog.querySelector<HTMLButtonElement>('[data-close]')!;
    const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
    close.onclick = () => {
      if (!this.busy) dialog.close();
    };
    dialog.addEventListener('cancel', (event) => {
      if (this.busy) event.preventDefault();
    });
    dialog.addEventListener('close', () => {
      form.reset();
      dialog.remove();
      if (this.dialog === dialog) this.dialog = null;
    });
    dialog
      .querySelector<HTMLButtonElement>('[data-code]')
      ?.addEventListener('click', () => this.open('code'));
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (this.busy) return;
      result.hidden = true;
      const problem =
        mode === 'request'
          ? !value('name').trim()
            ? 'Enter your account name.'
            : !value('email').trim()
              ? 'Enter your verified email address.'
              : emailError(value('email').trim())
          : mode === 'verify'
            ? null
            : (passwordError(value('next')) ??
              (value('next') !== value('confirm') ? 'The passwords do not match.' : null) ??
              (mode === 'code' && (!value('name').trim() || !value('code').trim())
                ? 'Enter your account name and recovery code.'
                : null));
      if (problem) {
        result.textContent = problem;
        result.hidden = false;
        return;
      }
      this.busy = true;
      fields.disabled = true;
      close.disabled = true;
      try {
        if (mode === 'request') {
          await this.api.requestReset(value('name').trim(), value('email').trim());
          result.textContent =
            'If those details match an account with a verified email, a reset link will arrive shortly. Check your spam folder too.';
        } else if (mode === 'verify') {
          await this.api.confirmEmail(token);
          result.textContent = 'Email verified. You can now use it to recover your account.';
          submit.hidden = true;
          this.changed();
        } else {
          await this.api.resetPassword(
            mode === 'code'
              ? { name: value('name').trim(), code: value('code').trim(), next: value('next') }
              : { token, next: value('next') },
          );
          form.reset();
          result.textContent =
            'Password reset. All browser sessions and your old recovery code have been revoked. Close this window and sign in.';
          submit.hidden = true;
          this.changed();
        }
      } catch (error) {
        result.textContent =
          error instanceof Error ? error.message : 'Could not complete recovery. Try again.';
      } finally {
        this.busy = false;
        fields.disabled = false;
        close.disabled = false;
        result.hidden = false;
      }
    };
    // Game input listeners must not treat recovery typing as gameplay input.
    for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup', 'touchstart', 'touchend'])
      dialog.addEventListener(type, (e) => e.stopPropagation());
    this.doc.body.append(dialog);
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>('input')?.focus();
  }
}
