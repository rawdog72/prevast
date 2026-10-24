// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Launched only against run-smoke.mjs's fresh, isolated game server.
// Upgrading a building in place, end to end: the window is held like a
// chest's (one player at a time), the target tier must be unlocked and its
// recipe carried, anyone can stop a running upgrade (the materials drop at
// their feet), it runs on without anyone watching, damage carries over, the
// watcher's window moves to the new building, the last tier closes it, and a
// building destroyed mid-upgrade drops what was paid in.
import assert from 'node:assert/strict';
import * as wire from '../../apps/client/src/net/outbound';
import { EntityType, type WorldEntity } from '../../apps/client/src/world/entity-types';
import { Bot, delay, iid, password, port, until } from './live-bot';

assert(port && password, 'Run through npm run smoke, with its isolated server');

const TILE = 100;

/** The live building of `key` standing on tile (col, row), as `bot` sees it. */
function buildingAt(bot: Bot, key: string, col: number, row: number): WorldEntity | undefined {
  return bot.world.entities
    .all()
    .find(
      (e) =>
        !e.removed &&
        e.type !== EntityType.LOOT &&
        e.extra >> 7 === iid(key) &&
        Math.floor(e.x / TILE) === col &&
        Math.floor(e.y / TILE) === row,
    );
}

/** Builds `key` on the first of `tiles` (col, row) that is free, from where the bot stands. */
async function build(bot: Bot, key: string, tiles: [number, number][]): Promise<[number, number]> {
  await bot.add(key, 1);
  const piece = bot.item(key);
  bot.send(wire.buildEquipItemMessage(piece.iid, piece.uid, piece.count, piece.ammo));
  await until(() => bot.inventory.blueprintIid === iid(key), `hold ${key}`);
  for (const [col, row] of tiles) {
    const there = buildingAt(bot, key, col, row);
    if (there) continue; // one of ours already stands there
    bot.send(wire.buildPlaceObjectMessage(0, row, col));
    try {
      await until(() => !!buildingAt(bot, key, col, row), `place ${key}`, 1500);
      return [col, row];
    } catch {
      await delay(400); // the placement cooldown
    }
  }
  throw new Error(`Nowhere to place ${key}`);
}

/**
 * A 3x3 block of tiles with nothing on it (no building, resource, loot or
 * creature), its middle, from what `bot` can see; starting at (cx, cy) and
 * walking outward.
 */
function clearSpot(
  bot: Bot,
  cx: number,
  cy: number,
  avoid: [number, number][] = [],
): [number, number] {
  const taken = new Set<string>();
  for (const e of bot.world.entities.all()) {
    if (e.removed || e.pid === bot.world.ownGuid) continue;
    taken.add(`${Math.floor(e.x / TILE)},${Math.floor(e.y / TILE)}`);
  }
  for (const [x, y] of avoid) taken.add(`${x},${y}`);
  for (let r = 0; r < 6; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        let free = true;
        for (let oy = -1; oy <= 1 && free; oy++)
          for (let ox = -1; ox <= 1 && free; ox++)
            if (taken.has(`${x + ox},${y + oy}`)) free = false;
        if (free) return [x, y];
      }
  throw new Error(`No clear 3x3 spot near ${cx},${cy}`);
}

/** The building's health, from Look's "It has 2400/3000 health." */
async function health(bot: Bot, e: WorldEntity): Promise<[number, number]> {
  const before = bot.statuses.length;
  bot.send(wire.buildLookAtMessage(e.id, e.pid));
  await until(() => bot.statuses.slice(before).some((s) => / has \d+\/\d+ health/.test(s)), 'look');
  const line = bot.statuses.slice(before).find((s) => / has \d+\/\d+ health/.test(s))!;
  const [, hp, max] = / has (\d+)\/(\d+) health/.exec(line)!;
  return [Number(hp), Number(max)];
}

async function status(bot: Bot, text: string, send: () => void): Promise<void> {
  const before = bot.statuses.length;
  send();
  await until(() => bot.statuses.slice(before).includes(text), `status "${text}"`);
}

/** Every pickup within `range` of the bot, taken. */
async function takeLootAround(bot: Bot, range = 250): Promise<void> {
  const me = bot.world.getLocalEntity()!;
  await delay(900); // loot glides to rest before it can be taken
  for (const e of bot.world.entities.getByType(EntityType.LOOT)) {
    if (!e.removed && Math.hypot(e.x - me.x, e.y - me.y) < range)
      bot.send(wire.buildTakeLootMessage(e.id));
  }
  await delay(600);
}

function emptyBag(bot: Bot): void {
  for (const item of bot.inventory.slots.filter((s) => s.iid > 0))
    bot.send(wire.buildThrowItemMessage(item.iid, item.uid, item.count, item.ammo));
}

