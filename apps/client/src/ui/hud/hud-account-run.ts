// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
import type { NetEventBus } from '../../net/events';

/** A server-fed progress line; never calculates or grants account currency. */
export function mountAccountRun(root: HTMLElement, bus: NetEventBus): () => void {
  const host = root.ownerDocument.createElement('div');
  host.className = 'hud-account-run dv-panel';
  host.hidden = true;
  const label = root.ownerDocument.createElement('span');
  const progress = root.ownerDocument.createElement('progress');
  progress.setAttribute('aria-label', 'Progress to next golden cap');
  host.append(label, progress);
  root.append(host);
  const remove = bus.on('accountRun', (run) => {
    host.hidden = false;
    label.textContent = run.ranked
      ? run.scoreCaps +
        ' golden caps this life · ' +
        (run.earnedScore % run.scorePerCap).toLocaleString() +
        ' / ' +
        run.scorePerCap.toLocaleString()
      : 'Account session · unranked';
    progress.hidden = !run.ranked;
    progress.max = run.scorePerCap;
    progress.value = run.earnedScore % run.scorePerCap;
    host.title =
      '1 golden cap per ' +
      run.scorePerCap.toLocaleString() +
      ' eligible score. Earned caps survive death.';
  });
  return () => {
    remove();
    host.remove();
  };
}
