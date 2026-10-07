// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/quest-marker.ts
// The ! (a quest to start) or ? (a step to finish) floating over an NPC's
// nameplate, from QUEST_MARKERS. Drawn in world space, bobbing gently.

import { QuestMarker } from '../../../../shared/typescript/quest-protocol';
import { NAMEPLATE_OFFSET_Y } from './nameplates';

const FONT = "30px 'Viga', sans-serif";
const START_COLOR = '#ffc93c';
const TURN_IN_COLOR = '#fff1a8';

export function drawQuestMarker(ctx: CanvasRenderingContext2D, x: number, y: number, kind: number, timeMs: number): void {
  if (kind !== QuestMarker.START && kind !== QuestMarker.TURN_IN) return;
  const glyph = kind === QuestMarker.TURN_IN ? '?' : '!';
  const top = y - NAMEPLATE_OFFSET_Y - 24 + Math.sin(timeMs / 320) * 3;
  ctx.save();
  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.fillStyle = kind === QuestMarker.TURN_IN ? TURN_IN_COLOR : START_COLOR;
  ctx.strokeText(glyph, x, top);
  ctx.fillText(glyph, x, top);
  ctx.restore();
}
