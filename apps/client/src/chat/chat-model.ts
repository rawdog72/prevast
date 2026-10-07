// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/chat/chat-model.ts
// The chat console's state, with no DOM: tabs (Local / Global / Clan / Admin /
// Server / one per private conversation), their lines and unread counts, and
// what the Enter key does with typed text. The server decides who receives a
// line and echoes the sender on every channel (Game::playerSayChannel), so a
// line only ever enters a tab from a network event -- never from a keystroke.
//
// Names are resolved HERE, never on the server: `!priv=<name|id>` and the
// double-clicks turn into a guid against the roster we already hold, and an
// ambiguous bare name refuses rather than guesses (test_project's
// chat_routing.h learnt that the hard way).

import type { NpcState } from '../../../../shared/typescript/npc-protocol';
import type { ChatAccessEvent, ChatEvent, ServerLogEvent } from '../net/events';
import type { Badge } from '../ui/badges';
import {
  CHAT_FLAG_ADMIN,
  CHAT_SYSTEM_PID,
  ChatChannel,
  SERVER_LOG_NO_PLAYER,
  ServerLogKind,
} from '../net/opcodes';
import { readSetting, writeSetting } from '../core/storage';

export type ChatTabId =
  'local' | 'global' | 'clan' | 'admin' | 'server' | `pm:${number}` | `npc:${number}`;

export type ChatLineKind = 'say' | 'system' | 'log' | 'broadcast';

export interface ChatLine {
  /** Monotonic, so a view can append only what it has not drawn yet. */
  id: number;
  kind: ChatLineKind;
  /** Speaker guid; -1 when nobody spoke (system / log lines). */
  pid: number;
  /** Resolved when the line arrived: the speaker may leave later. */
  name: string;
  text: string;
  /** Date.now() at arrival. */
  time: number;
  self: boolean;
  /** The server flagged the speaker as an admin (drawn in its own colour). */
  admin: boolean;
  /** The line mentions the player (@Nickname). */
  mention?: boolean;
  npcSession?: number;
  npcRevision?: number;
  badges?: Badge[];
}

/** What `onChat` did with a line, for the caller to react to (a notice). */
export interface ChatArrival {
  tab: ChatTab;
  line: ChatLine;
  /** The line landed on a tab the player is not looking at (or the console is collapsed). */
  unseen: boolean;
}

export interface ChatTab {
  id: ChatTabId;
  label: string;
  /** Where typed text goes; null = read-only. */
  channel: ChatChannel | null;
  /** PRIVATE tabs: the other party's guid. */
  peer?: number;
  npcSession?: number;
  npcRevision?: number;
  closable: boolean;
  lines: ChatLine[];
  unread: number;
  unreadMentions?: number;
  draft?: string;
  pinned?: boolean;
  pending?: boolean;
}

export type ChatSubmit =
  | { type: 'npc'; session: number; revision: number; text: string }
  | { type: 'send'; channel: ChatChannel; target: number; text: string }
  | { type: 'open_private'; pid: number }
  | { type: 'block'; pid: number; blocked: boolean }
  | { type: 'note'; text: string }
  | { type: 'error'; text: string }
  | { type: 'none' };

export type ResolveResult = { guid: number } | { error: string };

export interface ChatRoster {
  nameOf(pid: number): string | undefined;
  ownGuid(): number;
  /** Own clan id, or -1. */
  ownClan(): number;
  players(): Iterable<{ guid: number; nickname: string }>;
  /** Badges after a speaker's name; optional so tests can omit it. */
  badgesOf?(pid: number): Badge[];
  /** Players online whose chat the server keeps from us (BLOCKED_PLAYERS). */
  blocked?(): Iterable<number>;
}

export const MAX_LINES_PER_TAB = 200;
/** Game::playerSayChannel truncates at this many UTF-8 bytes. */
export const MAX_CHAT_BYTES = 200;
export const chatBytes = (text: string): number => new TextEncoder().encode(text).length;
const STORAGE_KEY = 'prevast.chat';

const FIXED_TABS: { id: ChatTabId; label: string; channel: ChatChannel | null }[] = [
  { id: 'local', label: 'Local', channel: ChatChannel.LOCAL },
  { id: 'global', label: 'Global', channel: ChatChannel.GLOBAL },
  { id: 'clan', label: 'Clan', channel: ChatChannel.CLAN },
  { id: 'admin', label: 'Admin', channel: ChatChannel.ADMIN },
  { id: 'server', label: 'Activity', channel: null },
];

