// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { DisconnectReason } from '../../net/opcodes';
import {
  describeDisconnect,
  describeJoinFailure,
  joinStageText,
  reconnectingView,
  rejoiningView,
  waitingForNetworkView,
} from './join-messages';

const ctx = { serverName: 'EU-1', maxPlayers: 40 };
const info = { attempt: 1, attempts: 4 };

describe('joinStageText', () => {
  it('names each stage, with the server where it helps', () => {
    expect(joinStageText('content', info, ctx)).toBe('Loading game data…');
    expect(joinStageText('ticket', info, ctx)).toBe('Signing in…');
    expect(joinStageText('connecting', info, ctx)).toBe('Connecting to EU-1…');
    expect(joinStageText('syncing', info, ctx)).toBe('Syncing content…');
    expect(joinStageText('logging-in', info, ctx)).toBe('Joining EU-1…');
  });

  it('counts down a retry, naming the next attempt', () => {
    expect(
      joinStageText(
        'waiting',
        { attempt: 1, attempts: 4, retryInMs: 4_200, reason: DisconnectReason.STARTING_UP },
        ctx,
      ),
    ).toBe('EU-1 is starting up — retrying in 5s (attempt 2/4)');
    expect(
      joinStageText(
        'waiting',
        { attempt: 2, attempts: 4, retryInMs: 0, reason: DisconnectReason.MAINTENANCE },
        ctx,
      ),
    ).toBe('EU-1 is under maintenance — retrying in 1s (attempt 3/4)');
  });
});

describe('describeJoinFailure', () => {
  it('gives every reason code a title, at join and in game', () => {
    for (const reason of Object.values(DisconnectReason)) {
      expect(
        describeJoinFailure({ kind: 'rejected', reason, detail: '' }, ctx).title,
        `join ${reason}`,
      ).not.toBe('');
      expect(
        describeDisconnect({ kind: 'reason', reason, detail: '' }, ctx).title,
        `game ${reason}`,
      ).not.toBe('');
    }
  });

  it('explains a full server with its slot count and offers retry or another server', () => {
    expect(
      describeJoinFailure(
        { kind: 'rejected', reason: DisconnectReason.SERVER_FULL, detail: '' },
        ctx,
      ),
    ).toEqual({
      tone: 'warn',
      title: 'Server is full',
      message: 'All 40 slots are taken. Try again shortly or pick another server.',
      detail: '',
      actions: ['retry', 'choose-server'],
    });
    expect(
      describeJoinFailure(
        { kind: 'rejected', reason: DisconnectReason.SERVER_FULL, detail: '' },
        { serverName: 'x' },
      ).message,
    ).toBe('All slots are taken. Try again shortly or pick another server.');
  });

  it('shows ban detail and offers nothing to click', () => {
    const notice = describeJoinFailure(
      {
        kind: 'rejected',
        reason: DisconnectReason.IP_BANNED,
        detail: 'Permanent. Banned by Admin.\nReason: spam',
      },
      ctx,
    );
    expect(notice.title).toBe('You are banned from this server');
    expect(notice.detail).toBe('Permanent. Banned by Admin.\nReason: spam');
    expect(notice.actions).toEqual([]);
  });

  it('turns an unknown code into a generic refusal that shows the detail', () => {
    const notice = describeJoinFailure(
      { kind: 'rejected', reason: 200 as DisconnectReason, detail: 'custom' },
      ctx,
    );
    expect(notice.title).toBe("Couldn't join");
    expect(notice.detail).toBe('custom');
    expect(notice.actions).toEqual(['retry']);
  });

  it('covers the client-side outcomes', () => {
    expect(describeJoinFailure({ kind: 'unreachable' }, ctx)).toMatchObject({
      title: "Can't reach server",
      actions: ['retry', 'choose-server'],
    });
    expect(describeJoinFailure({ kind: 'timed-out' }, ctx).title).toBe("Server isn't responding");
    expect(describeJoinFailure({ kind: 'dropped' }, ctx).title).toBe(
      'Connection closed while joining',
    );
    expect(describeJoinFailure({ kind: 'content-failed' }, ctx).title).toBe(
      "Couldn't load game data",
    );
    expect(
      describeJoinFailure(
        { kind: 'outdated', text: 'Only clients with protocol 14.10 allowed!' },
        ctx,
      ),
    ).toMatchObject({
      title: 'Game update required',
      detail: 'Only clients with protocol 14.10 allowed!',
      actions: ['refresh'],
    });
  });
});

describe('describeDisconnect', () => {
  it('lets a kicked or idle player reconnect', () => {
    expect(
      describeDisconnect({ kind: 'reason', reason: DisconnectReason.KICKED, detail: '' }, ctx),
    ).toMatchObject({
      title: 'You were kicked',
      busy: false,
      actions: ['reconnect', 'main-menu'],
    });
    expect(
      describeDisconnect({ kind: 'reason', reason: DisconnectReason.IDLE, detail: '' }, ctx).title,
    ).toBe('Disconnected for inactivity');
  });

  it('gives a ban or shutdown only the way back to the menu', () => {
    expect(
      describeDisconnect({ kind: 'reason', reason: DisconnectReason.IP_BANNED, detail: 'x' }, ctx)
        .actions,
    ).toEqual(['main-menu']);
    expect(
      describeDisconnect(
        { kind: 'reason', reason: DisconnectReason.SHUTTING_DOWN, detail: '' },
        ctx,
      ),
    ).toMatchObject({
      title: 'Server is shutting down',
      actions: ['main-menu'],
    });
  });

  it('offers to take the session back when it was opened elsewhere', () => {
    const view = describeDisconnect({ kind: 'stolen' }, ctx);
    expect(view.title).toBe('Your character was opened in another tab or device');
    expect(view.actions).toEqual(['reconnect-here', 'main-menu']);
    expect(
      describeDisconnect(
        { kind: 'reason', reason: DisconnectReason.LOGGED_IN_ELSEWHERE, detail: '' },
        ctx,
      ),
    ).toEqual(view);
  });

  it('reuses the join wording for refusals met while reconnecting', () => {
    expect(
      describeDisconnect({ kind: 'reason', reason: DisconnectReason.SERVER_FULL, detail: '' }, ctx),
    ).toMatchObject({
      title: 'Server is full',
      actions: ['reconnect', 'main-menu'],
    });
    expect(describeDisconnect({ kind: 'outdated', text: 't' }, ctx).actions).toEqual([
      'refresh',
      'main-menu',
    ]);
  });

  it('describes a connection that could not be restored, and the busy views', () => {
    expect(describeDisconnect({ kind: 'lost' }, ctx)).toMatchObject({
      title: 'Connection lost',
      actions: ['reconnect', 'main-menu'],
    });
    expect(reconnectingView(2, 3)).toEqual({
      title: 'Connection lost',
      message: 'Reconnecting… (attempt 2/3)',
      detail: '',
      busy: true,
      actions: ['main-menu'],
    });
    expect(waitingForNetworkView().busy).toBe(true);
    expect(rejoiningView('EU-1').title).toBe('Joining EU-1…');
  });
});
