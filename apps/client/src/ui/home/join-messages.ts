// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Everything the player reads about joining a server and losing the
// connection: stage lines, refusal notices and the disconnect dialog. The
// server sends only a DisconnectReason code and variable detail; the words
// live here so they read the same everywhere.
import type { JoinOutcome, JoinStage, JoinStageInfo } from '../../net/join-session';
import { DisconnectReason } from '../../net/opcodes';

export type JoinAction = 'retry' | 'choose-server' | 'refresh' | 'sign-in' | 'guest';

export interface FailureNotice {
  tone: 'error' | 'warn';
  title: string;
  message: string;
  detail: string;
  actions: JoinAction[];
}

export interface JoinContext {
  serverName: string;
  /** The listed slot count, for "All N slots are taken". */
  maxPlayers?: number;
}

export type JoinFailure = Exclude<JoinOutcome, { kind: 'joined' } | { kind: 'cancelled' }>;

export type DisconnectAction = 'reconnect' | 'reconnect-here' | 'main-menu' | 'refresh';

export interface DisconnectView {
  title: string;
  message: string;
  detail: string;
  /** Something is in progress (reconnecting, joining): shown with a spinner. */
  busy: boolean;
  actions: DisconnectAction[];
}

export type DisconnectCause =
  | { kind: 'reason'; reason: DisconnectReason; detail: string }
  | { kind: 'stolen' }
  | { kind: 'outdated'; text: string }
  | { kind: 'lost' };

export const JOIN_ACTION_LABELS: Record<JoinAction, string> = {
  retry: 'Retry',
  'choose-server': 'Choose server',
  refresh: 'Refresh page',
  'sign-in': 'Sign in',
  guest: 'Play as guest',
};

export const DISCONNECT_ACTION_LABELS: Record<DisconnectAction, string> = {
  reconnect: 'Reconnect',
  'reconnect-here': 'Reconnect here',
  'main-menu': 'Main menu',
  refresh: 'Refresh page',
};

export function joinStageText(stage: JoinStage, info: JoinStageInfo, ctx: JoinContext): string {
  switch (stage) {
    case 'content':
      return 'Loading game data…';
    case 'ticket':
      return 'Signing in…';
    case 'connecting':
      return `Connecting to ${ctx.serverName}…`;
    case 'syncing':
      return 'Syncing content…';
    case 'logging-in':
      return `Joining ${ctx.serverName}…`;
    case 'waiting': {
      const seconds = Math.max(1, Math.ceil((info.retryInMs ?? 0) / 1000));
      const state =
        info.reason === DisconnectReason.MAINTENANCE ? 'is under maintenance' : 'is starting up';
      return `${ctx.serverName} ${state} — retrying in ${seconds}s (attempt ${info.attempt + 1}/${info.attempts})`;
    }
  }
}

function notice(
  tone: FailureNotice['tone'],
  title: string,
  message: string,
  actions: JoinAction[],
  detail = '',
): FailureNotice {
  return { tone, title, message, detail, actions };
}

function describeReason(reason: DisconnectReason, detail: string, ctx: JoinContext): FailureNotice {
  const R = DisconnectReason;
  switch (reason) {
    case R.SERVER_FULL: {
      const slots =
        ctx.maxPlayers && ctx.maxPlayers > 0 ? `All ${ctx.maxPlayers} slots` : 'All slots';
      return notice(
        'warn',
        'Server is full',
        `${slots} are taken. Try again shortly or pick another server.`,
        ['retry', 'choose-server'],
      );
    }
    case R.SERVER_CLOSED:
      return notice('warn', 'Server is closed', "It isn't accepting new players right now.", [
        'choose-server',
      ]);
    case R.STARTING_UP:
      return notice('warn', 'Server is starting up', 'It should be back soon.', ['retry']);
    case R.MAINTENANCE:
      return notice('warn', 'Server is under maintenance', 'It should be back soon.', ['retry']);
    case R.SHUTTING_DOWN:
      return notice('warn', 'Server is shutting down', '', ['choose-server']);
    case R.IP_BANNED:
      return notice('error', 'You are banned from this server', '', [], detail);
    case R.TOO_MANY_FROM_IP:
      return notice(
        'warn',
        'Too many players from your connection',
        'Close another session and try again.',
        ['retry'],
      );
    case R.ADMIN_AUTH_REQUIRED:
      return notice(
        'error',
        'Admin password required',
        'Enter the admin password to take over this character.',
        [],
      );
    case R.INVALID_LOGIN:
      return notice('error', "Couldn't join", 'The server rejected the login (invalid login).', [
        'retry',
      ]);
    case R.ACCOUNT_REQUIRED:
      return notice(
        'warn',
        'Account sign-in failed',
        'Account progress will not be recorded if you choose guest play.',
        ['retry', 'sign-in', 'guest'],
        detail,
      );
    case R.SPAWN_FAILED:
      return notice(
        'error',
        "Couldn't join",
        'The server rejected the login (no place to spawn).',
        ['retry'],
      );
    default:
      return notice(
        'error',
        "Couldn't join",
        detail ? '' : 'The server refused the connection.',
        ['retry'],
        detail,
      );
  }
}

