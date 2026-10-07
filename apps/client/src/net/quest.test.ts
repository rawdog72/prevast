// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import { QuestAction, QuestCause } from '../../../../shared/typescript/quest-protocol';
import { QuestStore } from '../world/quest-store';
import { BinaryReader } from './binary-stream';
import { markersPacket, progressPacket, questEntry, statePacket } from './quest-fixtures';
import { dispatchServerMessage } from './dispatcher';
import { NetEventBus } from './events';
import { buildQuestActionMessage } from './outbound';

describe('quest wire', () => {
  it('QUEST_ACTION is [53][questId u16][action u8]', () => {
    const r = new BinaryReader(buildQuestActionMessage(0x0102, QuestAction.ABANDON));
    expect([r.u8(), r.u16(), r.u8(), r.remaining()]).toEqual([53, 0x0102, 1, 0]);
  });

  it('QUEST_STATE emits a validated entry and refuses truncated or trailing bytes', () => {
    const bus = new NetEventBus(), seen = vi.fn(); bus.on('questState', seen);
    const p = statePacket(4, QuestCause.STARTED, JSON.stringify(questEntry()));
    dispatchServerMessage(p, bus);
    expect(seen).toHaveBeenCalledOnce();
    expect(seen.mock.calls[0]![0]).toMatchObject({ questId: 4, cause: QuestCause.STARTED, invalid: false, entry: { key: 'ghouls' } });
    seen.mockClear();
    for (let i = 1; i < p.length; i++) dispatchServerMessage(p.slice(0, i), bus);
    dispatchServerMessage(new Uint8Array([...p, 0]), bus);
    expect(seen).not.toHaveBeenCalled();
  });

  it('flags an entry the schema refuses as invalid instead of passing it on', () => {
    const bus = new NetEventBus(), seen = vi.fn(); bus.on('questState', seen);
    dispatchServerMessage(statePacket(1, QuestCause.SYNC, JSON.stringify(questEntry({ state: 'paused' as never }))), bus);
    dispatchServerMessage(statePacket(1, QuestCause.SYNC, '{not json'), bus);
    expect(seen.mock.calls.map((c) => [c[0].entry, c[0].invalid])).toEqual([[null, true], [null, true]]);
  });

  it('QUEST_PROGRESS and QUEST_MARKERS decode exactly', () => {
    const bus = new NetEventBus(), progress = vi.fn(), markers = vi.fn();
    bus.on('questProgress', progress); bus.on('questMarkers', markers);
    dispatchServerMessage(progressPacket(2, 1, 70000), bus);
    dispatchServerMessage(markersPacket([[3, 2], [1, 1]]), bus);
    dispatchServerMessage(markersPacket([[3, 2]]).slice(0, 4), bus);
    expect(progress).toHaveBeenCalledWith({ questId: 2, objective: 1, count: 70000 });
    expect(markers).toHaveBeenCalledOnce();
    expect([...markers.mock.calls[0]![0].markers]).toEqual([[3, 2], [1, 1]]);
  });
});

describe('QuestStore', () => {
  const setup = () => {
    let now = 0;
    const bus = new NetEventBus(), store = new QuestStore(() => now);
    store.attachBus(bus);
    const socket = { questAction: vi.fn() };
    return { bus, store, socket, advance: (ms: number) => { now += ms; } };
  };

  it('keeps entries by id, applies counters, flashes a finished objective and unlocks what waited on it', () => {
    const { bus, store } = setup();
    dispatchServerMessage(statePacket(0, QuestCause.STARTED, JSON.stringify(questEntry())), bus);
    dispatchServerMessage(progressPacket(0, 0, 2), bus);
    const objectives = store.byKey('ghouls')!.entry.stages[0]!.objectives;
    expect(objectives[0]!.count).toBe(2);
    expect(objectives[1]!.locked).toBe(true);
    dispatchServerMessage(progressPacket(0, 0, 3), bus);
    expect(store.isFlashing('ghouls', 'ghouls')).toBe(true);
    expect(objectives[1]!.locked).toBe(false);
  });

  it('auto-tracks new quests up to three, and toggling pins or unpins', () => {
    const { bus, store } = setup();
    ['a', 'b', 'c', 'd'].forEach((key, id) =>
      dispatchServerMessage(statePacket(id, QuestCause.STARTED, JSON.stringify(questEntry({ key }))), bus));
    expect(store.trackedRecords.map((r) => r.entry.key)).toEqual(['a', 'b', 'c']);
    store.toggleTrack('b');
    store.toggleTrack('d');
    expect(store.trackedRecords.map((r) => r.entry.key)).toEqual(['a', 'c', 'd']);
  });

  it('REMOVED drops one entry, RESET drops all, and a quest that moved id is not kept twice', () => {
    const { bus, store } = setup();
    dispatchServerMessage(statePacket(0, QuestCause.SYNC, JSON.stringify(questEntry())), bus);
    dispatchServerMessage(statePacket(5, QuestCause.SYNC, JSON.stringify(questEntry())), bus);
    expect(store.all.map((r) => r.id)).toEqual([5]);
    dispatchServerMessage(statePacket(5, QuestCause.REMOVED, ''), bus);
    expect(store.all).toEqual([]);
    dispatchServerMessage(statePacket(1, QuestCause.SYNC, JSON.stringify(questEntry())), bus);
    dispatchServerMessage(statePacket(0xffff, QuestCause.RESET, ''), bus);
    expect(store.all).toEqual([]);
  });

  it('asks for one resync after bad data, at most every three seconds', () => {
    const { bus, store, socket, advance } = setup();
    advance(10_000);
    dispatchServerMessage(progressPacket(9, 0, 1), bus);
    store.update(socket);
    store.update(socket);
    dispatchServerMessage(statePacket(1, QuestCause.SYNC, '{bad'), bus);
    store.update(socket);
    advance(3000);
    store.update(socket);
    expect(socket.questAction.mock.calls).toEqual([[0, QuestAction.RESYNC], [0, QuestAction.RESYNC]]);
  });

  it('abandon sends the quest id for active quests only', () => {
    const { bus, store, socket } = setup();
    dispatchServerMessage(statePacket(3, QuestCause.SYNC, JSON.stringify(questEntry())), bus);
    dispatchServerMessage(statePacket(4, QuestCause.SYNC, JSON.stringify(questEntry({ key: 'done', state: 'completed', stage: '' }))), bus);
    store.abandon(socket, 'ghouls');
    store.abandon(socket, 'done');
    expect(socket.questAction.mock.calls).toEqual([[3, QuestAction.ABANDON]]);
  });
});
