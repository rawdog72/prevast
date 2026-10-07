// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/net/quest-fixtures.ts
// Quest journal entries and QUEST_* server messages for tests.
import type { QuestEntry } from '../../../../shared/typescript/quest-protocol';
import { BinaryWriter } from './binary-stream';

export const questEntry = (overrides: Partial<QuestEntry> = {}): QuestEntry => ({
  key: 'ghouls', name: 'Clear the Road', category: 'side', description: 'Rook wants the road cleared.', abandon: true,
  state: 'active', stage: 'hunt', ending: '',
  stages: [{
    key: 'hunt', journal: 'Defeat 3 normal ghouls, then report to Rook.', current: true, outcome: '', rewards: '',
    objectives: [
      { key: 'ghouls', text: 'Defeat normal ghouls', type: 'kill', count: 0, required: 3, after: '', locked: false, item: '' },
      { key: 'report', text: 'Report to Rook', type: 'talk', count: 0, required: 1, after: 'ghouls', locked: true, item: '' },
    ],
  }],
  ...overrides,
});
export const statePacket = (id: number, cause: number, json: string) => {
  const w = new BinaryWriter(); w.u8(103); w.u16(id); w.u8(cause); w.str(json); return w.build();
};
export const progressPacket = (id: number, objective: number, count: number) => {
  const w = new BinaryWriter(); w.u8(104); w.u16(id); w.u8(objective); w.u32(count); return w.build();
};
export const markersPacket = (markers: [number, number][]) => {
  const w = new BinaryWriter(); w.u8(105); w.u8(markers.length);
  for (const [id, kind] of markers) { w.u16(id); w.u8(kind); }
  return w.build();
};
