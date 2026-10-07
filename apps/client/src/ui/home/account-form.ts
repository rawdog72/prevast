// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// One form of the account dialog: inline field errors, show/hide password,
// the Caps Lock hint, the strength meter and the busy state. It knows nothing
// about the API; AccountPanel decides what a submit does.
//
// Errors follow the usual pattern: nothing is flagged while the player is
// still typing a field for the first time; leaving a filled-in field checks
// it; a field that shows an error re-checks on every keystroke so the message
// goes away as soon as it is fixed; submitting checks everything.

/** Returns an error for the field's value, or null when it is fine. */
export type FieldRule = (value: string, form: AccountForm) => string | null;

export const STRENGTH_LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'] as const;

/** 0 (below the minimum) .. 4; a hint for the player, not a rule. */
export function passwordStrength(password: string, min = 8): number {
  if (password.length < min) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  let score = 1;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (classes >= 3) score++;
  else if (classes <= 1 && password.length < 16) score--;
  return Math.max(1, Math.min(4, score));
}

export class AccountForm {
  private readonly touched = new Set<string>();
  private readonly fieldset: HTMLFieldSetElement;
  private readonly submitButton: HTMLButtonElement;
  private readonly submitLabel: HTMLElement;
  private readonly idleLabel: string;

  constructor(
    readonly el: HTMLFormElement,
    private readonly rules: Record<string, FieldRule>,
  ) {
    this.fieldset = must(el.querySelector('fieldset'));
    this.submitButton = must(el.querySelector<HTMLButtonElement>('button[type="submit"]'));
    this.submitLabel = must(this.submitButton.querySelector<HTMLElement>('[data-label]'));
    this.idleLabel = this.submitLabel.textContent ?? '';

    for (const name of Object.keys(rules)) {
      const input = this.input(name);
      input.addEventListener('input', () => {
        if (this.hasError(name)) this.validate(name);
        // A changed password makes an already-checked confirmation stale.
        for (const other of this.dependents(name)) {
          if (this.touched.has(other) || this.hasError(other)) this.validate(other);
        }
      });
      input.addEventListener('blur', () => {
        if (input.value === '' && !this.hasError(name)) return;
        this.touched.add(name);
        this.validate(name);
      });
    }
    el.querySelectorAll<HTMLButtonElement>('[data-reveal]').forEach((button) => {
      button.addEventListener('click', () => this.reveal(button, button.getAttribute('aria-pressed') !== 'true'));
    });
    el.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => {
      const hint = input.closest('.dv-field')?.querySelector<HTMLElement>('[data-caps]');
      if (!hint) return;
      const update = (event: KeyboardEvent) => {
        hint.hidden = !(event.getModifierState?.('CapsLock') ?? false);
      };
      input.addEventListener('keydown', update);
      input.addEventListener('keyup', update);
      input.addEventListener('blur', () => {
        hint.hidden = true;
      });
    });
    const meter = el.querySelector<HTMLElement>('[data-strength]');
    if (meter) {
      const input = this.input(meter.dataset['strength'] ?? 'password');
      input.addEventListener('input', () => this.renderStrength(meter, input.value));
    }
  }

  input(name: string): HTMLInputElement {
    return must(this.el.elements.namedItem(name) as HTMLInputElement | null);
  }

  value(name: string): string {
    return this.input(name).value;
  }

  get busy(): boolean {
    return this.fieldset.disabled;
  }

  /** Anything typed that closing the dialog would throw away. */
  get dirty(): boolean {
    return Object.keys(this.rules).some((name) => this.value(name) !== '');
  }

  /** Checks one field and shows or clears its message. */
  validate(name: string): boolean {
    const rule = this.rules[name];
    const error = rule ? rule(this.value(name), this) : null;
    this.setError(name, error);
    return error === null;
  }

  /** Checks every field; focuses and returns the first bad one, or null. */
  validateAll(): string | null {
    let first: string | null = null;
    for (const name of Object.keys(this.rules)) {
      this.touched.add(name);
      if (!this.validate(name) && first === null) first = name;
    }
    if (first !== null) this.input(first).focus();
    return first;
  }

  setError(name: string, message: string | null): void {
    const input = this.input(name);
    const slot = this.errorSlot(name);
    input.setAttribute('aria-invalid', String(message !== null));
    input.closest('.dv-field')?.classList.toggle('is-invalid', message !== null);
    if (slot) {
      slot.textContent = message ?? '';
      slot.hidden = message === null;
    }
  }

  /** Shows a server's answer against one field and puts the cursor there. */
  fail(name: string, message: string, clear = false): void {
    if (clear) this.input(name).value = '';
    this.setError(name, message);
    this.input(name).focus();
  }

  setBusy(busy: boolean, label?: string): void {
    this.fieldset.disabled = busy;
    this.el.setAttribute('aria-busy', String(busy));
    this.submitButton.classList.toggle('is-busy', busy);
    this.submitLabel.textContent = busy ? (label ?? this.idleLabel) : this.idleLabel;
  }

  /** First empty field, else the first one. */
  focusFirst(): void {
    const names = Object.keys(this.rules);
    const target = names.find((name) => this.value(name) === '') ?? names[0];
    if (target) this.input(target).focus();
  }

  clearErrors(): void {
    this.touched.clear();
    for (const name of Object.keys(this.rules)) this.setError(name, null);
  }

  /** Empties the password fields and hides what they held. */
  clearSecrets(): void {
    this.el.querySelectorAll<HTMLInputElement>('input[type="password"], input[data-secret]').forEach((input) => {
      input.value = '';
    });
    this.el.querySelectorAll<HTMLButtonElement>('[data-reveal]').forEach((button) => this.reveal(button, false));
    this.el.querySelectorAll<HTMLElement>('[data-caps]').forEach((hint) => {
      hint.hidden = true;
    });
    const meter = this.el.querySelector<HTMLElement>('[data-strength]');
    if (meter) this.renderStrength(meter, '');
  }

  reset(): void {
    this.clearSecrets();
    this.el.reset();
    this.clearErrors();
    this.setBusy(false);
  }

  private hasError(name: string): boolean {
    return this.input(name).getAttribute('aria-invalid') === 'true';
  }

  /** Fields whose rule reads `name` (the confirmation fields). */
  private dependents(name: string): string[] {
    return Object.keys(this.rules).filter((other) => this.input(other).dataset['matches'] === name);
  }

  private errorSlot(name: string): HTMLElement | null {
    const id = this.input(name).getAttribute('aria-describedby')?.split(/\s+/).find((ref) => ref.endsWith('-error'));
    return id ? this.el.ownerDocument.getElementById(id) : null;
  }

  private reveal(button: HTMLButtonElement, show: boolean): void {
    const input = button.closest('.dv-input-wrap')?.querySelector('input');
    if (!input) return;
    // Remember which fields are secret: a revealed one is type="text".
    input.dataset['secret'] = '';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(show));
    button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    button.textContent = show ? 'Hide' : 'Show';
  }

  private renderStrength(meter: HTMLElement, password: string): void {
    const level = password === '' ? -1 : passwordStrength(password);
    meter.dataset['level'] = String(level);
    const text = meter.querySelector<HTMLElement>('[data-strength-text]');
    if (text) text.textContent = level < 0 ? '' : STRENGTH_LABELS[level];
  }
}

function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing account form element in apps/client/public/index.html');
  return value;
}
