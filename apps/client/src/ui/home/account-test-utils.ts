// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { vi } from 'vitest';
import type { AccountApi } from './account-api';

export function accountControlsStub(): Pick<
  AccountApi,
  | 'security'
  | 'sessions'
  | 'revokeSession'
  | 'recoveryCode'
  | 'verifyEmail'
  | 'confirmEmail'
  | 'requestReset'
  | 'resetPassword'
  | 'progress'
> {
  return {
    security: vi.fn(async () => ({
      email: '',
      emailVerified: false,
      emailAvailable: true,
      hasRecoveryCode: false,
    })),
    sessions: vi.fn(async () => []),
    revokeSession: vi.fn(async () => false),
    recoveryCode: vi.fn(async () => 'recovery-code'),
    verifyEmail: vi.fn(async () => {}),
    confirmEmail: vi.fn(async () => {}),
    requestReset: vi.fn(async () => {}),
    resetPassword: vi.fn(async () => {}),
    progress: vi.fn(async () => ({ stats: [], achievements: [] })),
  };
}
