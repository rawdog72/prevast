// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { BinaryReader } from '../binary-stream';
import type { NetEventBus, GaugeRatesEvent } from '../events';
import { GAUGE_SLOTS, GaugeDirection } from '../opcodes';

export function handleGaugeValues(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [GAUGE_VALUES][life u8][food u8][warmth(cold) u8][stamina u8][rad u8] -- ProtocolGame::sendGauges
  // sends each gauge as a single uint8_t; there is no pad byte and no u16 widening.
  const r = new BinaryReader(bytes, 1);
  const life = r.u8();
  const food = r.u8();
  const warmth = r.u8();
  const stamina = r.u8();
  const radiation = r.u8();
  bus.emit('gauges', { life, food, warmth, stamina, radiation });
}

export function handleGaugeDirections(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [GAUGE_DIRECTIONS][packed u16 LE]
  const r = new BinaryReader(bytes, 1);
  const packed = r.u16();
  const getDir = (index: number): GaugeDirection => {
    const val = (packed >> (index * 2)) & 3;
    if (val === 1) return GaugeDirection.RISE;
    if (val === 2) return GaugeDirection.FALL;
    return GaugeDirection.HOLD;
  };

  bus.emit('gaugeState', {
    life: getDir(0),
    food: getDir(1),
    warmth: getDir(2),
    stamina: getDir(3),
    radiation: getDir(4),
  });
}

export function handleGaugeRates(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [GAUGE_RATES][pad u8] then 15 u16 LE values: (max, inc, dec) for each of the 5 slots
  const r = new BinaryReader(bytes, 2);
  const rates = {} as GaugeRatesEvent;
  for (const slot of GAUGE_SLOTS) {
    const max = r.u16();
    const inc = r.u16();
    const dec = r.u16();
    rates[slot] = { max, inc, dec };
  }
  bus.emit('gaugeRates', rates);
}

export function handleOverheadAlert(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout (Game::broadcastNotification): [OVERHEAD_ALERT][pid u8][(type << 2) | (level & 3) u8]
  const packed = bytes[2] ?? 0;
  bus.emit('notification', { pid: bytes[1] ?? 0, type: packed >> 2, level: packed & 3 });
}

export function handlePlayerHit(bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('playerHit', { pid: bytes[1] ?? 0, angle: bytes[2] ?? 0 });
}

export function handlePlayerHealed(bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('playerHeal', { pid: bytes[1] ?? 0 });
}

export function handleStamina(bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('playerStamina', { stamina: bytes[1] ?? 0 });
}

export function handleXp(bytes: Uint8Array, bus: NetEventBus): void {
  // Client reads as big-endian: (ui8[1] << 8) + ui8[2]
  const xp = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
  bus.emit('playerXp', { xp });
}

export function handleLevelState(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout (ProtocolGame::sendPlayerXpSkill): [LEVEL_STATE][level u8][xp-in-level u32 BE][unlocked iid u8]*
  const level = bytes[1] ?? 0;
  const xp =
    ((bytes[2] ?? 0) << 24) + ((bytes[3] ?? 0) << 16) + ((bytes[4] ?? 0) << 8) + (bytes[5] ?? 0);
  const skills: number[] = [];
  for (let i = 6; i < bytes.length; i++) {
    if (bytes[i]) skills.push(bytes[i]!);
  }
  bus.emit('playerXpSkill', { level, xp, skills });
}

export function handleSkillUnlocked(bytes: Uint8Array, bus: NetEventBus): void {
  const iid = bytes[1] ?? 0;
  bus.emit('boughtSkill', { iid });
}

export function handlePlayerAte(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [PLAYER_ATE][pid u8] -- Game::broadcastPlayerEat sends the EATER's guid
  // (old client onPlayerEat(ui8[1]) -> player.hurt2 = 300), not an item id.
  bus.emit('playerEat', { pid: bytes[1] ?? 0 });
}

export function handleCountdown(bytes: Uint8Array, bus: NetEventBus): void {
  const remainingMs = bytes[1] ?? 0;
  bus.emit('dramaticChrono', { remainingMs });
}

export function handlePoisoned(bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('drug', { kind: 'poisoned', a: bytes[1] ?? 0, b: 0 });
}

export function handleRepellentActive(bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('drug', { kind: 'repellent', a: bytes[1] ?? 0, b: bytes[2] ?? 0 });
}

export function handleLapadoneActive(bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('drug', { kind: 'lapadoine', a: bytes[1] ?? 0, b: bytes[2] ?? 0 });
}

export function handleDrugReset(bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('drug', { kind: 'reset', a: bytes[1] ?? 0, b: bytes[2] ?? 0 });
}
