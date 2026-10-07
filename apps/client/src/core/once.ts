// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

/**
 * Runs `load` at most once while it succeeds (or is still running), sharing
 * the one promise with every caller. A failure is forgotten, so the next call
 * tries again -- a "Retry" after a network blip must not be handed the same
 * cached rejection until the page is reloaded.
 */
export function onceUnlessFailed<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      const attempt = load();
      pending = attempt;
      attempt.catch(() => {
        if (pending === attempt) pending = null;
      });
    }
    return pending;
  };
}
