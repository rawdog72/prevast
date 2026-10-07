// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { NpcWindow } from './npc-window';
import { NpcStore } from '../../world/npc-store';
import { GameSocket } from '../../net/socket';
import { ContentStore } from '../../content/store';
import type { NpcState } from '../../../../../shared/typescript/npc-protocol';
import { NetEventBus } from '../../net/events';

describe('NpcWindow', () => {
  it('bounds quantity with server Max, computes totals and prevents double purchases', () => {
    const npc=new NpcStore(), socket=new GameSocket({url:'ws://localhost',login:{nickname:'Test'},bus:new NetEventBus()});
    const send=vi.spyOn(socket,'npcAction').mockImplementation(()=>{});
    const state:NpcState={session:1,revision:2,entityId:10,name:'<script>evil</script>',topic:'root',panel:'shop',text:'',banker:false,tradeAllowed:true,balance:0,wallet:10000,range:200,request:0,restockSeconds:500,offers:[{index:0,iid:2,buy:3,sell:1,stock:0,unlimited:true,rare:false,buyMax:300,sellMax:10}]};
    npc.receive(state);
    const body=document.createElement('div'), win=new NpcWindow(), deps={npc,socket,content:new ContentStore()}; win.mount(body,deps);
    expect(body.querySelector('script')).toBeNull();
    const max=[...body.querySelectorAll('button')].find(b=>b.textContent==='Max')!; max.click();
    expect(body.querySelector<HTMLInputElement>('input[type=number]')!.value).toBe('300');
    expect(body.querySelector('.dv-npc-total')!.textContent).toBe('900 caps');
    body.querySelector<HTMLButtonElement>('.dv-npc-primary')!.click();
    body.querySelector<HTMLButtonElement>('.dv-npc-primary')!.click();
    expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0]![0]).toMatchObject({action:2,amount:300,revision:2});
    expect(npc.state!.wallet).toBe(10000);
    expect(body.querySelector<HTMLButtonElement>('.dv-npc-primary')!.disabled).toBe(true);
  });
});