let a: Bot | undefined;
let b: Bot | undefined;
try {
  a = await new Bot('UpgradeA').connect();
  b = await new Bot('UpgradeB').connect();
  for (const bot of [a, b]) {
    bot.cmd('!invincible');
    emptyBag(bot);
  }
  await until(() => a!.inventory.slots.every((s) => s.iid === 0), 'empty A');
  await until(() => b!.inventory.slots.every((s) => s.iid === 0), 'empty B');

  // Somewhere open near the map's middle.
  a.cmd(`!t=${Math.floor(a.world.tilesX / 2)}:${Math.floor(a.world.tilesY / 2)}`);
  await delay(800);
  const [tx, ty] = clearSpot(a, Math.floor(a.world.tilesX / 2), Math.floor(a.world.tilesY / 2));
  a.cmd(`!t=${tx}:${ty}`);
  await delay(500);
  const [wx, wy] = await build(a, 'wood_wall', [
    [tx + 1, ty],
    [tx, ty + 1],
    [tx - 1, ty],
    [tx, ty - 1],
  ]);
  // B stands on the far side of it.
  b.cmd(`!t=${wx + (wx - tx)}:${wy + (wy - ty)}`);
  await delay(500);
  let wall = buildingAt(a, 'wood_wall', wx, wy)!;

  // 1. A dynamite beside it: the wall is damaged before it is upgraded.
  const free = [
    [wx + (wy - ty), wy + (wx - tx)],
    [wx - (wy - ty), wy - (wx - tx)],
  ] as [number, number][];
  await build(a, 'dynamite', free);
  await delay(6000); // its fuse
  const [woodHp, woodMax] = await health(a, wall);
  assert.equal(woodMax, 3000);
  assert(woodHp < woodMax, `the wall took damage (${woodHp}/${woodMax})`);
  console.log(`PASS the wooden wall is damaged to ${woodHp}/${woodMax}`);

  // 2. The window: only one player at a time, and anyone sees the busy marker.
  a.send(wire.buildOpenUpgradeMessage(wall.id, wall.pid));
  await until(() => a!.inventory.upgrade?.entityId === wall.id, 'A opens the upgrade window');
  assert.equal(a.inventory.upgrade!.targetIid, iid('stone_wall'));
  assert.equal(a.inventory.upgrade!.running, false);
  await until(() => (buildingAt(b!, 'wood_wall', wx, wy)!.state & 4096) !== 0, 'busy bit to B');
  await status(b, 'Someone else is using it.', () =>
    b!.send(wire.buildOpenUpgradeMessage(wall.id, wall.pid)),
  );
  assert.equal(b.inventory.upgrade, null);
  console.log('PASS one upgrade window at a time, with the busy bit set for everyone');

  // 3. The target tier must be unlocked, and its recipe carried.
  await status(a, 'Unlock the Stone Wall first.', () => a!.send(wire.buildStartUpgradeMessage()));
  a.cmd('!addlevel=10');
  await until(() => a!.inventory.level >= 10, 'levels');
  for (const key of ['stone_wall', 'steel_wall']) {
    a.send(wire.buildUnlockSkillMessage(iid(key)));
    await until(() => a!.inventory.unlockedSkills.has(iid(key)), `unlock ${key}`);
  }
  await status(a, 'Missing materials.', () => a!.send(wire.buildStartUpgradeMessage()));
  await a.add('stone', 25);
  a.send(wire.buildStartUpgradeMessage());
  await until(() => a!.inventory.upgrade?.running === true, 'the upgrade starts');
  assert.equal(a.total('stone'), 5, 'the stone wall recipe (20 stone) is taken at the start');
  assert.equal(a.inventory.upgrade!.durationMs, 30000);
  console.log('PASS it needs the tier unlocked and takes the recipe when it starts');

  // 4. Anyone may stop it: B, who does not own the wall, takes the stone.
  a.send(wire.buildCloseContainerMessage());
  a.inventory.closeContainers();
  await until(() => (buildingAt(b!, 'wood_wall', wx, wy)!.state & 4096) === 0, 'window released');
  b.send(wire.buildOpenUpgradeMessage(wall.id, wall.pid));
  await until(() => b!.inventory.upgrade?.running === true, 'B sees it running');
  assert(b.inventory.upgrade!.remainingMs < 30000);
  b.send(wire.buildCancelUpgradeMessage());
  await until(() => b!.inventory.upgrade?.running === false, 'B stops it');
  await takeLootAround(b);
  assert.equal(b.total('stone'), 20, 'the stopped upgrade drops its stone at B');
  b.send(wire.buildCloseContainerMessage());
  b.inventory.closeContainers();
  console.log('PASS another player stops it and walks off with the materials');

  // 5. It finishes on its own clock; the watcher's window moves to the new
  //    building and damage carries over.
  a.cmd('!craft-speed=0.1');
  await a.add('stone', 15);
  await delay(300);
  a.send(wire.buildOpenUpgradeMessage(wall.id, wall.pid));
  await until(() => a!.inventory.upgrade?.entityId === wall.id, 'A reopens');
  const finished: { x: number; y: number; iid: number }[] = [];
  a.bus.on('upgradeFinished', (e) => finished.push(e));
  a.send(wire.buildStartUpgradeMessage());
  await until(() => a!.inventory.upgrade?.running === true, 'restarted');
  assert.equal(a.inventory.upgrade!.durationMs, 3000, 'the craft speed scales it');
  await until(() => !!buildingAt(a!, 'stone_wall', wx, wy), 'it becomes a stone wall', 8000);
  assert(!buildingAt(a, 'wood_wall', wx, wy), 'the wooden wall is gone');
  await until(() => finished.length > 0, 'UPGRADE_FINISHED');
  assert.equal(finished[0]!.iid, iid('stone_wall'));
  assert.equal(Math.floor(finished[0]!.x / TILE), wx);
  wall = buildingAt(a, 'stone_wall', wx, wy)!;
  await until(() => a!.inventory.upgrade?.entityId === wall.id, 'the window follows it');
  assert.equal(a.inventory.upgrade!.targetIid, iid('steel_wall'));
  assert.equal(a.inventory.upgrade!.running, false);
  const [stoneHp, stoneMax] = await health(a, wall);
  assert.equal(stoneMax, 7000);
  assert.equal(stoneHp, stoneMax - (woodMax - woodHp), 'the damage carries over');
  console.log(`PASS it finished on its own into ${stoneHp}/${stoneMax}, the window moving with it`);

  // 6. The last tier: the window closes once there is nothing more to become.
  await a.add('shaped_metal', 3);
  a.send(wire.buildStartUpgradeMessage());
  await until(() => a!.inventory.upgrade?.running === true, 'to steel');
  await until(() => !!buildingAt(a!, 'steel_wall', wx, wy), 'it becomes a metal wall', 10000);
  await until(() => a!.inventory.upgrade === null, 'the window closes at the last tier');
  const steel = buildingAt(a, 'steel_wall', wx, wy)!;
  const [steelHp, steelMax] = await health(a, steel);
  assert.equal(steelHp, steelMax - (stoneMax - stoneHp));
  console.log(`PASS the last tier closes the window (${steelHp}/${steelMax})`);

  // 7. Walking off closes the window; the upgrade is not cancelled by it.
  a.cmd('!craft-speed=1');
  a.cmd(`!t=${tx + 8}:${ty}`);
  await delay(800);
  const [sx, sy] = clearSpot(a, tx + 8, ty);
  a.cmd(`!t=${sx}:${sy}`);
  b.cmd(`!t=${sx}:${sy + 3}`);
  await delay(600);
  const [w2x, w2y] = await build(a, 'wood_wall', [
    [sx + 1, sy],
    [sx - 1, sy],
    [sx, sy + 1],
    [sx, sy - 1],
  ]);
  const wall2 = buildingAt(a, 'wood_wall', w2x, w2y)!;
  await a.add('stone', 20);
  a.send(wire.buildOpenUpgradeMessage(wall2.id, wall2.pid));
  await until(() => a!.inventory.upgrade?.entityId === wall2.id, 'open the second wall');
  a.send(wire.buildStartUpgradeMessage());
  await until(() => a!.inventory.upgrade?.running === true, 'start the second');
  a.cmd(`!t=${sx}:${sy + 6}`);
  await until(() => a!.inventory.upgrade === null, 'walking off closes the window');
  a.cmd(`!t=${sx}:${sy}`);
  await delay(600);
  a.send(wire.buildOpenUpgradeMessage(wall2.id, wall2.pid));
  await until(() => a!.inventory.upgrade?.running === true, 'still running after walking off');
  a.send(wire.buildCloseContainerMessage());
  a.inventory.closeContainers();
  console.log('PASS walking off closes the window and leaves the upgrade running');

  // 8. Destroyed mid-upgrade: what was paid in lies in the rubble.
  const around = [
    [w2x + (w2y - sy), w2y + (w2x - sx)],
    [w2x - (w2y - sy), w2y - (w2x - sx)],
    [sx + (w2y - sy), sy + (w2x - sx)],
    [sx - (w2y - sy), sy - (w2x - sx)],
  ] as [number, number][];
  for (let i = 0; i < 3; i++) await build(a, 'dynamite', around);
  await until(() => !buildingAt(a!, 'wood_wall', w2x, w2y), 'the second wall is blown up', 12000);
  assert.equal(a.total('stone'), 0);
  a.cmd(`!t=${w2x}:${w2y}`);
  await delay(400);
  await takeLootAround(a, 300);
  assert(a.total('stone') >= 20, `the upgrade's stone is in the rubble (${a.total('stone')})`);
  console.log('PASS a building destroyed mid-upgrade drops the materials paid in');
} finally {
  a?.ws.close();
  b?.ws.close();
}
