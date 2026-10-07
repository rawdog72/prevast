// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Launched only against run-smoke.mjs's fresh, isolated game server.
// Weapon mods end to end: a created gun carries its default mods, and they
// survive a drop and pickup, a chest and a trade; mods are fitted, swapped and
// removed through FIT_WEAPON_MOD, and non-default mods survive every move too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { unwrapBatch } from '../../apps/client/src/net/batch';
import { dispatchServerMessage } from '../../apps/client/src/net/dispatcher';
import { NetEventBus, type TradeStateEvent } from '../../apps/client/src/net/events';
import * as wire from '../../apps/client/src/net/outbound';
import { EntityType } from '../../apps/client/src/world/entity-types';
import { InventoryStore } from '../../apps/client/src/world/inventory-store';
import { WorldState } from '../../apps/client/src/world/world-state';

const port = process.env.SMOKE_GAME_PORT;
const password = process.env.SMOKE_ADMIN_PASSWORD;
assert(port && password, 'Run through npm run smoke, with its isolated server');
const items = JSON.parse(readFileSync('dist/content/items.json', 'utf8')).entries as Record<
  string,
  { id: number; properties: { lootId: number } }
>;
const iid = (key: string): number => {
  assert(items[key], `Unknown item ${key}`);
  return items[key]!.id;
};
const lootIdOf = (key: string): number => {
  iid(key); // asserts the item exists
  return items[key]!.properties.lootId;
};
const keyOf = (id: number) => Object.keys(items).find((k) => items[k]!.id === id) ?? `#${id}`;
const SLOT = {
  magazine: 0,
  optic: 1,
  muzzle: 2,
  underbarrel: 3,
  side: 4,
  stock: 5,
  handguard: 6,
} as const;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => unknown, label: string, timeout = 8000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
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
  statuses: string[] = [];
  interrupts = 0;
  constructor(readonly name: string) {
    this.inventory.attachBus(this.bus);
    this.world.attachBus(this.bus);
    this.bus.on('tradeState', (s) => (this.trade = s));
    this.bus.on('tradeClosed', (e) => {
      this.trade = null;
      this.closed.push(e.reason);
    });
    this.bus.on('statusMessage', (e) => this.statuses.push(e.text));
    this.bus.on('interruptInteraction', () => this.interrupts++);
  }
  async connect(): Promise<this> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (data) => {
      for (const packet of unwrapBatch(new Uint8Array(data as Buffer)))
        dispatchServerMessage(packet, this.bus);
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.once('error', reject);
      this.ws.once('open', () => {
        this.send(wire.buildLoginMessage({ nickname: this.name, password }));
        resolve();
      });
    });
    await until(
      () => this.world.ownGuid >= 0 && this.inventory.slots.some((s) => s.iid > 0),
      `login ${this.name}`,
    );
    return this;
  }
  send(message: Uint8Array): void {
    this.ws.send(message);
  }
  cmd(text: string): void {
    this.send(wire.buildChatMessage(text));
  }
  total(key: string): number {
    return this.inventory.slots.filter((s) => s.iid === iid(key)).reduce((n, s) => n + s.count, 0);
  }
  item(key: string) {
    const found = this.inventory.slots.find((s) => s.iid === iid(key));
    assert(found, `${key} in ${this.name}'s inventory`);
    return { ...found };
  }
  fitted(uid: number, slot: number): string | null {
    const mod = this.inventory.modsOf(uid).find((m) => m.slot === slot);
    return mod ? keyOf(mod.iid) : null;
  }
  async add(key: string, count = 1): Promise<void> {
    const before = this.total(key);
    this.cmd(`!i=${key}*${count}`);
    await until(() => this.total(key) > before, `give ${key}`);
  }
  async clear(): Promise<void> {
    for (const s of [...this.inventory.slots]) {
      if (s.iid) this.send(wire.buildThrowItemMessage(s.iid, s.uid, s.count, s.ammo));
    }
    await until(() => this.inventory.slots.every((s) => !s.iid), `clear ${this.name}`);
  }
  lootIds(): Set<number> {
    return new Set(this.world.entities.getByType(EntityType.LOOT).map((e) => e.id));
  }
}

