// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { CanvasManager, snapResolutionDivisor } from './canvas';

function fakeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const transforms: number[][] = [];
  const ctx = {
    setTransform: (...m: number[]) => transforms.push(m),
    transforms,
  };
  (canvas as unknown as { getContext: () => unknown }).getContext = () => ctx;
  return canvas;
}

describe('CanvasManager resolution divisor', () => {
  it('snaps to the fixed levels so the buffer is not reallocated every frame', () => {
    expect(snapResolutionDivisor(1)).toBe(1);
    expect(snapResolutionDivisor(1.2)).toBe(1);
    expect(snapResolutionDivisor(2.4)).toBe(2);
    expect(snapResolutionDivisor(11)).toBe(12);
    expect(snapResolutionDivisor(21)).toBe(21);
    expect(snapResolutionDivisor(40)).toBe(21);
  });

  it('shrinks the backing store and the context scale, keeping the CSS size', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    const canvas = fakeCanvas();
    const mgr = new CanvasManager(canvas);
    expect(canvas.width).toBe(2400);
    expect(canvas.height).toBe(1600);

    mgr.setResolutionDivisor(4);
    expect(mgr.resolutionDivisor).toBe(4);
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(400);
    expect(canvas.style.width).toBe('1200px');
    expect(canvas.style.height).toBe('800px');
    const transforms = (mgr.ctx as unknown as { transforms: number[][] }).transforms;
    expect(transforms[transforms.length - 1]).toEqual([0.5, 0, 0, 0.5, 0, 0]);

    // Same level again: no reallocation.
    const before = transforms.length;
    mgr.setResolutionDivisor(4.1);
    expect(transforms.length).toBe(before);

    // A window resize keeps the divisor.
    mgr.resize();
    expect(canvas.width).toBe(600);

    mgr.setResolutionDivisor(1);
    expect(canvas.width).toBe(2400);
    mgr.destroy();
  });
});
