// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Account name, password and email rules. The web host enforces them
// (apps/web/src/accounts); the start page checks the same rules as the player
// types, so a form never submits what the host would refuse.
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const NAME_MIN = 3;
export const NAME_MAX = 16;
export const EMAIL_MAX = 255;
// '|' is the ticket field separator, so it must never be legal in a name.
const NAME_PATTERN = /^[A-Za-z0-9 _.-]{3,16}$/;
const EMAIL_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+$/;

export function accountNameError(name: string): string | null {
  if (!NAME_PATTERN.test(name))
    return 'Names are 3-16 characters: letters, digits, space, _ - and .';
  // An all-digit value is always an in-game id to !setgroup.
  if (!/[A-Za-z]/.test(name)) return 'A name needs at least one letter.';
  if (name !== name.trim() || name.includes('  ')) return 'No leading, trailing or double spaces.';
  return null;
}

export function passwordError(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Passwords need at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Passwords are at most ${PASSWORD_MAX} characters.`;
  return null;
}

/** '' (no email) is fine: the email is optional. */
export function emailError(email: string): string | null {
  if (!email) return null;
  return email.length > EMAIL_MAX || !EMAIL_PATTERN.test(email)
    ? 'That email address does not look right.'
    : null;
}
