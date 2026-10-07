// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Run against an isolated server: npx tsx tools/live-npc-test.ts (default :7472).
// Creates admin test characters and modifies only their inventory/position.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { unwrapBatch } from '../../apps/client/src/net/batch';
import { dispatchServerMessage } from '../../apps/client/src/net/dispatcher';
import { NetEventBus, type TradeStateEvent, type TradeItem } from '../../apps/client/src/net/events';
import * as wire from '../../apps/client/src/net/outbound';
import { InventoryStore } from '../../apps/client/src/world/inventory-store';
import { WorldState } from '../../apps/client/src/world/world-state';
import { NpcAction, type NpcState } from '../../shared/typescript/npc-protocol';
import { QuestStore } from '../../apps/client/src/world/quest-store';
import { QuestAction } from '../../shared/typescript/quest-protocol';

const url = process.env.NPC_TEST_URL || 'ws://127.0.0.1:7472';
const password = process.env.NPC_TEST_PASSWORD || 'prevast';
const items = JSON.parse(
  readFileSync(new URL('../fixtures/content/items.json', import.meta.url), 'utf8'),
).entries;
const iid = (key: string): number => {
  assert(items[key], `Unknown item ${key}`);
  return items[key].id;
};
const noteValue: number = items.banknote.currency.value;
const goldValue: number = items.gold_bar.currency.value;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => unknown, label: string, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timeout: ${label}`);
    await delay(30);
  }
}
class Bot {
  ws!: WebSocket;
  bus = new NetEventBus();
  inventory = new InventoryStore();
  world = new WorldState();
  trade: TradeStateEvent | null = null;
  closed: string[] = [];
  alerts: string[] = [];
  token = '';
  seen = 0;
  constructor(readonly name: string) {
    this.inventory.attachBus(this.bus);
    this.world.attachBus(this.bus);
    this.bus.on('tradeState', (s) => {
      this.trade = s;
      this.seen++;
    });
    this.bus.on('tradeClosed', (e) => {
      this.trade = null;
      this.closed.push(e.reason);
    });
    this.bus.on('alert', (e) => this.alerts.push(e.text));
    this.bus.on('nicknames', (e) => {
      this.token = e.sessionToken;
    });
  }
  async connect(token = '') {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      for (const packet of unwrapBatch(new Uint8Array(data as Buffer)))
        dispatchServerMessage(packet, this.bus);
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.once('error', reject);
      this.ws.once('open', () => {
        this.send(wire.buildLoginMessage({ nickname: this.name, password, token }));
        resolve();
      });
    });
    await until(
      () => this.world.ownGuid && this.inventory.slots.some((s) => s.iid > 0),
      'login ' + this.name,
    );
    return this;
  }
  send(message: Uint8Array) {
    this.ws.send(message);
  }
  cmd(text: string) {
    this.send(wire.buildChatMessage(text));
  }
  total(key: string) {
    return this.inventory.slots.filter((i) => i.iid === iid(key)).reduce((n, i) => n + i.count, 0);
  }
  item(key: string) {
    const item = this.inventory.slots.find((i) => i.iid === iid(key));
    assert(item, key + ' in inventory');
    return { ...item };
  }
  async add(key: string, count: number) {
    const before = this.total(key);
    this.cmd(`!i=${key}*${count}`);
    await until(() => this.total(key) > before, 'add ' + key);
  }
  async offer(item: TradeItem, count = item.count) {
    assert(this.trade);
    const revision = this.trade.revision;
    this.send(wire.buildTradeOfferMessage(this.trade.id, revision, item.iid, item.uid, count));
    await until(() => this.trade && this.trade.revision > revision, 'offer acknowledgement');
  }
  accept(revision = this.trade!.revision) {
    this.send(wire.buildTradeAcceptMessage(this.trade!.id, revision));
  }
  async clear() {
    for (const item of [...this.inventory.slots])
      if (item.iid)
        this.send(wire.buildThrowItemMessage(item.iid, item.uid, item.count, item.ammo));
    await until(() => this.inventory.slots.every((i) => !i.iid), 'clear inventory');
  }
}

class NpcBot extends Bot {
  npc: NpcState | null = null;
  sequence=0;
  quests=new QuestStore(()=>Date.now());
  constructor(name:string) { super(name); this.bus.on('npcState',s=>{this.npc=s; this.sequence=Math.max(this.sequence,s.request);}); this.bus.on('npcClosed',()=>{this.npc=null;}); this.quests.attachBus(this.bus); }
  quest(key:string) { return this.quests.byKey(key)?.entry; }
  statuses:string[]=[]; chats:string[]=[];
  listen() { this.bus.on('statusMessage',e=>this.statuses.push(e.text)); this.bus.on('chat',e=>this.chats.push(e.text)); return this; }
  agentsNear(range=900) {
    const me=this.world.getLocalEntity();
    return this.world.entities.getByType(13).filter(e=>!e.removed&&(!me||Math.hypot(e.x-me.x,e.y-me.y)<range)).length;
  }
  wallet() { return this.total('bottle_cap') + noteValue*this.total('banknote') + goldValue*this.total('gold_bar'); }
  async openNpc(id:number, tileX:number) {
    this.cmd(`!teleport-player-to=${this.world.ownGuid}:${tileX}:41`); await delay(300);
    await until(()=>this.world.entities.getByType(14).some(n=>n.extra===id&&!n.removed&&!n.retracted),'NPC entity visible');
    const entity=this.world.entities.getByType(14).find(n=>n.extra===id&&!n.removed&&!n.retracted)!;
    const old=this.npc?.session; this.send(wire.buildNpcActionMessage({session:0,revision:0,request:0,action:NpcAction.OPEN,target:entity.id}));
    await until(()=>this.npc&&this.npc.session!==old,'open NPC '+id); return this.npc!;
  }
  async act(action:NpcAction,target=0,amount=0,text='') {
    assert(this.npc); await delay(220);
    const before=this.npc.revision;
    const packet=wire.buildNpcActionMessage({session:this.npc.session,revision:before,request:++this.sequence,action,target,amount,text});
    this.send(packet); await until(()=>this.npc&&this.npc.revision>before,'action '+action+' '+text); return packet;
  }
  say(text:string) { return this.act(NpcAction.SAY,0,0,text); }
}
let a:NpcBot,b:NpcBot;
try {
  a=await new NpcBot('NPC_QA_A').connect() as NpcBot;
  b=await new NpcBot('NPC_QA_B').connect() as NpcBot;
  await a.openNpc(1,40); await b.openNpc(1,40);
  await a.clear(); await b.clear(); await a.add('banknote',100);
  await a.say('trade'); await b.say('trade'); assert.equal(a.npc!.panel,'shop');
  assert.equal(a.npc!.wallet,100*noteValue);
  const buy=await a.act(NpcAction.BUY,0,300);
  await until(()=>a.total('wood')===300,'300 wood purchase'); assert.equal(a.wallet(),100*noteValue-900);
  assert(a.inventory.slots.filter(i=>i.iid===iid('wood')).every(i=>i.count<=255));
  a.send(buy); await delay(250); assert.equal(a.total('wood'),300); assert.equal(a.wallet(),100*noteValue-900);
  await a.act(NpcAction.SELL,0,10); assert.equal(a.total('wood'),290); assert.equal(a.wallet(),100*noteValue-890);
  console.log('PASS multi-stack purchase, exact change, selling and duplicate replay rejection');
  const snap=JSON.stringify(a.inventory.slots);
  await a.act(NpcAction.BUY,3,6); assert.equal(JSON.stringify(a.inventory.slots),snap);
  console.log('PASS shared finite stock limits and atomic rejection');
  const offers=JSON.stringify(a.npc!.offers.map(o=>[o.index,o.stock]));
  for(let i=0;i<3;i++) { await a.openNpc(1,40); await a.say('trade'); assert.equal(JSON.stringify(a.npc!.offers.map(o=>[o.index,o.stock])),offers); }
  console.log('PASS reopening does not reroll stock');
  await a.openNpc(2,42); await a.say('bank');
  const carriedBeforeBank=a.wallet();
  await a.act(NpcAction.DEPOSIT,0,9000); assert.equal(a.npc!.balance,9000); assert.equal(a.wallet(),carriedBeforeBank-9000);
  await a.act(NpcAction.WITHDRAW,0,10000); assert.equal(a.npc!.balance,9000); assert.equal(a.wallet(),carriedBeforeBank-9000);
  await a.act(NpcAction.WITHDRAW,0,100); assert.equal(a.npc!.balance,8900); assert.equal(a.wallet(),carriedBeforeBank-8900);
  await a.act(NpcAction.CONVERT,0,255); assert.equal(a.total('bottle_cap'),(carriedBeforeBank-8900-255)%noteValue+255); assert.equal(a.wallet(),carriedBeforeBank-8900);
  const token=a.token; a.ws.close(); await delay(250);
  a=await new NpcBot('NPC_QA_A').connect(token) as NpcBot;
  await a.openNpc(2,42); await a.say('bank'); assert.equal(a.npc!.balance,8900);
  console.log('PASS bank deposit/withdraw/conversion, insufficient balance and reconnect retention');
  // The reconnect above got a fresh QUEST_STATE/QUEST_MARKERS sync: Mara has work (!).
  await until(()=>a.quests.markers.get(1)===1,'Mara shows a quest to start');
  await a.openNpc(1,40); await a.say('job');
  assert.match(a.npc!.text,/Say \{yes\} or \{no\}/);
  await a.say('yes');
  await until(()=>a.quests.markers.get(1)===2,'Mara shows a step to finish');
  const firewood=a.quest('supplies')!;
  assert.equal(firewood.state,'active');
  assert.equal(firewood.stages.at(-1)!.objectives[0]!.text,'Bring firewood to Mara');
  assert.equal(firewood.stages.at(-1)!.objectives[0]!.type,'give');
  // Partial hand-in: 4 now, the rest later.
  const kept=a.total('wood');
  await a.clear(); await a.add('wood',4);
  const before=a.wallet(); await a.say('finish');
  assert.equal(a.total('wood'),0); assert.match(a.npc!.text,/Bring me 6 more/);
  await until(()=>a.quest('supplies')!.stages.at(-1)!.objectives[0]!.count===4,'4 of 10 delivered');
  await a.add('wood',10); await a.say('finish');
  assert.equal(a.wallet(),before+100); assert.equal(a.total('wood'),4);
  await a.add('wood',kept);
  await a.say('finish'); assert.equal(a.wallet(),before+100);
  assert.match(a.npc!.text,/already been paid/);
  await until(()=>!a.quests.markers.has(1),'Mara has nothing left for us');
  assert.equal(a.quest('supplies')!.stages.at(-1)!.rewards,'100 caps');
  console.log('PASS confirm offer, give objective turn-in, exactly-once rewards and NPC markers');
  await a.openNpc(3,44); await a.say('delivery'); await a.say('rumours');
  assert.match(a.npc!.text,/stock|clock|hour|road/i);
  await a.say('delivery'); assert.match(a.npc!.text,/still waiting/);
  const preDelivery=a.total('wood'); await a.openNpc(2,42);
  assert.equal(a.total('wood'),preDelivery,'opening a conversation no longer consumes items');
  await a.say('delivery'); assert.equal(a.total('wood'),preDelivery-5);
  await a.openNpc(3,44); const preReward=a.wallet(); await a.say('delivery');
  assert.equal(a.wallet(),preReward+125);
  assert.equal(a.quest('delivery')?.state,'completed');
  console.log('PASS multi-NPC stages, give consumption and optional Lua dialogue');
  await a.openNpc(3,44); await a.say('ghouls');
  assert.equal(a.quest('ghouls')?.state,'active');
  await a.say('ghouls'); assert.match(a.npc!.text,/still out there/);
  a.cmd(`!quest=stage:${a.world.ownGuid}:ghouls:hunt`); await delay(300);
  a.cmd(`!quest=complete:${a.world.ownGuid}:ghouls`); await delay(300);
  await a.say('ghouls'); assert.match(a.npc!.text,/already cleared/);
  await a.say('medicine'); assert.equal(a.quest('bandages')?.state,'active');
  a.send(wire.buildQuestActionMessage(a.quests.byKey('bandages')!.id,QuestAction.ABANDON));
  await until(()=>!a.quest('bandages'),'abandoned quest leaves the journal');
  console.log('PASS stage-gated dialogue and admin quest control');
  await a.openNpc(4,46); await a.say('trade'); assert.equal(a.npc!.tradeAllowed,false);
  a.cmd(`!karma=${a.world.ownGuid}:4`); await delay(1200); await a.say('trade'); assert.equal(a.npc!.tradeAllowed,true); assert.equal(a.npc!.panel,'shop');
  await a.openNpc(1,40); await a.say('trade'); assert.equal(a.npc!.tradeAllowed,false);
  a.cmd(`!karma=${a.world.ownGuid}:2`); await delay(1200); await a.say('trade');
  assert.equal(a.npc!.offers[0]!.buy,4); assert.equal(a.npc!.offers[0]!.sell,0);
  a.cmd(`!karma=${a.world.ownGuid}:0`); await delay(1200);
  await a.openNpc(1,40); await a.say('trade');
  await a.add('banknote',100); await a.act(NpcAction.REFRESH);
  await b.openNpc(1,40); await b.add('banknote',100); await b.say('trade');
  const finite=a.npc!.offers.find(o=>o.index===3)!;
  assert(finite.stock>0,'test instance must start with finite hatchet stock');
  if(finite.stock>1) await a.act(NpcAction.BUY,3,finite.stock-1);
  await delay(400); await b.act(NpcAction.REFRESH);
  const aItems=a.total('hatchet'),bItems=b.total('hatchet');
  const aCoins=a.wallet(),bCoins=b.wallet();
  assert.equal(a.npc!.offers.find(o=>o.index===3)!.stock,1);
  assert.equal(b.npc!.offers.find(o=>o.index===3)!.stock,1);
  for(const bot of [a,b]) bot.send(wire.buildNpcActionMessage({session:bot.npc!.session,revision:bot.npc!.revision,request:++bot.sequence,action:NpcAction.BUY,target:3,amount:1}));
  await delay(600);
  assert.equal(a.total('hatchet')+b.total('hatchet'),aItems+bItems+1);
  assert.equal(a.wallet()+b.wallet(),aCoins+bCoins-120);
  console.log('PASS simultaneous last-stock purchase grants and charges exactly once');

  // A full bag must reject a purchase without charging or spilling ground loot.
  await b.clear(); await b.add('banknote',10);
  const slots=b.inventory.slots.length;
  await b.add('hatchet',slots-1); await b.act(NpcAction.REFRESH);
  const full=JSON.stringify(b.inventory.slots),fullWallet=b.wallet();
  assert.equal(b.npc!.offers.find(o=>o.index===0)!.buyMax,0);
  await b.act(NpcAction.BUY,0,1);
  assert.equal(JSON.stringify(b.inventory.slots),full); assert.equal(b.wallet(),fullWallet);
  console.log('PASS full-bag Max and purchase failure preserve the complete inventory');

  // Automated valid request IDs and revisions, not only duplicate packets.
  await a.openNpc(2,42); await a.say('bank'); await delay(2200);
  const saved=a.wallet()+a.npc!.balance;
  let stop=false,accepted=0,nextDeposit=true;
  const beforeBalance=a.npc!.balance;
  const off=a.bus.on('npcState',state=>{
    if(stop||state.panel!=='bank')return;
    if(state.text==='Done.') {accepted++;nextDeposit=!nextDeposit;}
  });
  const start=Date.now();
  let peerProbe: Promise<number> | undefined;
  while(Date.now()-start<1000) {
    if(!peerProbe&&Date.now()-start>=250) {
      const probeStart=Date.now();
      peerProbe=b.act(NpcAction.REFRESH).then(()=>Date.now()-probeStart);
    }
    const s=a.npc!;
    a.send(wire.buildNpcActionMessage({session:s.session,revision:s.revision,request:++a.sequence,action:nextDeposit?NpcAction.DEPOSIT:NpcAction.WITHDRAW,target:0,amount:1}));
    await delay(5);
  }
  stop=true;off();await delay(500);
  assert(accepted>0&&accepted<=16,`character budget admitted ${accepted} operations in one second`);
  assert.equal(a.wallet()+a.npc!.balance,saved);
  assert(Math.abs(a.npc!.balance-beforeBalance)<=2);
  assert(peerProbe && await peerProbe<2000,'another player remains responsive during spam');
  await delay(1000); await a.act(NpcAction.REFRESH);
  assert.equal(a.wallet()+a.npc!.balance,saved);
  console.log(`PASS 5ms bank spam: ${accepted} commits, wealth conserved, peer responsive`);

  const safe=JSON.stringify(a.inventory.slots),safeBalance=a.npc!.balance;
  for(const amount of [0,0xffffffff]) {
    const s=a.npc!;
    a.send(wire.buildNpcActionMessage({session:s.session,revision:s.revision,request:++a.sequence,action:NpcAction.WITHDRAW,amount}));
    await delay(250); await a.act(NpcAction.REFRESH);
  }
  assert.equal(JSON.stringify(a.inventory.slots),safe);assert.equal(a.npc!.balance,safeBalance);
  console.log('PASS zero and overflowing amounts cannot mutate funds');

  await a.openNpc(1,40); await a.say('quests');
  assert.match(a.npc!.text,/no new work/);
  const completed=a.quest('supplies')!;
  assert.match(completed.description,/Mara/);assert.match(completed.ending,/paid/);
  console.log('PASS journal description, ending text and offer listing');
  if(process.env.NPC_TEST_RUNTIME) {
    const runtime=process.env.NPC_TEST_RUNTIME;
    const questFile=join(runtime,'data/quests/supplies.xml');
    const original=readFileSync(questFile,'utf8');
    const oldSession=a.npc!.session,bank=a.npc!.balance;
    try {
      writeFileSync(questFile,original.replace('<ending ','<invalid '));
      a.cmd('!reload-quests');await delay(500);
      assert.equal(a.npc!.session,oldSession,'a rejected quest reload leaves sessions alone');
      await a.say('quests');assert.equal(a.quest('supplies')?.state,'completed');
    } finally {writeFileSync(questFile,original);}
    a.cmd('!reload-quests');await delay(500);
    await a.say('quests');assert.equal(a.quest('supplies')?.state,'completed');
    a.cmd('!reload-npcs');await until(()=>!a.npc,'valid NPC reload closes old session');
    await a.openNpc(2,42);await a.say('bank');
    assert.equal(a.npc!.balance,bank);
    assert.equal(a.quest('supplies')?.state,'completed');
    await a.openNpc(1,40);await a.say('trade');
    assert.equal(a.npc!.offers.find(o=>o.index===3)!.stock,0);
    console.log('PASS quest reload keeps progress; NPC reload keeps bank, quests and shared stock');

    // Lua quest scripting, end to end: hooks, variables, timers, spawned
    // (tagged) agents, a script-driven ending and a trigger script.
    const scriptFiles=[join(runtime,'data/quests/script_demo.xml'),join(runtime,'data/quests/scripts/script_demo.lua'),join(runtime,'data/scripts/triggers/demo.lua'),join(runtime,'data/quests/area_demo.xml')];
    mkdirSync(join(runtime,'data/quests/scripts'),{recursive:true}); mkdirSync(join(runtime,'data/scripts/triggers'),{recursive:true});
    writeFileSync(scriptFiles[0],`<?xml version="1.0" encoding="UTF-8"?>
