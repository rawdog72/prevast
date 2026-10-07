// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHAT_FLAG_ADMIN,
  CHAT_SYSTEM_PID,
  ChatChannel,
  SERVER_LOG_NO_PLAYER,
  ServerLogKind,
} from '../net/opcodes';
import { ChatModel, MAX_LINES_PER_TAB, chatBytes } from './chat-model';
import type { ChatRoster } from './chat-model';

describe('ChatModel', () => {
  let clan = -1;
  let blocked: number[] = [];
  let model: ChatModel;

  beforeEach(() => {
    clan = -1;
    blocked = [];
    const players = new Map<number, string>([
      [1, 'Alice'],
      [2, 'Bob'],
      [3, 'bob'],
      [4, 'Carol'],
    ]);
    const roster: ChatRoster = {
      nameOf: (pid) => players.get(pid),
      ownGuid: () => 1,
      ownClan: () => clan,
      players: () => [...players].map(([guid, nickname]) => ({ guid, nickname })),
      blocked: () => blocked,
    };
    model = new ChatModel(roster, () => 1000);
    model.setActive('local');
    model.setCollapsed(false);
    model.setReading('local', true);
  });

  it('lists fixed tabs in order, shows admin only when granted and clan only while in one', () => {
    expect(model.visibleTabs().map((t) => t.id)).toEqual(['local', 'global', 'server']);
    model.setAccess({ mask: 1 << ChatChannel.LOCAL });
    expect(model.visibleTabs().map((t) => t.id)).toEqual(['local', 'global', 'server']);
    model.setAccess({ mask: 1 << ChatChannel.ADMIN });
    expect(model.visibleTabs().map((t) => t.id)).toEqual(['local', 'global', 'admin', 'server']);
    clan = 3;
    expect(model.visibleTabs().map((t) => t.id)).toEqual([
      'local',
      'global',
      'clan',
      'admin',
      'server',
    ]);
  });

  it('refresh() tracks clan membership: the tab appears with it and the active tab falls back without it', () => {
    const before = model.version;
    model.refresh();
    expect(model.version).toBe(before); // no change, no bump
    clan = 3;
    model.refresh();
    expect(model.version).toBeGreaterThan(before);
    model.setActive('clan');
    expect(model.active.id).toBe('clan');
    clan = -1;
    model.refresh();
    expect(model.active.id).toBe('local');
    expect(model.setActive('clan')).toBeUndefined();
    expect(model.active.id).toBe('local');
  });

  it('flags an admin speaker from the wire and exposes whether a line was unseen', () => {
    const seen = model.onChat({
      channel: ChatChannel.LOCAL,
      pid: 4,
      peer: 0,
      flags: CHAT_FLAG_ADMIN,
      text: 'gm',
    });
    expect(seen).toMatchObject({ unseen: false, line: { admin: true, name: 'Carol' } });
    const unseen = model.onChat({
      channel: ChatChannel.PRIVATE,
      pid: 2,
      peer: 2,
      flags: 0,
      text: 'psst',
    });
    expect(unseen).toMatchObject({ unseen: true, tab: { id: 'pm:2' }, line: { admin: false } });
  });

  it('appends local speech with the resolved name and marks our own lines', () => {
    model.onChat({ channel: ChatChannel.LOCAL, pid: 2, peer: 0, flags: 0, text: 'hi' });
    model.onChat({ channel: ChatChannel.LOCAL, pid: 1, peer: 0, flags: 0, text: 'hello' });
    expect(model.tab('local')!.lines).toMatchObject([
      { kind: 'say', name: 'Bob', self: false, text: 'hi', time: 1000 },
      { kind: 'say', name: 'Alice', self: true, text: 'hello', time: 1000 },
    ]);
  });

  it('detects when an incoming line mentions the player (@Nickname)', () => {
    const m1 = model.onChat({
      channel: ChatChannel.LOCAL,
      pid: 2,
      peer: 0,
      flags: 0,
      text: 'hey @Alice check this out',
    });
    expect(m1?.line.mention).toBe(true);

    const m2 = model.onChat({
      channel: ChatChannel.LOCAL,
      pid: 2,
      peer: 0,
      flags: 0,
      text: '@alice: hello',
    });
    expect(m2?.line.mention).toBe(true);

    const m3 = model.onChat({
      channel: ChatChannel.LOCAL,
      pid: 2,
      peer: 0,
      flags: 0,
      text: '@Alicex hello',
    });
    expect(m3?.line.mention).toBe(false);

    const m4 = model.onChat({
      channel: ChatChannel.LOCAL,
      pid: 2,
      peer: 0,
      flags: 0,
      text: 'hey @Bob',
    });
    expect(m4?.line.mention).toBe(false);

    // Own messages mentioning self should not flag mention
    const m5 = model.onChat({
      channel: ChatChannel.LOCAL,
      pid: 1,
      peer: 0,
      flags: 0,
      text: 'talking to @Alice',
    });
    expect(m5?.line.mention).toBe(false);
  });

  it('appends server-authored chat as a system line without a speaker', () => {
    model.onChat({
      channel: ChatChannel.LOCAL,
      pid: CHAT_SYSTEM_PID,
      peer: 0,
      flags: 0,
      text: 'notice',
    });
    expect(model.tab('local')!.lines).toMatchObject([
      { kind: 'system', pid: -1, name: '', text: 'notice' },
    ]);
  });

  it('creates and reuses a closable private tab for the peer', () => {
    model.onChat({ channel: ChatChannel.PRIVATE, pid: 2, peer: 2, flags: 0, text: 'hi' });
    const tab = model.tab('pm:2');
    expect(tab).toMatchObject({ id: 'pm:2', label: 'Bob', closable: true });
    model.onChat({ channel: ChatChannel.PRIVATE, pid: 1, peer: 2, flags: 0, text: 'hello' });
    expect(model.tab('pm:2')).toBe(tab);
    expect(tab!.lines).toHaveLength(2);
    expect(model.visibleTabs().filter((t) => t.id.startsWith('pm:'))).toHaveLength(1);
  });

  it('keeps unread on activation until the view reaches the latest messages', () => {
    model.onChat({ channel: ChatChannel.GLOBAL, pid: 2, peer: 0, flags: 0, text: 'hi' });
    expect(model.tab('global')!.unread).toBe(1);
    model.setActive('global');
    expect(model.active.unread).toBe(1);
    model.setReading('global', true);
    expect(model.active.unread).toBe(0);
    model.setCollapsed(true);
    model.onChat({ channel: ChatChannel.GLOBAL, pid: 2, peer: 0, flags: 0, text: 'again' });
    expect(model.active.unread).toBe(1);
  });

  it('refuses to open ourselves and focuses a private tab for another player', () => {
    const tabs = model.visibleTabs();
    expect(model.openPrivate(1)).toBeUndefined();
    expect(model.visibleTabs()).toEqual(tabs);
    expect(model.tab('pm:1')).toBeUndefined();
    const tab = model.openPrivate(2);
    expect(tab).toBe(model.tab('pm:2'));
    expect(tab!.id).toBe('pm:2');
    expect(model.active).toBe(tab);
  });

  it('falls back to local when closing the active private tab and keeps local open', () => {
    model.openPrivate(2);
    model.closeTab('pm:2');
    expect(model.tab('pm:2')).toBeUndefined();
    expect(model.active.id).toBe('local');
    const local = model.active;
    model.closeTab('local');
    expect(model.tab('local')).toBe(local);
    expect(model.active).toBe(local);
  });

  it('ignores empty input and sends plain text to the active local or private channel', () => {
    model.setAccess({ mask: (1 << ChatChannel.LOCAL) | (1 << ChatChannel.PRIVATE) });
    expect(model.submit('')).toEqual({ type: 'none' });
    expect(model.submit('hello')).toEqual({
      type: 'send',
      channel: ChatChannel.LOCAL,
      target: 0,
      text: 'hello',
    });
    model.openPrivate(2);
    expect(model.submit('hi')).toEqual({
      type: 'send',
      channel: ChatChannel.PRIVATE,
      target: 2,
      text: 'hi',
    });
  });

  it('rejects server and clanless speech and sends clan speech with membership and access', () => {
    model.setActive('server');
    expect(model.submit('hi')).toMatchObject({ type: 'error' });
    clan = 0;
    model.setActive('clan');
    clan = -1; // left the clan while the tab was active: the model refuses, the view falls back
    expect(model.submit('hi')).toEqual({ type: 'error', text: expect.stringMatching(/clan/i) });
    clan = 0;
    model.setAccess({ mask: 1 << ChatChannel.CLAN });
    expect(model.submit('hi')).toEqual({
      type: 'send',
      channel: ChatChannel.CLAN,
      target: 0,
      text: 'hi',
    });
  });

  it('resolves private commands and rejects ambiguous names, ourselves and missing players', () => {
    expect(model.submit('!priv=Bob')).toEqual({
      type: 'error',
      text: expect.stringContaining('!priv=<id>'),
    });
    expect(model.submit('!priv=Carol')).toEqual({ type: 'open_private', pid: 4 });
    expect(model.submit('!priv=4 hello')).toEqual({
      type: 'send',
      channel: ChatChannel.PRIVATE,
      target: 4,
      text: 'hello',
    });
    expect(model.active.id).toBe('pm:4');
    expect(model.submit('!priv=1')).toEqual({
      type: 'error',
      text: expect.stringMatching(/yourself/i),
    });
    expect(model.submit('!priv=99')).toEqual({
      type: 'error',
      text: expect.stringMatching(/no player/i),
    });
  });

  it('!block= / !unblock= resolve a player like !priv= and never ourselves', () => {
    expect(model.submit('!block=Carol')).toEqual({ type: 'block', pid: 4, blocked: true });
    expect(model.submit('!unblock=4')).toEqual({ type: 'block', pid: 4, blocked: false });
    expect(model.submit('!BLOCK=Bob#2')).toEqual({ type: 'block', pid: 2, blocked: true });
    expect(model.submit('!block=Bob')).toEqual({
      type: 'error',
      text: expect.stringContaining('!block=<id>'),
    });
    expect(model.submit('!block=1')).toEqual({
      type: 'error',
      text: expect.stringMatching(/yourself/i),
    });
    expect(model.submit('!unblock=Nobody')).toEqual({
      type: 'error',
      text: expect.stringMatching(/no player/i),
    });
    expect(model.submit('!block=')).toEqual({
      type: 'error',
      text: expect.stringContaining('!block=<name or id>'),
    });
  });

  it('!blocked lists the blocked players online, with their ids', () => {
    expect(model.submit('!blocked')).toEqual({
      type: 'note',
      text: 'You have blocked nobody online.',
    });
    blocked = [4, 2];
    expect(model.submit('!blocked')).toEqual({
      type: 'note',
      text: 'Blocked: Bob#2, Carol#4. !unblock=<id> lifts one.',
    });
  });

  it('passes admin commands through unchanged using local from the server tab', () => {
    const send = { type: 'send', channel: ChatChannel.LOCAL, target: 0, text: '!teleport=1:2' };
    expect(model.submit('!teleport=1:2')).toEqual(send);
    model.setActive('server');
    expect(model.submit('!teleport=1:2')).toEqual(send);
  });

  it('formats joins, deaths, clan creation and broadcasts in the server tab', () => {
    model.onServerLog({ kind: ServerLogKind.JOIN, a: 2, b: 0, text: '' });
    model.onServerLog({ kind: ServerLogKind.DEATH, a: 2, b: 4, text: '' });
    model.onServerLog({ kind: ServerLogKind.DEATH, a: 2, b: SERVER_LOG_NO_PLAYER, text: '' });
    model.onServerLog({ kind: ServerLogKind.CLAN_CREATED, a: 2, b: 0, text: 'XYZ' });
    model.onServerLog({ kind: ServerLogKind.BROADCAST, a: 4, b: 0, text: 'hi' });
    expect(model.tab('server')!.lines).toMatchObject([
      { text: 'Bob joined the server' },
      { text: 'Bob was killed by Carol' },
      { text: 'Bob died' },
      { text: 'Bob founded the clan [XYZ]' },
      { kind: 'broadcast', pid: 4, text: 'hi' },
    ]);
  });

  it('keeps only the latest 200 lines per tab', () => {
    for (let i = 1; i <= 250; i++) {
      model.onChat({ channel: ChatChannel.LOCAL, pid: 2, peer: 0, flags: 0, text: `line ${i}` });
    }
    expect(MAX_LINES_PER_TAB).toBe(200);
    expect(model.tab('local')!.lines).toHaveLength(MAX_LINES_PER_TAB);
    expect(model.tab('local')!.lines[0].text).toBe('line 51');
  });

  it('cycles forward to global and backward to server from local without admin access', () => {
    model.cycle(1);
    expect(model.active.id).toBe('global');
    model.setActive('local');
    model.cycle(-1);
    expect(model.active.id).toBe('server');
  });

  it('increases version when chat arrives and the active tab changes', () => {
    const beforeChat = model.version;
    model.onChat({ channel: ChatChannel.LOCAL, pid: 2, peer: 0, flags: 0, text: 'hi' });
    expect(model.version).toBeGreaterThan(beforeChat);
    const beforeActive = model.version;
    model.setActive('global');
    expect(model.version).toBeGreaterThan(beforeActive);
  });

  it('offers familiar whisper/reply commands without guessing duplicate names', () => {
    expect(model.submit('/r hello')).toMatchObject({ type: 'error' });
    expect(model.submit('/w Bob hello')).toMatchObject({ type: 'error' });
    expect(model.submit('/w Bob#2 hello')).toEqual({
      type: 'send',
      channel: ChatChannel.PRIVATE,
      target: 2,
      text: 'hello',
    });
    model.onChat({ channel: ChatChannel.PRIVATE, pid: 4, peer: 4, flags: 0, text: 'hey' });
    expect(model.submit('/r yes')).toEqual({
      type: 'send',
      channel: ChatChannel.PRIVATE,
      target: 4,
      text: 'yes',
    });
    expect(model.submit('/help')).toMatchObject({ type: 'note' });
    expect(model.submit('/unknown')).toMatchObject({ type: 'error' });
    expect(model.completePlayers('bo').map((p) => p.whisper)).toEqual(
      expect.arrayContaining(['#2', '#3']),
    );
  });

  it('validates UTF-8 payload size before sending, excluding command syntax', () => {
    model.setAccess({ mask: 1 << ChatChannel.LOCAL });
    expect(chatBytes('é🙂')).toBe(6);
    expect(model.submit('🙂'.repeat(50))).toMatchObject({ type: 'send' });
    expect(model.submit('🙂'.repeat(51))).toMatchObject({ type: 'error' });
    expect(model.submit(`/w Carol ${'é'.repeat(101)}`)).toMatchObject({ type: 'error' });
    expect(model.messageBytes(`/w Carol ${'é'.repeat(100)}`)).toBe(200);
    expect(model.submit(`!priv=4 ${'a'.repeat(200)}`)).toMatchObject({
      type: 'send',
      text: 'a'.repeat(200),
    });
  });

  it('keeps drafts until their matching server echo and keeps them on refusal', () => {
    const action = { type: 'send', channel: ChatChannel.LOCAL, target: 0, text: 'hello' } as const;
    expect(model.beginSend(action, 'local', ' hello ')).toBe(true);
    expect(model.beginSend(action, 'local', ' hello ')).toBe(false);
    model.onChat({ channel: ChatChannel.LOCAL, pid: 2, peer: 0, flags: 0, text: 'hello' });
    expect(model.tab('local')).toMatchObject({ draft: ' hello ', pending: true });
    model.setActive('global');
    model.setDraft('global', 'separate draft');
    model.onChat({ channel: ChatChannel.LOCAL, pid: 1, peer: 0, flags: 0, text: 'hello' });
    expect(model.tab('local')).toMatchObject({ draft: '', pending: false });
    expect(model.active.draft).toBe('separate draft');
    model.beginSend(action, 'local', 'hello');
    model.onChat({
      channel: ChatChannel.LOCAL,
      pid: CHAT_SYSTEM_PID,
      peer: 0,
      flags: 0,
      text: 'Refused',
    });
    expect(model.tab('local')).toMatchObject({ draft: 'hello', pending: false });
  });

  it('retains a draft when its confirmation times out without retrying it', () => {
    let now = 0;
    const m = new ChatModel(
      { nameOf: () => 'Alice', ownGuid: () => 1, ownClan: () => -1, players: () => [] },
      () => now,
    );
    m.beginSend(
      { type: 'send', channel: ChatChannel.LOCAL, target: 0, text: 'hello' },
      'local',
      'hello',
    );
    now = 10001;
    m.refresh();
    expect(m.tab('local')).toMatchObject({ draft: 'hello', pending: false });
    expect(m.tab('local')!.lines.at(-1)?.text).toContain('not confirmed');
  });

  it('tracks mentions and normal messages while reading older lines or a background tab', () => {
    model.setReading('local', false);
    expect(
      model.onChat({ channel: ChatChannel.LOCAL, pid: 2, peer: 0, flags: 0, text: '@Alice hi' })
        ?.unseen,
    ).toBe(true);
    model.onChat({ channel: ChatChannel.LOCAL, pid: 1, peer: 0, flags: 0, text: 'self' });
    expect(model.active).toMatchObject({ unread: 1, unreadMentions: 1 });
    model.setReading('local', true);
    expect(model.active).toMatchObject({ unread: 0, unreadMentions: 0 });
    model.setCollapsed(true);
    model.setReading('local', true);
    model.onChat({ channel: ChatChannel.LOCAL, pid: 2, peer: 0, flags: 0, text: 'hidden' });
    expect(model.active.unread).toBe(1);
  });
});
