// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { BinaryWriter } from '../binary-stream';
import { NetEventBus } from '../events';
import { ServerOpcode } from '../opcodes';
import { handleGroups, handlePlayerInfo } from './social';

function playerInfo(trailer: number[]): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ServerOpcode.PLAYER_INFO);
  w.u8(5);
  w.u32(1005);
  w.u8(0);
  w.u8(0);
  w.str('Alice');
  for (const b of trailer) w.u8(b);
  return w.build();
}

describe('identity decoding', () => {
  it('reads group and verified flag from PLAYER_INFO', () => {
    const bus = new NetEventBus();
    const seen: unknown[] = [];
    bus.on('playerInfo', (ev) => seen.push(ev));
    handlePlayerInfo(playerInfo([4, 1]), bus);
    handlePlayerInfo(playerInfo([]), bus);
    expect(seen).toEqual([
      { guid: 5, tokenId: 1005, skin: 0, ghoul: 0, name: 'Alice', groupId: 4, verified: true },
      { guid: 5, tokenId: 1005, skin: 0, ghoul: 0, name: 'Alice', groupId: 0, verified: false },
    ]);
  });

  it('reads GROUPS', () => {
    const w = new BinaryWriter();
    w.u8(ServerOpcode.GROUPS);
    w.u8(2);
    w.u8(2);
    w.str('tutor');
    w.str('tutor');
    w.u8(4);
    w.str('admin');
    w.str('admin');
    const bus = new NetEventBus();
    let groups: unknown = null;
    bus.on('groups', (ev) => (groups = ev.groups));
    handleGroups(w.build(), bus);
    expect(groups).toEqual([
      { id: 2, name: 'tutor', badge: 'tutor' },
      { id: 4, name: 'admin', badge: 'admin' },
    ]);
  });
});