<quest key="script_demo" name="Script Demo" script="script_demo.lua" description="A test of quest scripting.">
  <start><talk npc="banker" keyword="errand" text="A little errand."/></start>
  <stage key="hunt" journal="Deal with the ambush.">
    <objective key="ambush" type="kill" target="@ambush" count="2" text="Defeat the ambushers"/>
    <outcome when="all" next="end:done"/>
  </stage>
  <ending key="done" journal="Done."/>
</quest>`);
    writeFileSync(scriptFiles[1],`return {
  onStart = function(ctx)
    return {
      { say = "Watch out, " .. ctx.player.name },
      { setVar = "n", value = 41 },
      { spawnAgent = "normal_ghoul", count = 2, radius = 400, tag = "ambush" },
      { after = { seconds = 2, hook = "tick" } },
    }
  end,
  tick = function(ctx)
    return { { setVar = "n", add = 1 }, { status = "tick " .. (ctx.quest.vars.n + 1) }, { complete = "done" } }
  end,
}`);
    writeFileSync(scriptFiles[2],`return {
  on = { "quest_complete:script_demo" },
  onEvent = function(ctx, ev) return { { status = "trigger saw " .. ev.subject } } end,
}`);
    writeFileSync(scriptFiles[3],`<?xml version="1.0" encoding="UTF-8"?>
