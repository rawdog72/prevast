// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Launched only against run-smoke.mjs's fresh, isolated game server.
// Effects end to end: a thrown gas grenade and a smoke grenade run their
// effects.xml entries, and the zone each leaves arrives as AREA_EFFECT naming
// that entry (so the client draws its <client> look) and saying whether it
// hides what is in it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AreaEffectEvent } from '../../apps/client/src/net/events';
import * as wire from '../../apps/client/src/net/outbound';
import { Bot, delay, password, port, until } from './live-bot';

assert(port && password, 'Run through npm run smoke, with its isolated server');

const effects = JSON.parse(readFileSync('dist/content/effects.json', 'utf8')).entries as Record<
  string,
  { id: number; zone?: { kind?: string } }
>;
const effectId = (key: string): number => {
  assert(effects[key], `Unknown effect ${key}`);
  return effects[key]!.id;
};

let bot: Bot | undefined;
try {
  bot = await new Bot('Effects').connect();
  const zones: AreaEffectEvent[] = [];
  bot.bus.on('areaEffect', (e) => zones.push(e));

  /** Cooks and throws the grenade `key` 300 units east; resolves with the zone it leaves. */
  const throwFor = async (key: string, effect: string): Promise<AreaEffectEvent> => {
    await bot!.add(key);
    const grenade = bot!.item(key);
    bot!.send(wire.buildEquipItemMessage(grenade.iid, grenade.uid, 1, grenade.ammo));
    await until(() => bot!.inventory.selectedIid === grenade.iid, `equip ${key}`, 4000);
    await delay(1100); // the equip time
    bot!.send(wire.buildMouseDownMessage()); // pull the pin
    await delay(400);
    bot!.send(wire.buildThrowTargetMessage(300, 0));
    bot!.send(wire.buildMouseUpMessage());
    const id = effectId(effect);
    await until(() => zones.some((z) => z.effectId === id), `${key} leaves ${effect}`, 10000);
    return zones.find((z) => z.effectId === id)!;
  };

  const gas = await throwFor('gas_grenade', 'toxic_gas');
  assert.equal(gas.kind, 1, 'a gas zone is kind gas');
  assert.equal(gas.hides, false, 'gas hides nothing');
  assert(gas.cells.length > 0 && gas.cells.length <= 30, 'it covers at most its tiles');
  console.log(
    `PASS a gas grenade leaves toxic_gas (effect ${gas.effectId}, ${gas.cells.length} tiles)`,
  );

  const smoke = await throwFor('smoke_grenade', 'smoke_screen');
  assert.equal(smoke.kind, 2, 'a smoke zone is kind smoke');
  assert.equal(smoke.hides, true, 'smoke hides what is in it');
  console.log(`PASS a smoke grenade leaves smoke_screen, which hides (effect ${smoke.effectId})`);
} finally {
  bot?.ws.close();
}
