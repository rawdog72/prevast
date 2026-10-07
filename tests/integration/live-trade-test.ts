// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Run against an isolated server: npx tsx tools/live-trade-test.ts (default :7272).
// Creates admin test characters and modifies only their inventory/position.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { unwrapBatch } from '../../apps/client/src/net/batch';
import { dispatchServerMessage } from '../../apps/client/src/net/dispatcher';
import { NetEventBus, type TradeStateEvent, type TradeItem } from '../../apps/client/src/net/events';
import * as wire from '../../apps/client/src/net/outbound';
import { InventoryStore } from '../../apps/client/src/world/inventory-store';
import { WorldState } from '../../apps/client/src/world/world-state';

const url = process.env.TRADE_TEST_URL || 'ws://127.0.0.1:7272';
const password = process.env.TRADE_TEST_PASSWORD || 'prevast';
const items = JSON.parse(
  readFileSync(new URL('../fixtures/content/items.json', import.meta.url), 'utf8'),
).entries;
const iid = (key: string): number => {
  assert(items[key], `Unknown item ${key}`);
  return items[key].id;
};
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
  async offer(item: Pick<TradeItem, 'uid' | 'iid' | 'count'>, count = item.count) {
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
let a!: Bot, b!: Bot;
async function nearby() {
  a.cmd(`!teleport-player-to=${a.world.ownGuid}:30:30`);
  a.cmd(`!teleport-player-to=${b.world.ownGuid}:31:30`);
  await delay(250);
}
async function invite(open = true) {
  await delay(2100); // Invitation budget is deliberately enforced for admins too.
  a.send(wire.buildTradeRequestMessage(b.world.ownGuid));
  await until(() => a.trade?.phase === 0 && b.trade?.phase === 1, 'invitation');
  if (open) {
    b.send(wire.buildTradeReplyMessage(b.trade!.id, true));
    await until(() => a.trade?.phase === 2 && b.trade?.phase === 2, 'open');
  }
}
async function completed() {
  await until(() => !a.trade && !b.trade, 'completion');
  assert.match(a.closed.at(-1)!, /completed/);
}
try {
  a = await new Bot('TradeQA_A').connect();
  b = await new Bot('TradeQA_B').connect();
  await nearby();
  if (process.env.TRADE_TEST_CAPACITY === '1') {
    // This variant requires entityIdCapLoot=2 and lootDespawnSeconds=0 on an isolated server.
    await a.add('hatchet', 16);
    await b.add('wood', 40);
    // The admin give command deliberately leaves half the loot pool free.
    // A normal drop consumes the last id without freeing a slot for the recipient.
    const stone = b.item('stone');
    b.send(wire.buildThrowItemMessage(stone.iid, stone.uid, stone.count, stone.ammo));
    await until(() => a.world.entities.getByType(1).length >= 2, 'exhaust tiny ground loot pool');
    await invite();
    await b.offer(b.item('wood'));
    const beforeA = JSON.stringify(a.inventory.slots),
      beforeB = JSON.stringify(b.inventory.slots);
    a.accept();
    b.accept();
    await until(() => !a.trade && !b.trade, 'overflow reservation failure');
    assert.match(a.closed.at(-1)!, /no room for overflow loot/);
    assert.equal(JSON.stringify(a.inventory.slots), beforeA);
    assert.equal(JSON.stringify(b.inventory.slots), beforeB);
    console.log('PASS exhausted loot pool leaves both inventories exactly unchanged');
  } else {
    await invite(false);
    b.send(wire.buildTradeReplyMessage(b.trade!.id, false));
    await until(() => !a.trade && !b.trade, 'decline');
    assert.match(a.closed.at(-1)!, /declined/);
    console.log('PASS invitation and decline');
    await a.clear();
    await b.clear();
    await a.add('wood', 20);
    await b.add('stone', 30);
    await invite();
    await a.offer(a.item('wood'), 5);
    await b.offer(b.item('stone'), 7);
    assert.equal(a.total('wood'), 20);
    assert.equal(b.total('stone'), 30);
    const stale = a.trade!.revision;
    a.accept();
    await until(() => b.trade!.accepted === 2, 'first acceptance');
    await b.offer(b.item('stone'), 6);
    assert.equal(b.trade!.accepted, 0);
    a.accept(stale);
    b.accept();
    await delay(200);
    assert(a.trade && b.trade);
    assert.equal(a.total('wood'), 20);
    a.accept();
    await completed();
    assert.equal(a.total('wood'), 15);
    assert.equal(a.total('stone'), 6);
    assert.equal(b.total('wood'), 5);
    assert.equal(b.total('stone'), 24);
    // Delayed acceptance after completion is a no-op.
    a.send(wire.buildTradeAcceptMessage(1, stale));
    await delay(80);
    assert.equal(a.total('wood'), 15);
    console.log('PASS partial stacks, both accept, revision race and replay protection');
    await invite();
    await a.offer(a.item('wood'), 1);
    const snapshot = JSON.stringify(a.inventory.slots),
      s = a.trade!;
    a.send(wire.buildTradeOfferMessage(s.id, s.revision, iid('stone'), a.item('wood').uid, 255));
    a.send(new Uint8Array([...wire.buildTradeAcceptMessage(s.id, s.revision), 0]));
    await delay(120);
    assert.equal(JSON.stringify(a.inventory.slots), snapshot);
    assert.equal(a.trade!.accepted, 0);
    b.send(wire.buildTradeCancelMessage(s.id));
    await until(() => !a.trade && !b.trade, 'cancel');
    console.log('PASS forged item identity, excessive quantity and malformed packet');
    await invite();
    await a.offer(a.item('wood'), 1);
    a.accept();
    const wood = a.item('wood');
    a.send(wire.buildThrowItemMessage(wood.iid, wood.uid, 1, wood.ammo));
    await until(() => !a.trade && !b.trade, 'offered item mutation');
    assert.match(b.closed.at(-1)!, /item changed/);
    console.log('PASS changing an offered inventory stack cancels both sides');
    await invite();
    a.cmd(`!teleport-player-to=${b.world.ownGuid}:34:30`);
    await until(() => !a.trade && !b.trade, 'range cancellation');
    assert.match(a.closed.at(-1)!, /2 tiles/);
    await delay(2100);
    a.send(wire.buildTradeRequestMessage(b.world.ownGuid));
    await delay(150);
    assert.equal(a.trade, null);
    assert.match(a.alerts.at(-1)!, /within 2 tiles/);
    await nearby();
    console.log('PASS moving away cancels and remote invitations are rejected');
    await a.clear();
    await b.clear();
    await a.add('hatchet', 8);
    await b.add('stone', 30);
    await b.add('wood', 40);
    await invite();
    await a.offer(a.item('hatchet'));
    await b.offer(b.item('stone'));
    await b.offer(b.item('wood'));
    const oldLoot = new Set(a.world.entities.getByType(1).map((e) => e.id));
    a.accept();
    b.accept();
    await completed();
    assert.equal(a.total('hatchet'), 7);
    assert.equal(a.total('stone'), 30);
    assert.equal(b.total('hatchet'), 1);
    assert.equal(b.total('wood'), 0);
    await until(
      () => a.world.entities.getByType(1).some((e) => !oldLoot.has(e.id)),
      'overflow loot',
    );
    const overflow = a.world.entities.getByType(1).find((e) => !oldLoot.has(e.id))!;
    const pos = a.world.getLocalEntity()!;
    assert(Math.abs(overflow.nx - pos.nx) < 100 && Math.abs(overflow.ny - pos.ny) < 100);
    // Free one slot and collect the overflow to verify its actual quantity, not just appearance.
    const hatchet = a.item('hatchet');
    a.send(wire.buildThrowItemMessage(hatchet.iid, hatchet.uid, 1, hatchet.ammo));
    await until(() => a.total('hatchet') === 6, 'free pickup slot');
    await delay(800);
    a.send(wire.buildTakeLootMessage(overflow.id));
    await until(() => a.total('wood') === 40, 'pickup overflow quantity');
    console.log('PASS full inventories free outgoing slots and preserve overflow as nearby loot');
    await a.clear();
    await b.clear();
    await a.add('pistol', 1);
    await a.add('9mm_bullet', 20);
    const pistol = a.item('pistol');
    a.send(wire.buildEquipItemMessage(pistol.iid, pistol.uid, pistol.count, pistol.ammo));
    await delay(1300);
    a.send(wire.buildReloadMessage());
    await until(() => a.item('pistol').ammo > 0, 'load pistol');
    const rounds = a.item('pistol').ammo;
    await invite();
    await a.add('raw_steak', 5);
    await a.offer(a.item('pistol'));
    await a.offer(a.item('raw_steak'), 3);
    const freshness = a.item('raw_steak').ammo;
    a.accept();
    b.accept();
    await completed();
    assert.equal(b.item('pistol').ammo, rounds);
    assert.equal(a.total('raw_steak'), 2);
    assert.equal(b.total('raw_steak'), 3);
    assert(b.item('raw_steak').ammo <= freshness);
    console.log('PASS loaded ammo, perishable quantities and one-sided gifts');
    await invite(false);
    await until(() => !a.trade && !b.trade, 'request timeout', 33000);
    assert.match(a.closed.at(-1)!, /expired/);
    console.log('PASS invitation expires on both sides');
    await invite();
    const token = b.token;
    assert(token);
    b.ws.close();
    await until(() => !a.trade, 'disconnect cancel');
    assert.match(a.closed.at(-1)!, /disconnected/);
    b = await new Bot('TradeQA_B').connect(token);
    await nearby();
    await invite();
    const replacement = await new Bot('TradeQA_B').connect(token);
    await until(() => !a.trade, 'session takeover cancel');
    assert.match(a.closed.at(-1)!, /session changed/);
    replacement.ws.close();
    console.log('PASS disconnect and session takeover cancellation');
  }
  console.log('All live trade checks passed.');
} finally {
  a?.ws.close();
  b?.ws.close();
}