<quest key="area_demo" name="Area Demo" description="A test of quest areas.">
  <area key="bank" near="npc:banker" radius="150"/>
  <area key="post" near="npc:quartermaster" radius="150"/>
  <start><enter area="bank"/></start>
  <stage key="walk" journal="Walk to Rook.">
    <objective key="post" type="enter_area" area="post" text="Reach Rook's post"/>
    <outcome when="all" next="end:done"/>
  </stage>
  <ending key="done" journal="Arrived."/>
</quest>`);
    try {
      a.listen();
      a.cmd('!reload-quests'); await delay(600);
      await a.openNpc(2,42); const before=a.agentsNear();
      await a.say('errand');
      await until(()=>a.quest('script_demo')?.state==='active','scripted quest started');
      await until(()=>a.chats.some(t=>t.startsWith('Watch out, ')),'onStart said something');
      await until(()=>a.agentsNear()>=before+2,'two ambushers spawned');
      await until(()=>a.statuses.includes('tick 42'),'the timer ran with the quest variable',6000);
      await until(()=>a.quest('script_demo')?.state==='completed','the script completed the quest');
      await until(()=>a.statuses.includes('trigger saw script_demo'),'the trigger script saw the completion');
      await until(()=>a.agentsNear()<=before,'the ambushers left with the quest');
      console.log('PASS Lua hooks, variables, timers, tagged spawns, script ending and trigger scripts');
      await until(()=>a.quest('area_demo')?.state==='active','standing at Elias started the area quest');
      await a.openNpc(3,44);
      await until(()=>a.quest('area_demo')?.state==='completed','reaching Rook completed it');
      console.log('PASS quest areas start and advance quests by where the player walks');
    } finally {
      for (const file of scriptFiles) rmSync(file,{force:true});
      a.cmd('!reload-quests'); await delay(600);
    }

    await b.clear();await b.add('banknote',100);await b.openNpc(1,40);await b.say('trade');
    const bag=JSON.stringify(b.inventory.slots);
    const stock=readFileSync(join(runtime,'storage/npc-stock.xml'),'utf8');
    const blocked=join(runtime,'storage/npc-stock.xml.tmp');
    mkdirSync(blocked);
    try {
      await b.act(NpcAction.BUY,2,1);
      assert.match(b.npc!.text,/could not save/);
      assert.equal(JSON.stringify(b.inventory.slots),bag);
      assert.equal(readFileSync(join(runtime,'storage/npc-stock.xml'),'utf8'),stock);
    } finally {rmdirSync(blocked);}
    console.log('PASS disk-write failure does not charge, grant items or replace persisted stock');
  }
  a.cmd(`!teleport-player-to=${a.world.ownGuid}:20:20`); await until(()=>!a.npc,'out of range closes session');
  console.log('PASS honest/black-market karma access, integer price rounding and range closure');
  console.log('NPC LIVE TESTS PASSED');
} finally { a!?.ws.close(); b!?.ws.close(); }
