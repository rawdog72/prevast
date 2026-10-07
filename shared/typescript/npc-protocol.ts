// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { z } from 'zod';

export const NPC_MAX_MONEY = 2_000_000_000;
export const NPC_MAX_QUANTITY = 4096;
export const NpcAction = {
  OPEN: 0, SAY: 1, BUY: 2, SELL: 3, DEPOSIT: 4, WITHDRAW: 5, CONVERT: 6, CLOSE: 7, REFRESH: 8,
} as const;
export type NpcAction = (typeof NpcAction)[keyof typeof NpcAction];
const uint = z.number().int().min(0).max(0xffffffff);
const money = uint.max(NPC_MAX_MONEY);
const text = z.string().max(512);
export const npcStateSchema = z.object({
  session: uint.min(1), revision: uint.min(1), entityId: uint.min(1).max(0xffffff),
  name: text, topic: text, panel: z.enum(['', 'shop', 'bank']), text,
  echo: z.string().max(256).optional(),
  banker: z.boolean(), tradeAllowed: z.boolean(), balance: money, wallet: money,
  range: uint.min(1).max(500), request: uint, restockSeconds: uint,
  offers: z.array(z.object({
    index: uint.max(15), iid: uint.min(1).max(65535), buy: money, sell: money,
    stock: uint.max(NPC_MAX_QUANTITY), unlimited: z.boolean(), rare: z.boolean(),
    buyMax: uint.max(NPC_MAX_QUANTITY), sellMax: uint.max(NPC_MAX_QUANTITY),
  })).max(16),
});
export type NpcState = z.infer<typeof npcStateSchema>;
export type NpcOffer = NpcState['offers'][number];
export interface NpcCommand {
  session: number; revision: number; request: number; action: NpcAction;
  target?: number; amount?: number; text?: string;
}

/** Braces are markup only in an NPC response; everything else stays text. */
export function npcKeywords(text: string): { text: string; keyword: boolean }[] {
  const parts: { text: string; keyword: boolean }[] = [];
  const matches = text.matchAll(/\{([^{}\r\n]{1,64})\}/g);
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index), keyword: false });
    parts.push({ text: match[1]!, keyword: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), keyword: false });
  return parts;
}