const CHANNEL_TAB: Record<number, ChatTabId> = {
  [ChatChannel.LOCAL]: 'local',
  [ChatChannel.GLOBAL]: 'global',
  [ChatChannel.CLAN]: 'clan',
  [ChatChannel.ADMIN]: 'admin',
};

export class ChatModel {
  private readonly tabs = new Map<ChatTabId, ChatTab>();
  private activeId: ChatTabId = 'local';
  private collapsedState = false;
  private accessMask = 0;
  private nextLineId = 1;
  private lastInClan = false;
  private readingTab: ChatTabId | null = null;
  private readonly readThrough = new Map<ChatTabId, number>();
  private lastWhisper: number | undefined;
  private readonly sends = new Map<
    ChatTabId,
    { source: ChatTabId; raw: string; text: string; at: number }
  >();
  /** Bumps on every visible change; a view compares it to skip idle frames. */
  version = 0;

  constructor(
    private readonly roster: ChatRoster,
    private readonly now: () => number = () => Date.now(),
  ) {
    for (const t of FIXED_TABS) {
      this.tabs.set(t.id, { ...t, closable: false, lines: [], unread: 0 });
    }
    this.restore();
  }

  // ---- state readers ------------------------------------------------------

  get active(): ChatTab {
    return this.tabs.get(this.activeId) ?? this.tabs.get('local')!;
  }

  get collapsed(): boolean {
    return this.collapsedState;
  }

  canWrite(channel: ChatChannel): boolean {
    return (this.accessMask & (1 << channel)) !== 0;
  }

  /** We are in a clan (the Clan tab only exists while we are). */
  get inClan(): boolean {
    return this.roster.ownClan() >= 0;
  }

  /** Tabs in strip order; Admin only once the server granted it, Clan only while in one. */
  visibleTabs(): ChatTab[] {
    const out: ChatTab[] = [];
    for (const t of this.tabs.values()) {
      if (t.id === 'admin' && !this.canWrite(ChatChannel.ADMIN)) continue;
      if (t.id === 'clan' && !this.inClan) continue;
      out.push(t);
    }
    return out;
  }

  /**
   * Clan membership lives in the roster, not here: called once per frame so
   * the Clan tab appears / vanishes with it (and the active tab falls back to
   * Local when the clan is gone). Bumps `version` only on a change.
   */
  refresh(): void {
    for (const [id, send] of this.sends) {
      if (this.now() - send.at < 10000) continue;
      this.finishSend(id, false);
      const source = this.tabs.get(send.source);
      if (source)
        this.append(source, {
          kind: 'system',
          pid: -1,
          name: '',
          text: 'Send not confirmed. Your draft was kept; check the log before retrying.',
          self: false,
          admin: false,
        });
    }
    const inClan = this.inClan;
    // A restored 'clan' tab with no clan (or a clan just left) falls back.
    if (!inClan && this.activeId === 'clan') {
      this.activeId = 'local';
      this.readingTab = null;
      this.touch();
    }
    if (inClan === this.lastInClan) return;
    this.lastInClan = inClan;
    this.touch();
  }

  tab(id: ChatTabId): ChatTab | undefined {
    return this.tabs.get(id);
  }

  /** Only the view can confirm that the latest lines are visible and in the foreground. */
  setReading(id: ChatTabId, atLatest: boolean): void {
    if (id !== this.activeId) return;
    this.readingTab = atLatest && !this.collapsedState ? id : null;
    const tab = this.tabs.get(id);
    if (this.readingTab !== id || !tab) return;
    this.readThrough.set(id, tab.lines.at(-1)?.id ?? 0);
    if (!tab.unread && !tab.unreadMentions) return;
    tab.unread = 0;
    tab.unreadMentions = 0;
    this.touch();
  }

  togglePin(id: ChatTabId): void {
    const tab = this.tabs.get(id);
    if (tab?.channel !== ChatChannel.PRIVATE) return;
    tab.pinned = !tab.pinned;
    this.touch();
  }

  setDraft(id: ChatTabId, text: string): void {
    const tab = this.tabs.get(id);
    if (tab && tab.draft !== text) {
      tab.draft = text;
      this.touch();
    }
  }

