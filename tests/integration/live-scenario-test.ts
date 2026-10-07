// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Live checks for a scenario run: tests/integration/run-scenario.mjs boots a
// server on tests/fixtures/scenarios/boot/population-live.prevast.json and runs
// this against it. An ordinary (non-admin) player, because admins are immune to
// gauges.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { unwrapBatch } from '../../apps/client/src/net/batch';
import { dispatchServerMessage } from '../../apps/client/src/net/dispatcher';
import { NetEventBus, type GaugeRatesEvent, type GaugeStateEvent } from '../../apps/client/src/net/events';
import { GaugeDirection } from '../../apps/client/src/net/opcodes';
import * as wire from '../../apps/client/src/net/outbound';
import { InventoryStore } from '../../apps/client/src/world/inventory-store';
import { WorldState } from '../../apps/client/src/world/world-state';

const url = process.env.SCENARIO_TEST_URL || 'ws://127.0.0.1:8272';
const items = JSON.parse(readFileSync(new URL('../fixtures/content/items.json', import.meta.url), 'utf8')).entries;
const iid = (key: string): number => {
  assert(items[key], `Unknown item ${key}`);
  return items[key].id as number;
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => unknown, label: string, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timeout: ${label}`);
    await delay(30);
  }
}

const AGENT = 13;
const NPC = 14;

class Bot {
  ws!: WebSocket;
  bus = new NetEventBus();
  inventory = new InventoryStore();
  world = new WorldState();
  rates: GaugeRatesEvent | null = null;
  state: GaugeStateEvent | null = null;
  constructor(readonly name: string) {
    this.inventory.attachBus(this.bus);
    this.world.attachBus(this.bus);
    this.bus.on('gaugeRates', (r) => (this.rates = r));
    this.bus.on('gaugeState', (s) => (this.state = s));
  }
  async connect() {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      for (const packet of unwrapBatch(new Uint8Array(data as Buffer))) dispatchServerMessage(packet, this.bus);
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.once('error', reject);
      this.ws.once('open', () => {
        this.ws.send(wire.buildLoginMessage({ nickname: this.name }));
        resolve();
      });
    });
    await until(() => this.world.getLocalEntity() && this.inventory.slots.some((s) => s.iid > 0), 'login ' + this.name);
    return this;
  }
  total(key: string) {
    return this.inventory.slots.filter((i) => i.iid === iid(key)).reduce((n, i) => n + i.count, 0);
  }
  live(type: number) {
    return this.world.entities.getByType(type).filter((e) => !e.removed);
  }
}

const bot = await new Bot('SCN_QA').connect();
try {
  const me = bot.world.getLocalEntity()!;
  assert(Math.hypot(me.x - 1050, me.y - 1050) <= 150, `spawned at the authored point, got (${me.x}, ${me.y})`);
  assert.equal(bot.total('hatchet'), 1);
  assert.equal(bot.total('bandage'), 3);
  const others = bot.inventory.slots.filter((s) => s.iid > 0 && s.iid !== iid('hatchet') && s.iid !== iid('bandage'));
  assert.deepEqual(others, [], 'the loadout replaces the starting kit');
  console.log('PASS authored spawn point and loadout instead of the kit');

  // +90 radiation a minute = 15 wire units, and natural decay pauses inside.
  await until(() => bot.rates?.radiation.dec === 15, 'radiation rate from the region');
  await until(() => bot.state?.radiation === GaugeDirection.FALL, 'radiation accumulating (the client bar falls)');
  console.log('PASS regional radiation rate folded into the gauge rates');

  await until(() => bot.live(NPC).some((n) => n.extra === 1), 'Mara is standing');
  const mara = bot.live(NPC).find((n) => n.extra === 1)!;
  assert(Math.hypot(mara.x - 1450, mara.y - 1050) < 5, `Mara at her placement, got (${mara.x}, ${mara.y})`);
  assert.equal(mara.rotation, 128);
  console.log('PASS NPC placement and facing');

  // One placed creature plus a spawner holding three.
  await until(() => bot.live(AGENT).length === 4, 'placed creature and a full spawner', 10000);
  let most = 0;
  for (let i = 0; i < 30; i++) {
    most = Math.max(most, bot.live(AGENT).length);
    await delay(100);
  }
  assert(most <= 4, `population stays within maxAlive, saw ${most}`);
  console.log('PASS placed creature and spawner population cap');
} finally {
  bot.ws.close();
}
