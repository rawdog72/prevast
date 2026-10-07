// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Launched only against run-smoke.mjs's fresh, isolated game server.
// Aiming end to end: AIM gives AIM_STATE, a reload ends it and it resumes
// after, releasing the button ends it, and a tube scope's shift view sends
// what lies ahead and gives up the strip behind; the sniper's strong rect view
// sends only the rect and the circle around the player.
import assert from 'node:assert/strict';
import * as wire from '../../apps/client/src/net/outbound';
import { EntityType } from '../../apps/client/src/world/entity-types';
import { Bot, delay, iid, password, port, until } from './live-bot';

assert(port && password, 'Run through npm run smoke, with its isolated server');

let a: Bot | undefined;
let b: Bot | undefined;
try {
  a = await new Bot('AimA').connect();
  await a.add('mp5_tactical');
  await a.add('9mm_bullet', 60);
  const gun = a.item('mp5_tactical');
  a.send(wire.buildEquipItemMessage(gun.iid, gun.uid, 1, gun.ammo));
  await until(() => a!.inventory.selectedIid === gun.iid, 'equip the SMG Tactical');

  // 1. Holding the button turns aiming on, and says which viewport the box is built from.
  a.send(wire.buildAimMessage(true));
  await until(() => a!.aiming, 'AIM gives AIM_STATE 1');
  assert(
    a.aimStates.at(-1)!.viewX > 0 && a.aimStates.at(-1)!.viewY > 0,
    'AIM_STATE carries the viewport',
  );
  console.log('PASS holding aim turns aiming on');

  // 2. A reload ends it; it resumes when the reload is done (the button is still held).
  // The fresh gun's magazine is empty, so R reloads.
  a.send(wire.buildReloadMessage());
  await until(() => !a!.aiming, 'a reload ends aiming', 2000);
  await until(() => a!.aiming, 'aiming resumes once the reload is done', 6000);
  console.log('PASS a reload ends aiming and it resumes after');

  // 3. Letting go ends it.
  a.send(wire.buildAimMessage(false));
  await until(() => !a!.aiming, 'releasing ends aiming');
  console.log('PASS releasing the button ends aiming');

  // 4. A tube scope's shift view, aimed north: the box reaches past the
  //    viewport ahead and gives up the strip behind.
  const sees = (viewer: Bot, other: Bot) =>
    viewer.world.entities
      .getByType(EntityType.PLAYER)
      .some((e) => e.pid === other.world.ownGuid && !e.removed);
  b = await new Bot('AimB').connect();
  await a.add('tube_scope');
  const scoped = a.item('mp5_tactical');
  const scope = a.item('tube_scope');
  a.send(wire.buildWeaponModMessage(scoped.uid, 1, scope.uid));
  await until(
    () => a!.inventory.modsOf(scoped.uid).some((m) => m.slot === 1 && m.iid === iid('tube_scope')),
    'fit the tube scope',
    6000,
  );
  const viewY = a.aimStates[0]!.viewY;
  // Tile centres: B stands `north` tiles north (beyond the box, within the
  // shifted reach of 500) and then `south` tiles south (inside the box, inside
  // the strip a shift gives up).
  const north = Math.floor((viewY + 300) / 100);
  const south = Math.floor((viewY - 300) / 100);
  const cx = Math.floor(a.world.tilesX / 2);
  const cy = Math.floor(a.world.tilesY / 2);
  a.cmd(`!t=${cx}:${cy}`);
  b.cmd(`!t=${cx}:${cy - north}`);
  a.send(wire.buildRotationMessage(270)); // north: y grows downward
  await delay(600);
  assert(!sees(a, b), `B, ${north * 100} north, is outside the normal box`);
  a.send(wire.buildAimMessage(true));
  await until(() => a!.aiming, 'aim with the tube scope');
  await until(() => sees(a!, b!), 'the shifted box reaches B ahead');
  console.log('PASS a shift view sends what lies ahead past the normal box');

  b.cmd(`!t=${cx}:${cy + south}`);
  await until(() => !sees(a!, b!), 'B behind, in the strip a shift view gives up');
  a.send(wire.buildAimMessage(false));
  await until(() => sees(a!, b!), 'letting go brings B back');
  console.log('PASS a shift view gives up the strip behind until aiming ends');

  // 5. The sniper's built-in rect view (length 1900, width 500, back 100,
  //    rear circle 250), aimed east: B past the normal box but inside the rect
  //    is sent; B beside A, inside the normal box but outside the rect and the
  //    rear circle, is not; B just behind A, inside the rear circle, is.
  await a.add('sniper');
  const sniper = a.item('sniper');
  a.send(wire.buildEquipItemMessage(sniper.iid, sniper.uid, 1, sniper.ammo));
  await until(() => a!.inventory.selectedIid === sniper.iid, 'equip the sniper');
  const viewX = a.aimStates[0]!.viewX;
  const east = Math.floor((viewX + 300) / 100);
  assert(east * 100 > viewX && east * 100 < 1900, 'B east is past the normal box and inside the rect');
  a.cmd(`!t=${cx}:${cy}`);
  b.cmd(`!t=${cx + east}:${cy}`);
  a.send(wire.buildRotationMessage(0)); // east
  await delay(600);
  assert(!sees(a, b), `B, ${east * 100} east, is outside the normal box`);
  a.send(wire.buildAimMessage(true));
  await until(() => a!.aiming, 'aim the sniper once it is drawn', 4000);
  await until(() => sees(a!, b!), 'the rect reaches B ahead');
  console.log('PASS a strong rect view sends what lies ahead past the normal box');

  b.cmd(`!t=${cx}:${cy + 4}`); // 400 south: in the normal box, outside the rect (250) and the rear circle (250)
  await until(() => !sees(a!, b!), 'B beside A, outside the rect and the rear circle');
  b.cmd(`!t=${cx - 2}:${cy}`); // 200 west: behind the rect's back (100), inside the rear circle
  await until(() => sees(a!, b!), 'B behind A, inside the rear circle');
  a.send(wire.buildAimMessage(false));
  console.log('PASS a strong view sends only its shape and the rear circle');
} finally {
  a?.ws?.close();
  b?.ws?.close();
}
