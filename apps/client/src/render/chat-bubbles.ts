// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/chat-bubbles.ts
// Local speech above the speaker: bounded queues, up to three wrapped lines,
// and a five-to-eight-second reading time. The full message stays in the log.

import type { Camera } from '../core/camera';
import type { WorldState } from '../world/world-state';
import { easeInOutQuad } from './character-animator';

/** World units above the player's position where the label's top sits. */
export const CHAT_BUBBLE_OFFSET_Y = 118;
const FADE_IN_S = 0.25;
const SLIDE_UNITS = 28;
const MAX_SHOWN = 2;

const FONT_PX = 16;
const FONT_FAMILY = "'Viga', sans-serif";
const MAX_TEXT_WIDTH = 240;
const LINE_HEIGHT = 19;
const PAD_X = 16.5;
const PAD_Y = 9.5;
const RADIUS = 3;
const BACKGROUND = 'rgba(0, 0, 0, 0.55)';
const TEXT = '#ffffff';

interface Message {
  text: string;
  /** Old `textEffect`: seconds shown; stays 0 until this label is allowed to start. */
  effect: number;
  life: number;
  /** Measured text width in world units, once drawn. */
  width?: number;
  lines?: string[];
  layoutWidth?: number;
}

interface Queue {
  messages: Message[];
  /** Old `textEase`: 0..1 slide of the older label while a newer one waits. */
  ease: number;
}

export interface ChatBubbleFrame {
  text: string;
  alpha: number;
  /** Extra height above CHAT_BUBBLE_OFFSET_Y, in world units. */
  rise: number;
}

export class ChatBubbles {
  private readonly queues = new Map<number, Queue>();

  get hasAny(): boolean {
    return this.queues.size > 0;
  }

  push(pid: number, text: string): void {
    let q = this.queues.get(pid);
    if (!q) {
      q = { messages: [], ease: 0 };
      this.queues.set(pid, q);
    }
    // Do not make a player watch a minutes-long backlog after a burst.
    if (q.messages.length >= 4) q.messages.splice(2, 1);
    q.messages.push({ text, effect: 0, life: Math.max(5, Math.min(8, [...text].length / 20)) });
  }

  clear(pid: number): void {
    this.queues.delete(pid);
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000;
    for (const [pid, q] of this.queues) {
      const head = q.messages[0];
      if (!head) {
        this.queues.delete(pid);
        continue;
      }
      head.effect += dt;
      if (q.messages.length > 1) {
        q.ease = Math.min(q.ease + dt, 1);
        if (head.effect > 1 && q.ease > 0.5) q.messages[1]!.effect += dt;
      }
      if (head.effect > head.life) {
        q.messages.shift();
        q.ease = 0;
        if (q.messages.length === 0) this.queues.delete(pid);
      }
    }
  }

  /** The i-th shown label of a queue, or null while its clock has not started. */
  private frameOf(q: Queue, i: number): ChatBubbleFrame | null {
    const m = q.messages[i];
    if (!m || m.effect <= 0) return null;
    let alpha = 1;
    if (m.effect < FADE_IN_S) alpha = m.effect / FADE_IN_S;
    else if (m.effect > m.life - 0.25) alpha = Math.min(1, Math.max(0, (m.life - m.effect) * 5));
    const rise = i === 0 && q.messages.length > 1 ? easeInOutQuad(q.ease) * SLIDE_UNITS : 0;
    return { text: m.text, alpha, rise };
  }

  frames(pid: number): ChatBubbleFrame[] {
    const q = this.queues.get(pid);
    if (!q) return [];
    const out: ChatBubbleFrame[] = [];
    const shown = Math.min(MAX_SHOWN, q.messages.length);
    for (let i = 0; i < shown; i++) {
      const f = this.frameOf(q, i);
      if (f) out.push(f);
    }
    return out;
  }

  render(ctx: CanvasRenderingContext2D, camera: Camera, world: WorldState): void {
    if (this.queues.size === 0) return;
    const zoom = camera.zoom;
    const maxWidth = Math.max(
      40,
      Math.min(MAX_TEXT_WIDTH, (camera.viewportWidth - 24) / zoom - PAD_X),
    );
    ctx.save();
    ctx.font = `${FONT_PX * zoom}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [pid, q] of this.queues) {
      const entity = world.entities.get(pid, 0);
      if (!entity || entity.removed) continue;
      const shown = Math.min(MAX_SHOWN, q.messages.length);
      for (const m of q.messages.slice(0, shown)) {
        if (m.layoutWidth === maxWidth && m.lines) continue;
        const measure = (text: string) => ctx.measureText(text).width / zoom;
        m.lines = wrapBubbleText(m.text, measure, maxWidth);
        m.width = Math.max(...m.lines.map(measure), 1);
        m.layoutWidth = maxWidth;
      }
      for (let i = 0; i < shown; i++) {
        const f = this.frameOf(q, i);
        if (!f) continue;
        const m = q.messages[i]!;
        const lines = m.lines!;
        const w = (m.width! + PAD_X) * zoom;
        const extraHeight = (lines.length - 1) * LINE_HEIGHT;
        const h = (FONT_PX + PAD_Y + extraHeight) * zoom;
        const nextExtra =
          i === 0 && q.messages.length > 1
            ? ((q.messages[1]!.lines?.length ?? 1) - 1) * LINE_HEIGHT
            : 0;
        const rise = f.rise + easeInOutQuad(q.ease) * nextExtra;
        const p = camera.worldToScreen(
          entity.x,
          entity.y - CHAT_BUBBLE_OFFSET_Y - rise - extraHeight,
        );
        const x = Math.max(w / 2 + 4, Math.min(camera.viewportWidth - w / 2 - 4, p.x));
        ctx.globalAlpha = f.alpha;
        ctx.fillStyle = BACKGROUND;
        ctx.beginPath();
        ctx.roundRect(x - w / 2, p.y, w, h, RADIUS * zoom);
        ctx.fill();
        ctx.fillStyle = TEXT;
        lines.forEach((line, index) =>
          ctx.fillText(line, x, p.y + (PAD_Y / 2 + FONT_PX / 2 + index * LINE_HEIGHT) * zoom),
        );
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

/** Word-wrap, breaking long tokens by Unicode code point; never squash glyphs. */
export function wrapBubbleText(
  text: string,
  measure: (text: string) => number,
  maxWidth: number,
): string[] {
  const remaining = [...text.replace(/\s+/g, ' ').trim()];
  const lines: string[] = [];
  while (remaining.length && lines.length < 3) {
    let count = 0;
    while (count < remaining.length && measure(remaining.slice(0, count + 1).join('')) <= maxWidth)
      count++;
    count = Math.max(1, count);
    if (count < remaining.length && lines.length < 2) {
      const space = remaining.slice(0, count + 1).lastIndexOf(' ');
      if (space > 0) count = space;
    }
    const part = remaining.splice(0, count);
    while (remaining[0] === ' ') remaining.shift();
    if (lines.length === 2 && remaining.length) {
      while (part.length && measure(part.join('').trimEnd() + '…') > maxWidth) part.pop();
      lines.push(part.join('').trimEnd() + '…');
    } else lines.push(part.join('').trim());
  }
  return lines.length ? lines : [''];
}