  beginSend(
    action: Extract<ChatSubmit, { type: 'send' | 'npc' }>,
    source: ChatTabId,
    raw: string,
  ): boolean {
    const id =
      action.type === 'npc'
        ? (`npc:${action.session}` as ChatTabId)
        : action.channel === ChatChannel.PRIVATE
          ? (`pm:${action.target}` as ChatTabId)
          : CHANNEL_TAB[action.channel];
    if (!id || this.sends.has(id) || this.tab(source)?.pending) return false;
    this.sends.set(id, { source, raw, text: action.text, at: this.now() });
    const tab = this.tab(source);
    if (tab) {
      tab.draft = raw;
      tab.pending = true;
    }
    this.touch();
    return true;
  }

  cancelSend(source: ChatTabId): void {
    for (const [id, send] of this.sends) if (send.source === source) this.finishSend(id, false);
  }

  private finishSend(id: ChatTabId, success: boolean): void {
    const send = this.sends.get(id);
    if (!send) return;
    const source = this.tab(send.source);
    if (source) {
      source.pending = false;
      if (success && source.draft === send.raw) source.draft = '';
    }
    this.sends.delete(id);
    this.touch();
  }

  completePlayers(prefix: string): { label: string; whisper: string; mention: string }[] {
    return [...this.roster.players()]
      .filter(
        (p) =>
          p.guid !== this.roster.ownGuid() &&
          p.nickname.toLowerCase().startsWith(prefix.toLowerCase()),
      )
      .sort((a, b) => a.nickname.localeCompare(b.nickname) || a.guid - b.guid)
      .slice(0, 8)
      .map((p) => ({
        label: `${p.nickname} #${p.guid}`,
        whisper: `#${p.guid}`,
        mention: p.nickname,
      }));
  }

  // ---- network in ---------------------------------------------------------

  setAccess(ev: ChatAccessEvent): void {
    this.accessMask = ev.mask;
    if (this.activeId === 'admin' && !this.canWrite(ChatChannel.ADMIN)) this.activeId = 'local';
    this.touch();
  }

  onChat(ev: ChatEvent): ChatArrival | undefined {
    const system = ev.pid === CHAT_SYSTEM_PID;
    let tab: ChatTab;
    if (ev.channel === ChatChannel.PRIVATE) {
      tab = this.ensurePrivate(ev.peer);
    } else {
      const id = CHANNEL_TAB[ev.channel];
      if (!id) return undefined;
      tab = this.tabs.get(id)!;
    }
    const unseen = tab.id !== this.readingTab || this.collapsedState;
    const isSelf = !system && ev.pid === this.roster.ownGuid();
    if (ev.channel === ChatChannel.PRIVATE && !system && !isSelf) this.lastWhisper = ev.peer;
    if (system) this.finishSend(tab.id, false);
    else if (isSelf && this.sends.get(tab.id)?.text === ev.text) this.finishSend(tab.id, true);
    const ownName = this.roster.nameOf(this.roster.ownGuid());
    const isMention = !system && !isSelf && this.checkMention(ev.text, ownName);
    const line = this.append(tab, {
      kind: system ? 'system' : 'say',
      pid: system ? -1 : ev.pid,
      name: system ? '' : this.nameOf(ev.pid),
      text: ev.text,
      self: isSelf,
      admin: !system && (ev.flags & CHAT_FLAG_ADMIN) !== 0,
      mention: isMention,
      badges: system ? undefined : this.roster.badgesOf?.(ev.pid),
    });
    return { tab, line, unseen };
  }

