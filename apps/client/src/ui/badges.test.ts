// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { badgeNodes, badgesFor } from './badges';

const groups = new Map([
  [3, { id: 3, name: 'gamemaster', badge: 'gamemaster' }],
  [9, { id: 9, name: 'odd', badge: 'unknown-key' }],
]);

describe('badges', () => {
  it('shows verified first, then the group badge', () => {
    expect(badgesFor({ verified: true, groupId: 3 }, groups).map((b) => b.key)).toEqual(['verified', 'gamemaster']);
  });
  it('shows nothing for a guest in a badge-less or unknown group', () => {
    expect(badgesFor({ verified: false, groupId: 1 }, groups)).toEqual([]);
    expect(badgesFor({ verified: false, groupId: 9 }, groups)).toEqual([]);
    expect(badgesFor(undefined, groups)).toEqual([]);
  });
  it('does not resolve inherited object keys as badges', () => {
    const odd = new Map([[5, { id: 5, name: 'odd', badge: 'constructor' }], [6, { id: 6, name: 'odd', badge: '__proto__' }]]);
    expect(badgesFor({ verified: false, groupId: 5 }, odd)).toEqual([]);
    expect(badgesFor({ verified: false, groupId: 6 }, odd)).toEqual([]);
  });

  it('renders accessible spans', () => {
    const [node] = badgeNodes(document, badgesFor({ verified: true, groupId: 1 }, groups));
    expect(node!.className).toBe('dv-badge dv-badge-verified');
    expect(node!.getAttribute('aria-label')).toBe('Verified account');
  });
});
