// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { Camera } from '../core/camera';
import { EntityType } from '../world/entity-types';
import { WorldState } from '../world/world-state';
import { CHAT_BUBBLE_OFFSET_Y, ChatBubbles, wrapBubbleText } from './chat-bubbles';

describe('ChatBubbles (old client _playerChatMessage)', () => {
  it('wraps words and long Unicode tokens into at most three lines with an ellipsis', () => {
    const measure = (text: string) => [...text].length * 8;
    const lines = wrapBubbleText(
      'meet me at the northern gate with food for everyone',
      measure,
      96,
    );
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toMatch(/…$/);
    expect(lines.every((line) => measure(line) <= 96)).toBe(true);
    expect(
      wrapBubbleText('🙂'.repeat(20), measure, 40).every(
        (line) => measure(line) <= 40 && !line.includes('\uFFFD'),
      ),
    ).toBe(true);
  });
  it('gives longer messages more reading time, capped at eight seconds', () => {
    const bubbles = new ChatBubbles();
    bubbles.push(1, 'long '.repeat(40));
    bubbles.update(6000);
    expect(bubbles.frames(1)).toHaveLength(1);
    bubbles.update(2100);
    expect(bubbles.frames(1)).toHaveLength(0);
  });
  it('fades a bubble in over 250 ms, holds it, fades out from 4.75 s and drops it after 5 s', () => {
    const bubbles = new ChatBubbles();
    bubbles.push(3, 'hello');
    expect(bubbles.frames(3)).toEqual([]); // effect 0: not drawn yet

    bubbles.update(125);
    expect(bubbles.frames(3)).toEqual([{ text: 'hello', alpha: 0.5, rise: 0 }]);

    bubbles.update(2000);
    expect(bubbles.frames(3)[0]!.alpha).toBe(1);

    bubbles.update(2750); // 4.875 s
    expect(bubbles.frames(3)[0]!.alpha).toBeCloseTo(0.625, 5);

    bubbles.update(200);
    expect(bubbles.frames(3)).toEqual([]);
    expect(bubbles.hasAny).toBe(false);
  });

  it('shows at most two: the older one eases 28 units up, the newer waits a second before fading in', () => {
    const bubbles = new ChatBubbles();
    bubbles.push(3, 'first');
    bubbles.push(3, 'second');
    bubbles.push(3, 'third');

    bubbles.update(600);
    let f = bubbles.frames(3);
    // textEase 0.6 -> inOutQuad -> 0.68 * 28; the second is not yet ticking (first < 1 s).
    expect(f).toHaveLength(1);
    expect(f[0]!.text).toBe('first');
    expect(f[0]!.rise).toBeCloseTo(0.68 * 28, 3);

    bubbles.update(350); // first at 0.95 s, ease 0.95: the second still waits.
    expect(bubbles.frames(3)).toHaveLength(1);
    bubbles.update(100); // first past 1 s, ease 1: the second starts its clock.
    f = bubbles.frames(3);
    expect(f).toHaveLength(2);
    expect(f[0]!.rise).toBe(28);
    expect(f[1]!.text).toBe('second');
    expect(f[1]!.alpha).toBeCloseTo(0.4, 5);
    expect(f[1]!.rise).toBe(0);

    // The first expires at 5 s; the third only starts once it is gone AND the
    // second has been up a second with the slide half done.
    bubbles.update(4000);
    expect(bubbles.frames(3).map((x) => x.text)).toEqual(['second']);
    bubbles.update(500); // slide exactly half: still gated
    expect(bubbles.frames(3).map((x) => x.text)).toEqual(['second']);
    bubbles.update(100);
    f = bubbles.frames(3);
    expect(f.map((x) => x.text)).toEqual(['second', 'third']);
    expect(f[1]!.alpha).toBeCloseTo(0.4, 5);
  });

  it('clear(pid) drops a dead player’s bubbles', () => {
    const bubbles = new ChatBubbles();
    bubbles.push(3, 'bye');
    bubbles.update(100);
    bubbles.clear(3);
    expect(bubbles.frames(3)).toEqual([]);
  });

  it('draws a black rounded label with white text above the speaker, in screen space', () => {
    const bubbles = new ChatBubbles();
    bubbles.push(3, 'hi there');
    bubbles.update(1000);
    const world = new WorldState();
    world.entities.processUnits([
      {
        pid: 3,
        id: 0,
        type: EntityType.PLAYER,
        rotation: 0,
        state: 1,
        startX: 500,
        startY: 500,
        endX: 500,
        endY: 500,
        extra: 0,
      },
    ]);
    const camera = new Camera({ viewportWidth: 800, viewportHeight: 600, zoom: 1 });
    camera.update(500, 500);
    const calls: string[] = [];
    let alpha = 1;
    const ctx = {
      save() {},
      restore() {},
      beginPath() {},
      fill() {
        calls.push('fill');
      },
      roundRect(x: number, y: number, w: number, h: number) {
        calls.push(
          `roundRect(${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)})`,
        );
      },
      fillText(text: string, x: number, y: number) {
        calls.push(`fillText(${text},${Math.round(x)},${Math.round(y)},a=${alpha})`);
      },
      measureText: () => ({ width: 60 }),
      set globalAlpha(v: number) {
        alpha = v;
      },
      get globalAlpha() {
        return alpha;
      },
      font: '',
      textAlign: '',
      textBaseline: '',
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D;

    bubbles.render(ctx, camera, world);
    // Player at the centre (400, 300); the label sits CHAT_BUBBLE_OFFSET_Y above,
    // 60 + 16.5 wide and 16 + 9.5 high, centred on x.
    const top = 300 - CHAT_BUBBLE_OFFSET_Y;
    expect(calls).toContain(`roundRect(${Math.round(400 - 76.5 / 2)},${Math.round(top)},77,26)`);
    expect(calls.some((c) => c.startsWith('fillText(hi there,400,'))).toBe(true);
    expect(calls.find((c) => c.startsWith('fillText'))).toContain('a=1');
  });
});