  private checkMention(text: string, ownName: string | undefined): boolean {
    if (!ownName) return false;
    const escaped = ownName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|[^a-zA-Z0-9_])@${escaped}(?=[^a-zA-Z0-9_]|$)`, 'i');
    return regex.test(text);
  }

  onServerLog(ev: ServerLogEvent): void {
    const tab = this.tabs.get('server')!;
    const who = (pid: number) => this.nameOf(pid);
    let text: string;
    let kind: ChatLineKind = 'log';
    let pid = -1;
    switch (ev.kind) {
      case ServerLogKind.JOIN:
        text = `${who(ev.a)} joined the server`;
        break;
      case ServerLogKind.LEAVE:
        text = `${who(ev.a)} left the server`;
        break;
      case ServerLogKind.DEATH:
        text =
          ev.b === SERVER_LOG_NO_PLAYER
            ? `${who(ev.a)} died`
            : `${who(ev.a)} was killed by ${who(ev.b)}`;
        break;
      case ServerLogKind.CLAN_CREATED:
        text = `${who(ev.a)} founded the clan [${ev.text}]`;
        break;
      case ServerLogKind.CLAN_DISBANDED:
        text = `Clan [${ev.text}] was disbanded`;
        break;
      case ServerLogKind.CLAN_JOINED:
        text = `${who(ev.a)} joined [${ev.text}]`;
        break;
      case ServerLogKind.CLAN_LEFT:
        text = `${who(ev.a)} left [${ev.text}]`;
        break;
      case ServerLogKind.CLAN_KICKED:
        text = `${who(ev.a)} was kicked from [${ev.text}]`;
        break;
      case ServerLogKind.BROADCAST:
        kind = 'broadcast';
        pid = ev.a;
        text = ev.text;
        break;
      case ServerLogKind.SYSTEM:
        text = ev.text;
        break;
      default:
        return;
    }
    this.append(tab, {
      kind,
      pid,
      name: pid >= 0 ? who(pid) : '',
      text,
      self: false,
      admin: false,
    });
  }

  // ---- user actions -------------------------------------------------------

  setActive(id: ChatTabId): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (id === 'admin' && !this.canWrite(ChatChannel.ADMIN)) return;
    if (id === 'clan' && !this.inClan) return;
    this.activeId = id;
    this.readingTab = null;
    this.persist();
    this.touch();
  }

  /** Next / previous tab in strip order (Tab / Shift+Tab in the input). */
  cycle(direction: 1 | -1): void {
    const tabs = this.visibleTabs();
    const i = tabs.findIndex((t) => t.id === this.activeId);
    const next = tabs[(i + direction + tabs.length) % tabs.length];
    if (next) this.setActive(next.id);
  }

  setCollapsed(collapsed: boolean): void {
    if (this.collapsedState === collapsed) return;
    this.collapsedState = collapsed;
    this.readingTab = null;
    this.persist();
    this.touch();
  }

  /** Opens (or focuses) the private tab for `pid`. Refuses ourselves. */
  openPrivate(pid: number): ChatTab | undefined {
    if (pid < 0 || pid === this.roster.ownGuid() || pid === CHAT_SYSTEM_PID) return undefined;
    const tab = this.ensurePrivate(pid);
    this.setActive(tab.id);
    return tab;
  }

  onNpc(state: NpcState): void {
    const id: ChatTabId = `npc:${state.session}`;
    let tab = this.tabs.get(id);
    if (!tab) {
      this.closeNpcs();
      tab = {
        id,
        label: `[NPC: ${state.name}]`,
        channel: null,
        closable: true,
        lines: [],
        unread: 0,
        npcSession: state.session,
      };
      this.tabs.set(id, tab);
      this.setActive(id);
      this.setCollapsed(false);
    }
    tab.npcRevision = state.revision;
    if (state.echo === this.sends.get(id)?.text) this.finishSend(id, true);
    if (state.echo)
      this.append(tab, {
        kind: 'say',
        pid: this.roster.ownGuid(),
        name: this.roster.nameOf(this.roster.ownGuid()) ?? 'You',
        text: state.echo,
        self: true,
        admin: false,
      });
    if (state.text)
      this.append(tab, {
        kind: 'say',
        pid: -1,
        name: state.name,
        text: state.text,
        self: false,
        admin: false,
        npcSession: state.session,
        npcRevision: state.revision,
      });
    this.touch();
  }

  closeNpcs(session?: number): void {
    for (const tab of this.tabs.values())
      if (tab.npcSession && (!session || tab.npcSession === session)) {
        this.cancelSend(tab.id);
        // A server-ended conversation may still contain an unsent reply.
        if (tab.draft?.trim()) {
          tab.npcSession = undefined;
          tab.npcRevision = undefined;
          tab.label += ' (ended)';
          this.touch();
        } else this.closeTab(tab.id);
      }
  }

  closeTab(id: ChatTabId): void {
    const tab = this.tabs.get(id);
    if (!tab?.closable) return;
    if (tab.pending) return;
    this.tabs.delete(id);
    this.readThrough.delete(id);
    if (this.activeId === id) this.setActive('local');
    else this.touch();
  }

  clearActive(): void {
    this.active.lines.length = 0;
    this.active.unread = 0;
    this.active.unreadMentions = 0;
    this.touch();
  }

  /**
   * What Enter does with the typed text. `!priv=<name|id>[ text]` opens the
   * private tab (and sends `text` there if given); `!block=<name|id>` and
   * `!unblock=<name|id>` block or unblock a player (someone out of sight, say),
   * `!blocked` lists who is blocked; any other `!…` is an admin
   * command and goes to the server as typed on the active channel (the server
   * drops it for a non-admin). Plain text goes to the active tab's channel.
   */
  submit(raw: string): ChatSubmit {
    let text = raw.trim();
    if (!text) return { type: 'none' };
    if (/^\/help$/i.test(text))
      return {
        type: 'note',
        text: '/w <name or #id> [message] whispers; /r [message] replies to the last whisper; Tab completes names; Ctrl+Tab switches channels. Click a player name for Message, Block and Copy text. !priv=, !block= and !unblock= still work.',
      };
    const reply = /^\/r(?:\s+(.*))?$/i.exec(text);
    if (reply) {
      if (this.lastWhisper === undefined)
        return { type: 'error', text: 'Nobody has whispered to you yet.' };
      text = `!priv=#${this.lastWhisper}${reply[1] ? ` ${reply[1]}` : ''}`;
    }
    const whisper = /^\/(?:w|whisper)\s+(?:"([^"]+)"|(\S+))(?:\s+(.*))?$/i.exec(text);
    if (whisper)
      text = `!priv=${whisper[1] ? `"${whisper[1]}"` : whisper[2]}${whisper[3] ? ` ${whisper[3]}` : ''}`;
    if (text.startsWith('/'))
      return {
        type: 'error',
        text: 'Unknown or incomplete command. Use /w <name> [message], /r [message], or /help.',
      };

    const priv = /^!priv(?:ate)?=(?:"([^"]+)"|(\S+))(?:\s+(.*))?$/i.exec(text);
    if (priv) {
      const resolved = this.resolvePlayer(priv[1] ?? priv[2]!);
      if ('error' in resolved) return { type: 'error', text: resolved.error };
      if (resolved.guid === this.roster.ownGuid()) {
        return { type: 'error', text: 'You cannot message yourself.' };
      }
      const body = priv[3]?.trim();
      if (body) {
        if (chatBytes(body) > MAX_CHAT_BYTES) return this.lengthError();
        this.openPrivate(resolved.guid);
        return { type: 'send', channel: ChatChannel.PRIVATE, target: resolved.guid, text: body };
      }
      return { type: 'open_private', pid: resolved.guid };
    }

    const block = /^!(block|unblock)=(.*)$/i.exec(text);
    if (block) {
      const command = block[1]!.toLowerCase();
      const token = block[2]!.trim();
      if (!token) return { type: 'error', text: `Usage: !${command}=<name or id>` };
      const resolved = this.resolvePlayer(token, command);
      if ('error' in resolved) return { type: 'error', text: resolved.error };
      if (resolved.guid === this.roster.ownGuid()) {
        return { type: 'error', text: 'You cannot block yourself.' };
      }
      return { type: 'block', pid: resolved.guid, blocked: command === 'block' };
    }
    if (/^!blocked$/i.test(text)) {
      const names = [...(this.roster.blocked?.() ?? [])]
        .sort((a, b) => a - b)
        .map((pid) => `${this.nameOf(pid)}#${pid}`);
      return {
        type: 'note',
        text: names.length
          ? `Blocked: ${names.join(', ')}. !unblock=<id> lifts one.`
          : 'You have blocked nobody online.',
      };
    }

    const tab = this.active;
    if (text.startsWith('!')) {
      // Admin commands are channel-agnostic on the server; a read-only tab
      // just needs some channel to carry them.
      const channel = tab.channel ?? ChatChannel.LOCAL;
      return { type: 'send', channel, target: tab.peer ?? 0, text };
    }
    if (chatBytes(text) > MAX_CHAT_BYTES) return this.lengthError();
    if (tab.npcSession)
      return { type: 'npc', session: tab.npcSession, revision: tab.npcRevision!, text };
    if (tab.channel === null) {
      return { type: 'error', text: 'The Activity tab is read-only.' };
    }
    if (tab.channel === ChatChannel.CLAN && !this.inClan) {
      return { type: 'error', text: 'You are not in a clan.' };
    }
    if (!this.canWrite(tab.channel)) {
      return { type: 'error', text: 'You cannot write here.' };
    }
    return { type: 'send', channel: tab.channel, target: tab.peer ?? 0, text };
  }

  /** Capacity of the outgoing body, excluding whisper/reply command syntax. */
  messageBytes(raw: string): number {
    const text = raw.trim();
    const command = /^(?:\/(?:w|whisper)\s+|!priv(?:ate)?=)(?:"[^"]+"|\S+)(?:\s+(.*))?$/i.exec(
      text,
    );
    const reply = /^\/r(?:\s+(.*))?$/i.exec(text);
    return chatBytes(command ? (command[1] ?? '') : reply ? (reply[1] ?? '') : text);
  }

  private lengthError(): ChatSubmit {
    return {
      type: 'error',
      text: `Message exceeds ${MAX_CHAT_BYTES} UTF-8 bytes. Shorten it before sending; accented letters and emoji use more space.`,
    };
  }

  /** A line the client itself wants shown in the active tab (errors, help). */
  noteInActive(text: string): void {
    this.append(this.active, {
      kind: 'system',
      pid: -1,
      name: '',
      text,
      self: false,
      admin: false,
    });
  }

  /**
   * `12`, `#12`, `Name#12` resolve by guid; a bare name must match exactly one
   * online player (case-insensitive) -- duplicates are allowed by the server,
   * and a private line to the wrong namesake is the one mistake to never make.
   */
  resolvePlayer(token: string, command = 'priv'): ResolveResult {
    const t = token.trim();
    const hash = t.lastIndexOf('#');
    const idPart = hash >= 0 ? t.slice(hash + 1) : t;
    if (/^\d+$/.test(idPart) && (hash >= 0 || idPart === t)) {
      const guid = Number(idPart);
      return this.roster.nameOf(guid) !== undefined
        ? { guid }
        : { error: `No player with id ${guid}.` };
    }
    const wanted = t.toLowerCase();
    let found = -1;
    for (const p of this.roster.players()) {
      if (p.nickname.toLowerCase() !== wanted) continue;
      if (found >= 0) return { error: `Several players are called "${t}": use !${command}=<id>.` };
      found = p.guid;
    }
    return found >= 0 ? { guid: found } : { error: `No player called "${t}" is online.` };
  }

  // ---- internals ----------------------------------------------------------

  private ensurePrivate(peer: number): ChatTab {
    const id: ChatTabId = `pm:${peer}`;
    let tab = this.tabs.get(id);
    if (!tab) {
      tab = {
        id,
        label: this.nameOf(peer),
        channel: ChatChannel.PRIVATE,
        peer,
        closable: true,
        lines: [],
        unread: 0,
      };
      this.tabs.set(id, tab);
      this.touch();
    }
    return tab;
  }

  private append(tab: ChatTab, line: Omit<ChatLine, 'id' | 'time'>): ChatLine {
    const full: ChatLine = { ...line, id: this.nextLineId++, time: this.now() };
    tab.lines.push(full);
    if (tab.lines.length > MAX_LINES_PER_TAB)
      tab.lines.splice(0, tab.lines.length - MAX_LINES_PER_TAB);
    if (this.readingTab === tab.id && !this.collapsedState) this.readThrough.set(tab.id, full.id);
    const unread = tab.lines.filter((l) => l.id > (this.readThrough.get(tab.id) ?? 0) && !l.self);
    tab.unread = unread.length;
    tab.unreadMentions = unread.filter((l) => l.mention).length;
    this.touch();
    return full;
  }

  private nameOf(pid: number): string {
    return this.roster.nameOf(pid) ?? `Player ${pid}`;
  }

  private touch(): void {
    this.version++;
  }

  private persist(): void {
    writeSetting(
      STORAGE_KEY,
      JSON.stringify({ active: this.activeId, collapsed: this.collapsedState }),
    );
  }

  private restore(): void {
    try {
      const raw = readSetting(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { active?: string; collapsed?: boolean };
      // Private tabs do not survive a reload (their peer may be gone).
      if (typeof saved.active === 'string' && this.tabs.has(saved.active as ChatTabId)) {
        this.activeId = saved.active as ChatTabId;
      }
      this.collapsedState = saved.collapsed === true;
    } catch {
      /* corrupt setting: defaults */
    }
  }
}
