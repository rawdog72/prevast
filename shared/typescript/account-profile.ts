// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

export interface AccountSessionInfo {
  id: string;
  device: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  current: boolean;
}

export interface AccountSecurityInfo {
  email: string;
  emailVerified: boolean;
  emailAvailable: boolean;
  hasRecoveryCode: boolean;
}

export interface AccountProgressInfo {
  stats: { id: number; name: string; value: number }[];
  achievements: {
    id: number;
    name: string;
    description: string;
    points: number;
    unlockedAt: number | null;
    progress: number;
  }[];
}
