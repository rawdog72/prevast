// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
import {
  accountIdentityPacketSchema,
  runLiveSchema,
} from '../../../../../shared/typescript/account-community';
import { BinaryReader } from '../binary-stream';
import type { NetEventBus } from '../events';

function read(bytes: Uint8Array): unknown {
  const reader = new BinaryReader(bytes, 1);
  const json = reader.str();
  if (reader.hasError || reader.remaining()) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
export function handleAccountRun(bytes: Uint8Array, bus: NetEventBus): void {
  const parsed = runLiveSchema.safeParse(read(bytes));
  if (parsed.success) bus.emit('accountRun', parsed.data);
}
export function handleAccountClans(bytes: Uint8Array, bus: NetEventBus): void {
  const parsed = accountIdentityPacketSchema.safeParse(read(bytes));
  if (parsed.success) bus.emit('accountClans', parsed.data);
}