export function describeJoinFailure(outcome: JoinFailure, ctx: JoinContext): FailureNotice {
  switch (outcome.kind) {
    case 'account-failed':
      return notice(
        'warn',
        'Account sign-in failed',
        'Account progress will not be recorded if you choose guest play.',
        ['retry', 'sign-in', 'guest'],
        outcome.detail,
      );
    case 'rejected':
      return describeReason(outcome.reason, outcome.detail, ctx);
    case 'outdated':
      return notice(
        'error',
        'Game update required',
        'Your client is out of date. Refresh to load the latest version.',
        ['refresh'],
        outcome.text,
      );
    case 'unreachable':
      return notice('error', "Can't reach server", 'It may be offline, or the address is wrong.', [
        'retry',
        'choose-server',
      ]);
    case 'timed-out':
      return notice(
        'error',
        "Server isn't responding",
        "Connected, but it didn't let us in within 15 s.",
        ['retry'],
      );
    case 'dropped':
      return notice('error', 'Connection closed while joining', '', ['retry']);
    case 'content-failed':
      return notice('error', "Couldn't load game data", 'Check your connection and try again.', [
        'retry',
      ]);
  }
}

function view(
  title: string,
  message: string,
  actions: DisconnectAction[],
  detail = '',
): DisconnectView {
  return { title, message, detail, busy: false, actions };
}

const STOLEN = view('Your character was opened in another tab or device', '', [
  'reconnect-here',
  'main-menu',
]);

export function describeDisconnect(cause: DisconnectCause, ctx: JoinContext): DisconnectView {
  if (cause.kind === 'stolen') return STOLEN;
  if (cause.kind === 'lost') {
    return view('Connection lost', 'Could not reconnect to the server.', [
      'reconnect',
      'main-menu',
    ]);
  }
  if (cause.kind === 'outdated') return fromJoinNotice(describeJoinFailure(cause, ctx));

  const R = DisconnectReason;
  const { reason, detail } = cause;
  switch (reason) {
    case R.KICKED:
      return view(
        'You were kicked',
        'An admin removed you from the server.',
        ['reconnect', 'main-menu'],
        detail,
      );
    case R.IDLE:
      return view('Disconnected for inactivity', 'You were idle for too long.', [
        'reconnect',
        'main-menu',
      ]);
    case R.PLAYER_LIMIT_LOWERED:
      return view(
        'Server capacity was reduced',
        'The player limit was lowered and your slot was released.',
        ['reconnect', 'main-menu'],
      );
    case R.IP_BANNED:
      return view('You were banned', '', ['main-menu'], detail);
    case R.SHUTTING_DOWN:
      return view('Server is shutting down', 'Try again once it is back.', ['main-menu']);
    case R.LOGGED_IN_ELSEWHERE:
      return STOLEN;
    case R.OTHER:
      return view(
        'Disconnected',
        detail ? '' : 'The server closed the connection.',
        ['reconnect', 'main-menu'],
        detail,
      );
    default:
      // A refusal met while reconnecting (full, closed, ...): the join wording.
      return fromJoinNotice(describeReason(reason, detail, ctx));
  }
}

/** A join notice as a dialog view: Retry becomes Reconnect, and Main menu is always there. */
function fromJoinNotice(n: FailureNotice): DisconnectView {
  const actions: DisconnectAction[] = [];
  if (n.actions.includes('refresh')) actions.push('refresh');
  if (n.actions.includes('retry')) actions.push('reconnect');
  actions.push('main-menu');
  return view(n.title, n.message, actions, n.detail);
}

export function reconnectingView(attempt: number, attempts: number): DisconnectView {
  return {
    ...view('Connection lost', `Reconnecting… (attempt ${attempt}/${attempts})`, ['main-menu']),
    busy: true,
  };
}

export function waitingForNetworkView(): DisconnectView {
  return {
    ...view('Connection lost', 'Waiting for your network to come back…', ['main-menu']),
    busy: true,
  };
}

export function rejoiningView(serverName: string): DisconnectView {
  return { ...view(`Joining ${serverName}…`, '', ['main-menu']), busy: true };
}
