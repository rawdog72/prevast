// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Launched only against run-smoke.mjs's fresh, isolated game server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { unwrapBatch } from '../../apps/client/src/net/batch';
import { dispatchServerMessage } from '../../apps/client/src/net/dispatcher';
import { NetEventBus } from '../../apps/client/src/net/events';
import * as wire from '../../apps/client/src/net/outbound';
import { InventoryStore } from '../../apps/client/src/world/inventory-store';
import { WorldState } from '../../apps/client/src/world/world-state';

const port = process.env.SMOKE_GAME_PORT;
const password = process.env.SMOKE_ADMIN_PASSWORD;
assert(port && password, 'Run through npm run smoke, with its isolated server');
const items = JSON.parse(readFileSync('dist/content/items.json', 'utf8')).entries;
const woodIid: number = items.wood.id;
const campfireIid: number = items.campfire.id;
const objects = JSON.parse(readFileSync('dist/content/objects.json', 'utf8')).entries;
const burnMs: number = objects.campfire.fuel.burnDurationPerUnitMs;
const bus = new NetEventBus();
const inventory = new InventoryStore();
const world = new WorldState();
inventory.attachBus(bus);
world.attachBus(bus);
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const errors: string[] = [];
bus.on('disconnectReason', (e) => errors.push(`Disconnected: ${e.reason}`));
bus.on('alert', (e) => errors.push(e.text));
ws.on('error', (e) => errors.push(e.message));
ws.on('message', (data) => {
  for (const packet of unwrapBatch(new Uint8Array(data as Buffer)))
    dispatchServerMessage(packet, bus);
});
const send = (message: Uint8Array) => ws.send(message);
const command = (text: string) => send(wire.buildChatMessage(text));
const wood = () => inventory.getItemCount(woodIid);
async function until(check: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    assert.equal(errors.length, 0, errors.join('; '));
    assert(Date.now() < deadline, `Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

try {
  await until(() => ws.readyState === WebSocket.OPEN, 'connect');
  // Uses the current versioned encoder, including the updated fuel protocol.
  send(wire.buildLoginMessage({ nickname: 'FuelSmoke', password }));
  await until(() => world.ownGuid >= 0 && inventory.slots.some((s) => s.iid > 0), 'login');
  command('!invincible');
  for (const item of [...inventory.slots].filter((s) => s.iid > 0))
    send(wire.buildThrowItemMessage(item.iid, item.uid, item.count, item.ammo));
  await until(() => inventory.slots.every((s) => s.iid === 0), 'empty test inventory');
  const beforeSpawn = new Set(
    world.entities
      .all()
      .filter((e) => e.extra >> 7 === campfireIid && e.pid === 0)
      .map((e) => e.id),
  );
  command('!o=campfire');
  const station = () =>
    world.entities
      .all()
      .find((e) => !beforeSpawn.has(e.id) && e.extra >> 7 === campfireIid && e.pid === 0);
  await until(() => !!station(), 'spawn campfire');
  const fire = station()!;
  let lastOpenedAt = 0;
  const open = async () => {
    // Station interactions deliberately have an authored spam cooldown.
    const delay = (objects.campfire.interaction.interactionDelayMs ?? 0) + 100;
    const waitMs = lastOpenedAt + delay - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    send(wire.buildInteractMessage(fire.id, fire.pid));
    await until(() => inventory.isStationOpen && inventory.stationArea === 1, 'open campfire');
    lastOpenedAt = Date.now();
  };
  await open();
  assert.equal(inventory.fuel, 0);
  assert.equal(inventory.fuelMs, 0);
  command('!i=wood*3');
  await until(() => wood() === 3, 'give three wood');
  send(wire.buildAddFuelMessage(12));
  await until(() => inventory.fuel === 3 && wood() === 0, 'cap by carried fuel');
  assert(inventory.fuelMs > 2 * burnMs && inventory.fuelMs <= 3 * burnMs);
  send(wire.buildAddFuelMessage(12)); // Empty bag cannot create fuel.
  command('!i=wood*300');
  await until(() => wood() === 300, 'give fuel across stacks');
  assert.equal(inventory.fuel, 3);
  assert(inventory.slots.filter((s) => s.iid === woodIid).length >= 2);
  send(wire.buildAddFuelMessage(7));
  await until(() => inventory.fuel === 10 && wood() === 293, 'add chosen seven, not XML fifteen');

  // Malformed frames and reserved/zero quantities must consume nothing.
  for (const bytes of [[24], [24, 1, 9], [24, 0], [24, 255]]) send(new Uint8Array(bytes));
  send(wire.buildAddFuelMessage(3)); // A valid following action is the processing barrier.
  await until(() => inventory.fuel >= 13, 'valid addition after rejected packets');
  assert.equal(inventory.fuel, 13);
  assert.equal(wood(), 290);

  const beforeCloseMs = inventory.fuelMs;
  send(wire.buildCloseContainerMessage());
  inventory.closeContainers();
  await new Promise((resolve) => setTimeout(resolve, 2200));
  send(wire.buildAddFuelMessage(4)); // Closed station cannot take fuel.
  await open();
  assert.equal(inventory.fuel, 13);
  assert(inventory.fuelMs < beforeCloseMs - 1500, 'reopening includes fuel burned while closed');
  assert(inventory.fuelMs > beforeCloseMs - 5000, 'reopening preserves remaining burn time');
  assert(inventory.fuelMs < inventory.fuel * burnMs - 1500, 'partly burned unit is not rounded up');
  assert.equal(wood(), 290);
  send(wire.buildAddFuelMessage(254));
  await until(() => inventory.fuel === 254 && wood() === 49, 'cap by free capacity across stacks');
  send(wire.buildAddFuelMessage(8)); // Already full: no additional fuel consumed.
  send(wire.buildCloseContainerMessage());
  inventory.closeContainers();
  await open();
  assert.equal(inventory.fuel, 254);
  assert.equal(wood(), 49);
  await until(() => inventory.fuel < 254, 'fuel unit boundary update', burnMs + 5000);
  assert(inventory.fuelMs <= inventory.fuel * burnMs);
  assert(
    inventory.fuelMs > inventory.fuel * burnMs - 1000,
    'unit update includes actual remaining milliseconds',
  );
  console.log(
    'PASS fuel: exact time on reopen/refill/unit burn, chosen amounts, inventory/capacity limits, multiple stacks, empty/full/closed states and malformed packets',
  );
} finally {
  ws.close();
}
