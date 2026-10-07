// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// npm run release:audit -- every check in audit.ts over the tracked files.
// Exits 1 when anything is found.

import { readManifest } from '../assets/original-assets';
import { auditRepo, listTrackedFiles } from './audit';

const files = listTrackedFiles('.');
if (!files) {
  console.error('release:audit needs a Git checkout.');
  process.exit(2);
}
const findings = auditRepo('.', files, readManifest());
const byCheck = new Map<string, number>();
for (const finding of findings) {
  byCheck.set(finding.check, (byCheck.get(finding.check) ?? 0) + 1);
  console.log(`${finding.check}  ${finding.file}  ${finding.detail}`);
}
if (findings.length === 0) {
  console.log(`release audit: ${files.length} tracked files, nothing found`);
} else {
  console.log(`\nrelease audit: ${[...byCheck].map(([check, n]) => `${n} ${check}`).join(', ')}`);
  process.exit(1);
}