// Spawns a chest beside `bot` (!o=wood_chest), opens it and returns once it is
// open. Chests already in view are ignored, so the new one is the one opened.
async function openNewChest(bot: Bot): Promise<void> {
  const chests = () =>
    bot.world.entities
      .all()
      .filter((e) => e.extra >> 7 === iid('wood_chest') && e.pid === 0)
      .map((e) => e.id);
  const oldChests = new Set(chests());
  bot.cmd('!o=wood_chest');
  await until(() => chests().some((id) => !oldChests.has(id)), `spawn a chest for ${bot.name}`);
  const fresh = bot.world.entities
    .all()
    .find((e) => e.id === chests().find((id) => !oldChests.has(id)))!;
  bot.send(wire.buildInteractMessage(fresh.id, fresh.pid));
  await until(() => bot.inventory.isChestOpen, `open the chest of ${bot.name}`);
}

let a!: Bot;
let b!: Bot;
try {
  a = await new Bot('ModsQA_A').connect();
  b = await new Bot('ModsQA_B').connect();
  a.cmd('!invincible');
  b.cmd('!invincible');
  a.cmd(`!teleport-player-to=${a.world.ownGuid}:30:30`);
  a.cmd(`!teleport-player-to=${b.world.ownGuid}:31:30`);
  await delay(250);
  await a.clear();
  await b.clear();

  // 1. A created gun carries its defaults, with an empty magazine.
  await a.add('mp5_tactical');
  let gun = a.item('mp5_tactical');
  await until(() => a.fitted(gun.uid, SLOT.magazine) === 'mp5_mag_30', 'default magazine stated');
  assert.equal(a.fitted(gun.uid, SLOT.handguard), 'handguard_standard');
  assert.equal(gun.ammo, 0);
  console.log('PASS a created gun carries its default mods');

  // 2. Drop and pick up.
  const before = a.lootIds();
  a.send(wire.buildThrowItemMessage(gun.iid, gun.uid, 1, gun.ammo));
  await until(() => a.total('mp5_tactical') === 0, 'drop the gun');
  await until(() => [...a.lootIds()].some((id) => !before.has(id)), 'the gun is on the ground');
  const dropped = [...a.lootIds()].find((id) => !before.has(id))!;
  a.send(wire.buildTakeLootMessage(dropped));
  await until(() => a.total('mp5_tactical') === 1, 'pick the gun up');
  gun = a.item('mp5_tactical');
  await until(() => a.fitted(gun.uid, SLOT.magazine) === 'mp5_mag_30', 'mods after pickup');
  console.log('PASS drop and pickup keep the mods');

  // 3. Store in a chest and take it back.
  await openNewChest(a);
  a.send(wire.buildStoreItemMessage(gun.iid, gun.uid, 1, gun.ammo));
  await until(() => a.inventory.chestItems.some((it) => it.iid === gun.iid), 'store the gun');
  const stored = a.inventory.chestItems.findIndex((it) => it.iid === gun.iid);
  assert.deepEqual(
    a.inventory.chestItems[stored]!.mods.map((m) => keyOf(m.iid)),
    ['mp5_mag_30', 'handguard_standard'],
  );
  a.send(wire.buildTakeItemMessage(stored));
  await until(() => a.total('mp5_tactical') === 1, 'take the gun back');
  gun = a.item('mp5_tactical');
  await until(() => a.fitted(gun.uid, SLOT.magazine) === 'mp5_mag_30', 'mods after the chest');
  a.send(wire.buildCloseContainerMessage());
  a.inventory.closeContainers();
  console.log('PASS a chest keeps the mods');

  // 4. Trade: the other side sees the mods in the offer and receives them.
  await delay(2100); // the invitation budget applies to admins too
  a.send(wire.buildTradeRequestMessage(b.world.ownGuid));
  await until(() => a.trade?.phase === 0 && b.trade?.phase === 1, 'invitation');
  b.send(wire.buildTradeReplyMessage(b.trade!.id, true));
  await until(() => a.trade?.phase === 2 && b.trade?.phase === 2, 'trade open');
  a.send(wire.buildTradeOfferMessage(a.trade!.id, a.trade!.revision, gun.iid, gun.uid, 1));
  // Both sides must hold the offer before either accepts: an accept carries the
  // revision its sender last saw, and a stale one is refused.
  await until(
    () => a.trade?.own.length === 1 && b.trade?.theirs.length === 1,
    'offer reaches both sides',
  );
  assert.deepEqual(
    b.trade!.theirs[0]!.mods.map((m) => keyOf(m.iid)),
    ['mp5_mag_30', 'handguard_standard'],
  );
  a.send(wire.buildTradeAcceptMessage(a.trade!.id, a.trade!.revision));
  b.send(wire.buildTradeAcceptMessage(b.trade!.id, b.trade!.revision));
  await until(() => !a.trade && !b.trade, 'trade completes');
  assert.match(a.closed.at(-1)!, /completed/);
  const received = b.item('mp5_tactical');
  await until(() => b.fitted(received.uid, SLOT.magazine) === 'mp5_mag_30', 'mods after the trade');
  console.log('PASS a trade shows and keeps the mods');

  // 5. Fit, refuse, reload, swap a magazine, remove, and cancel.
  let gunB = b.item('mp5_tactical');
  await b.add('tube_scope');
  await b.add('mp5_mag_40');
  await b.add('9mm_bullet', 60);
  const scope = b.item('tube_scope');
  b.send(wire.buildWeaponModMessage(gunB.uid, SLOT.optic, scope.uid));
  await until(() => b.fitted(gunB.uid, SLOT.optic) === 'tube_scope', 'fit the scope');
  assert.equal(b.total('tube_scope'), 0);
  console.log('PASS fitting a mod takes it from the inventory');

  const mag40 = b.item('mp5_mag_40');
  const refusals = b.statuses.length;
  b.send(wire.buildWeaponModMessage(gunB.uid, SLOT.optic, mag40.uid));
  await until(() => b.statuses.length > refusals, 'refusal for a mod that does not fit');
  assert.match(b.statuses.at(-1)!, /doesn't fit/);
  console.log('PASS a mod for another slot is refused');

  b.send(wire.buildEquipItemMessage(gunB.iid, gunB.uid));
  await delay(1300);
  b.send(wire.buildReloadMessage());
  await until(() => b.item('mp5_tactical').ammo === 30, 'reload fills the 30-round magazine');
  assert.equal(b.total('9mm_bullet'), 30);

  b.send(wire.buildWeaponModMessage(gunB.uid, SLOT.magazine, mag40.uid));
  await until(() => b.fitted(gunB.uid, SLOT.magazine) === 'mp5_mag_40', 'swap in the drum');
  gunB = b.item('mp5_tactical');
  assert.equal(gunB.ammo, 0, 'the gun now fires the empty drum');
  assert.equal(b.item('mp5_mag_30').ammo, 30, 'the old magazine kept its 30 rounds');
  assert.equal(b.total('9mm_bullet'), 30, 'no loose round was created or lost');
  console.log('PASS a magazine swap keeps every round in its magazine');

  const busy = b.statuses.length;
  b.send(wire.buildWeaponModMessage(gunB.uid, SLOT.optic, null));
  b.send(wire.buildWeaponModMessage(gunB.uid, SLOT.optic, null));
  await until(() => b.statuses.length > busy, 'a second change while one runs is refused');
  assert.match(b.statuses.at(-1)!, /Finish what you're doing/);
  await until(
    () => b.fitted(gunB.uid, SLOT.optic) === null && b.total('tube_scope') === 1,
    'remove the scope',
  );
  console.log('PASS removing a mod returns it; one change at a time');

  b.send(wire.buildWeaponModMessage(gunB.uid, SLOT.optic, b.item('tube_scope').uid));
  await delay(300);
  b.send(wire.buildEquipItemMessage(gunB.iid, gunB.uid)); // switching the weapon cancels the change
  await delay(2800);
  assert.equal(b.fitted(gunB.uid, SLOT.optic), null);
  assert.equal(b.total('tube_scope'), 1);
  console.log('PASS switching weapon cancels a change');

  // 5b. Removing a mod needs a free slot: with the inventory full the change is
  // refused up front and the mod stays fitted. The drum is on the gun, unloaded.
  await until(() => b.inventory.selectedIid === 0, 'the cancelled change put the gun away');
  const freeSlots = () => b.inventory.slots.filter((s) => !s.iid).length;
  for (let guard = 0; freeSlots() > 0 && guard < 20; guard++) {
    const left = freeSlots();
    b.cmd('!i=wood*255');
    await until(() => freeSlots() < left, 'fill a slot with wood');
  }
  assert.equal(freeSlots(), 0, 'every inventory slot is taken');
  const crowded = b.statuses.length;
  b.send(wire.buildWeaponModMessage(gunB.uid, SLOT.magazine, null));
  await until(() => b.statuses.length > crowded, 'refusal when there is no room for the mod');
  assert.match(b.statuses.at(-1)!, /No room in your inventory/);
  await delay(300);
  assert.equal(b.fitted(gunB.uid, SLOT.magazine), 'mp5_mag_40', 'the drum is still fitted');
  // Free the space again so the steps below start from the same inventory.
  for (const s of b.inventory.slots.filter((s) => s.iid === iid('wood'))) {
    b.send(wire.buildThrowItemMessage(s.iid, s.uid, s.count, s.ammo));
  }
  await until(() => b.total('wood') === 0, 'drop the wood again');
  console.log('PASS removing a mod with no room is refused and the mod stays fitted');

  // 5c. Dropping the mod being fitted cancels the change at once (the client is
  // told to stop its progress bar) rather than letting it fail when it ends.
  const droppedScope = b.item('tube_scope');
  const groundBefore = b.lootIds();
  // The wood dropped above may still be arriving, so tell the scope by its sprite.
  const scopeOnGround = () =>
    b.world.entities
      .getByType(EntityType.LOOT)
      .filter((e) => e.extra === lootIdOf('tube_scope') && !groundBefore.has(e.id))
      .map((e) => e.id);
  const quiet = b.statuses.length;
  const interrupted = b.interrupts;
  b.send(wire.buildWeaponModMessage(gunB.uid, SLOT.optic, droppedScope.uid)); // 2.5 s
  await delay(300);
  b.send(wire.buildThrowItemMessage(droppedScope.iid, droppedScope.uid, 1, droppedScope.ammo));
  await until(() => b.total('tube_scope') === 0, 'drop the scope mid-change');
  await until(() => b.interrupts > interrupted, 'the drop cancels the change', 1200);
  await until(() => scopeOnGround().length > 0, 'the scope is on the ground');
  await delay(2600); // past installMs: a live change would have ended by now
  assert.equal(b.fitted(gunB.uid, SLOT.optic), null, 'the dropped scope was not fitted');
  assert.equal(b.statuses.length, quiet, 'cancelled, not refused when the time ran out');
  b.send(wire.buildTakeLootMessage(scopeOnGround()[0]!));
  await until(() => b.total('tube_scope') === 1, 'pick the scope up again');
  console.log('PASS dropping the mod mid-change cancels the change');

  // 6. Non-default mods survive every move. The gun holds the 40-round drum
  // (not its default) and, fitted now, the scope (not a default either); the
  // drum is loaded so the rounds are worth guarding. A path that re-applied
  // the defaults on the way through would swap both back and fail here.
  await until(() => b.inventory.selectedIid === 0, 'the cancelled change put the gun away');
  b.send(wire.buildWeaponModMessage(gunB.uid, SLOT.optic, b.item('tube_scope').uid));
  await until(() => b.fitted(gunB.uid, SLOT.optic) === 'tube_scope', 'fit the scope again');
  b.send(wire.buildEquipItemMessage(gunB.iid, gunB.uid));
  await until(() => b.inventory.selectedIid === gunB.iid, 'draw the gun');
  b.send(wire.buildReloadMessage());
  await until(() => b.item('mp5_tactical').ammo === 30, 'load the drum');
  b.send(wire.buildEquipItemMessage(gunB.iid, gunB.uid)); // put away: not held during the moves below
  await until(() => b.inventory.selectedIid === 0, 'put the gun away');
  const loadedRounds = 30;

  // The gun as `bot` holds it, once INVENTORY_SLOT and ITEM_MODS have landed,
  // with both non-default mods fitted and the rounds untouched.
  const holdsNonDefault = async (bot: Bot, where: string) => {
    await until(() => bot.total('mp5_tactical') === 1, `${where}: the gun is back`);
    await delay(200); // INVENTORY_SLOT is followed by ITEM_MODS
    const held = bot.item('mp5_tactical');
    assert.equal(bot.fitted(held.uid, SLOT.optic), 'tube_scope', `${where}: optic`);
    assert.equal(bot.fitted(held.uid, SLOT.magazine), 'mp5_mag_40', `${where}: magazine`);
    assert.equal(held.ammo, loadedRounds, `${where}: the rounds in the drum`);
    return held;
  };
  gunB = await holdsNonDefault(b, 'before the moves');

  // 6a. Drop and pick up.
  const beforeDrop = b.lootIds();
  b.send(wire.buildThrowItemMessage(gunB.iid, gunB.uid, 1, gunB.ammo));
  await until(() => b.total('mp5_tactical') === 0, 'drop the modded gun');
  await until(
    () => [...b.lootIds()].some((id) => !beforeDrop.has(id)),
    'the modded gun is on the ground',
  );
  b.send(wire.buildTakeLootMessage([...b.lootIds()].find((id) => !beforeDrop.has(id))!));
  gunB = await holdsNonDefault(b, 'after drop and pickup');
  console.log('PASS non-default mods survive drop and pickup');

  // 6b. Store in a chest and take it back.
  await openNewChest(b);
  b.send(wire.buildStoreItemMessage(gunB.iid, gunB.uid, 1, gunB.ammo));
  await until(
    () => b.inventory.chestItems.some((it) => it.iid === gunB.iid),
    'store the modded gun',
  );
  const chestGun = b.inventory.chestItems.find((it) => it.iid === gunB.iid)!;
  assert.deepEqual(
    chestGun.mods.map((m) => keyOf(m.iid)).sort(),
    ['handguard_standard', 'mp5_mag_40', 'tube_scope'],
    'the chest lists every fitted mod',
  );
  assert.equal(chestGun.ammo, loadedRounds, 'the chest keeps the rounds');
  b.send(wire.buildTakeItemMessage(b.inventory.chestItems.indexOf(chestGun)));
  gunB = await holdsNonDefault(b, 'after the chest');
  b.send(wire.buildCloseContainerMessage());
  b.inventory.closeContainers();
  console.log('PASS non-default mods survive a chest');

  // 6c. Trade it from b to a.
  await delay(2100); // the invitation budget applies to admins too
  b.send(wire.buildTradeRequestMessage(a.world.ownGuid));
  await until(() => b.trade?.phase === 0 && a.trade?.phase === 1, 'second invitation');
  a.send(wire.buildTradeReplyMessage(a.trade!.id, true));
  await until(() => a.trade?.phase === 2 && b.trade?.phase === 2, 'second trade open');
  b.send(wire.buildTradeOfferMessage(b.trade!.id, b.trade!.revision, gunB.iid, gunB.uid, 1));
  await until(
    () => b.trade?.own.length === 1 && a.trade?.theirs.length === 1,
    'offer reaches both sides',
  );
  assert.deepEqual(
    a.trade!.theirs[0]!.mods.map((m) => keyOf(m.iid)).sort(),
    ['handguard_standard', 'mp5_mag_40', 'tube_scope'],
    'the offer lists every fitted mod',
  );
  assert.equal(a.trade!.theirs[0]!.ammo, loadedRounds, 'the offer carries the rounds');
  a.send(wire.buildTradeAcceptMessage(a.trade!.id, a.trade!.revision));
  b.send(wire.buildTradeAcceptMessage(b.trade!.id, b.trade!.revision));
  await until(() => !a.trade && !b.trade, 'second trade completes');
  assert.match(b.closed.at(-1)!, /completed/);
  assert.equal(b.total('mp5_tactical'), 0);
  await holdsNonDefault(a, 'after the second trade');
  console.log('PASS non-default mods survive a trade');

  // 7. Offering the gun in a trade, mid-change, cancels the change: it neither
  // completes nor fails later with "Take it out of the trade first."
  const gunA = a.item('mp5_tactical');
  await delay(2100); // the invitation budget applies to admins too
  a.send(wire.buildTradeRequestMessage(b.world.ownGuid));
  await until(() => a.trade?.phase === 0 && b.trade?.phase === 1, 'third invitation');
  b.send(wire.buildTradeReplyMessage(b.trade!.id, true));
  await until(() => a.trade?.phase === 2 && b.trade?.phase === 2, 'third trade open');
  const aQuiet = a.statuses.length;
  const aInterrupted = a.interrupts;
  a.send(wire.buildWeaponModMessage(gunA.uid, SLOT.optic, null)); // take the scope off: 2.5 s
  await delay(300);
  a.send(wire.buildTradeOfferMessage(a.trade!.id, a.trade!.revision, gunA.iid, gunA.uid, 1));
  await until(() => a.interrupts > aInterrupted, 'the offer cancels the change', 1200);
  await until(() => a.trade?.own.length === 1, 'the offer lands');
  await delay(2600); // past installMs
  assert.equal(a.fitted(gunA.uid, SLOT.optic), 'tube_scope', 'the scope stayed on');
  assert.equal(a.statuses.length, aQuiet, 'cancelled, not refused when the time ran out');
  a.send(wire.buildTradeCancelMessage(a.trade!.id));
  await until(() => !a.trade && !b.trade, 'third trade cancelled');
  console.log('PASS offering the gun mid-change cancels the change');
} finally {
  a?.ws?.close();
  b?.ws?.close();
}
