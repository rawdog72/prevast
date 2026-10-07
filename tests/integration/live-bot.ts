// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// An admin bot for the live integration tests: a raw socket fed through the
// client's own decoders and stores, against run-smoke.mjs's isolated server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { unwrapBatch } from '../../apps/client/src/net/batch';
import { dispatchServerMessage } from '../../apps/client/src/net/dispatcher';
import { NetEventBus, type AimStateEvent } from '../../apps/client/src/net/events';
import * as wire from '../../apps/client/src/net/outbound';
import { InventoryStore } from '../../apps/client/src/world/inventory-store';
import { WorldState } from '../../apps/client/src/world/world-state';

export const port = process.env.SMOKE_GAME_PORT;
export const password = process.env.SMOKE_ADMIN_PASSWORD;

const items = JSON.parse(readFileSync('dist/content/items.json', 'utf8')).entries as Record<
  string,
  { id: number }
>;
export const iid = (key: string): number => {
  assert(items[key], `Unknown item ${key}`);
  return items[key]!.id;
};

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check: () => unknown, label: string, timeout = 8000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await delay(30);
  }
}

export class Bot {
  ws!: WebSocket;
  bus = new NetEventBus();
  inventory = new InventoryStore();
  world = new WorldState();
  statuses: string[] = [];
  aimStates: AimStateEvent[] = [];
  constructor(readonly name: string) {
    this.inventory.attachBus(this.bus);
    this.world.attachBus(this.bus);
    this.bus.on('statusMessage', (e) => this.statuses.push(e.text));
    this.bus.on('aimState', (e) => this.aimStates.push(e));
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
  async add(key: string, count = 1): Promise<void> {
    const before = this.total(key);
    this.cmd(`!i=${key}*${count}`);
    await until(() => this.total(key) > before, `give ${key}`);
  }
  /** The last AIM_STATE; not aiming before the first. */
  get aiming(): boolean {
    return this.aimStates.at(-1)?.active ?? false;
  }
}
