// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import { NpcAction, npcKeywords, type NpcState } from '../../../../shared/typescript/npc-protocol';
import { BinaryReader, BinaryWriter } from './binary-stream';
import { dispatchServerMessage } from './dispatcher';
import { NetEventBus } from './events';
import { ClientOpcode, ServerOpcode } from './opcodes';
import { buildNpcActionMessage } from './outbound';
import { GameSocket } from './socket';
import { NpcStore } from '../world/npc-store';
import { ChatModel } from '../chat/chat-model';
import { convertTable } from '../../../../tools/content/xml-to-json';

export const npcState = (overrides: Partial<NpcState> = {}): NpcState => ({
  session: 21, revision: 1, entityId: 70001, name: 'Mara', topic: 'root', panel: '',
  text: 'Welcome. {trade}', banker: false, tradeAllowed: true, balance: 0, wallet: 20000,
  range: 200, request: 0, restockSeconds: 300, offers: [], ...overrides,
});
const packet = (s: unknown) => { const w = new BinaryWriter(); w.u8(ServerOpcode.NPC_STATE); w.str(JSON.stringify(s)); return w.build(); };

describe('NPC wire and authority', () => {
  it('uses 32-bit entity/session/request/amount fields without truncating stacks', () => {
    const bytes = buildNpcActionMessage({session: 21, revision: 9, request: 12, action: NpcAction.BUY, target: 70001, amount: 4096});
    const r = new BinaryReader(bytes);
    expect([r.u8(), r.u32(), r.u32(), r.u32(), r.u8(), r.u32(), r.u32(), r.str(), r.remaining()])
      .toEqual([ClientOpcode.NPC_ACTION,21,9,12,2,70001,4096,'',0]);
  });
  it('rejects malformed, truncated, excessive and trailing state without emitting partial data', () => {
    const bus=new NetEventBus(), receive=vi.fn(); bus.on('npcState', receive);
    const p=packet(npcState()); dispatchServerMessage(p,bus);
    expect(receive).toHaveBeenCalledOnce(); receive.mockClear();
    for(let i=1;i<p.length;i++) dispatchServerMessage(p.slice(0,i),bus);
    dispatchServerMessage(new Uint8Array([...p,0]),bus);
    for(const invalid of [{balance:-1},{wallet:2_000_000_001},{panel:'barter'},{session:0},{text:'x'.repeat(513)}])
      dispatchServerMessage(packet(npcState(invalid as Partial<NpcState>)),bus);
    expect(receive).not.toHaveBeenCalled();
  });
  it('disables duplicate submissions, binds pills to revisions, and recovers by refresh only', () => {
    const store=new NpcStore(), socket=new GameSocket({url:'ws://localhost',login:{nickname:'Test'},bus:new NetEventBus()});
    const send=vi.spyOn(socket,'npcAction').mockImplementation(()=>{});
    store.receive(npcState());
    expect(store.say(socket,'yes',0)).toBe(false);
    expect(store.command(socket,NpcAction.BUY,0,300)).toBe(true);
    expect(store.command(socket,NpcAction.BUY,0,300)).toBe(false);
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+3000);
    store.update(socket); clock.mockRestore();
    expect(send.mock.calls.map(c=>c[0].action)).toEqual([NpcAction.BUY,NpcAction.REFRESH]);
    expect(store.state!.wallet).toBe(20000);
    store.receive(npcState({revision:2,request:2})); expect(store.pending).toBe(false);
    store.receive(npcState({revision:1,wallet:0})); expect(store.state!.wallet).toBe(20000);
  });
  it('does not resurrect a closed session from delayed messages', () => {
    const store=new NpcStore(), bus=new NetEventBus(); store.attachBus(bus);
    const socket=new GameSocket({url:'ws://localhost',login:{nickname:'Test'},bus});
    vi.spyOn(socket,'npcAction').mockImplementation(()=>{});
    bus.emit('npcState',npcState()); store.close(socket);
    bus.emit('npcState',npcState({revision:99,panel:'shop'})); expect(store.state).toBeNull();
    bus.emit('npcState',npcState({session:22})); expect(store.state?.session).toBe(22);
    bus.emit('npcState',npcState({session:21,revision:100})); expect(store.state?.session).toBe(22);
    bus.emit('playerDie',{score:0,level:0,kills:0,survival:0,items:[]} as never);
    expect(store.state).toBeNull();
  });
  it('opens a closable dedicated tab and routes typed dialogue without sending public chat', () => {
    const chat=new ChatModel({nameOf:()=>undefined,ownGuid:()=>1,ownClan:()=>-1,players:()=>[]});
    chat.onNpc(npcState());
    expect(chat.active.label).toBe('[NPC: Mara]'); expect(chat.active.closable).toBe(true);
    expect(chat.submit('trade')).toEqual({type:'npc',session:21,revision:1,text:'trade'});
    chat.onNpc(npcState({session:22,name:'Elias'}));
    expect(chat.active.label).toBe('[NPC: Elias]');
    chat.closeNpcs(22); expect(chat.active.id).toBe('local');
  });
  it('keeps HTML as text when parsing keyword markup', () => {
    expect(npcKeywords('<img src=x> {yes} or {no}')).toEqual([
      {text:'<img src=x> ',keyword:false},{text:'yes',keyword:true},
      {text:' or ',keyword:false},{text:'no',keyword:true},
    ]);
  });
  it('exports appearance only, keeping rare rolls, quest rewards and Lua paths private', () => {
    const table=convertTable('<npcs><quest key="q"/><spawn key="s"/><npc key="m" id="1" name="Mara" script="secret.lua"><client head="h" leftArm="l" rightArm="r"/><shop><rareOffer chanceBps="50"/></shop><dialogue greeting="secret"/></npc></npcs>','npcs');
    expect(Object.keys(table.entries)).toEqual(['m']);
    expect(table.entries.m).toEqual({id:1,key:'m',name:'Mara',client:{head:'h',leftArm:'l',rightArm:'r'}});
  });
});
