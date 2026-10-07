// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import { MouseTracker } from './mouse';

describe('MouseTracker', () => {
  it('tracks mouse positions and buttons on target element', () => {
    const el = document.createElement('div');
    // Mock getBoundingClientRect
    el.getBoundingClientRect = () => ({
      left: 100,
      top: 50,
      width: 400,
      height: 300,
      right: 500,
      bottom: 350,
      x: 100,
      y: 50,
      toJSON: () => {},
    });

    const tracker = new MouseTracker({ target: el });

    expect(tracker.isLeftDown).toBe(false);
    expect(tracker.isRightDown).toBe(false);

    // Mouse move
    el.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 200 }));
    expect(tracker.clientX).toBe(300);
    expect(tracker.clientY).toBe(200);
    expect(tracker.screenX).toBe(200); // 300 - 100
    expect(tracker.screenY).toBe(150); // 200 - 50

    // Left mouse down
    let lastDownButton = -1;
    tracker.onDown((btn) => {
      lastDownButton = btn;
    });

    el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 300, clientY: 200 }));
    expect(tracker.isLeftDown).toBe(true);
    expect(lastDownButton).toBe(0);

    // Left mouse up
    el.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 300, clientY: 200 }));
    expect(tracker.isLeftDown).toBe(false);

    // Right mouse down
    el.dispatchEvent(new MouseEvent('mousedown', { button: 2, clientX: 300, clientY: 200 }));
    expect(tracker.isRightDown).toBe(true);
    expect(lastDownButton).toBe(2);

    tracker.destroy();
  });

  it('reports CSS pixels on a HiDPI canvas whose backing store is scaled by devicePixelRatio', () => {
    // CanvasManager sizes the backing store at cssSize * dpr and applies a dpr
    // transform, so the camera/viewport space is CSS pixels. The mouse must
    // report in that same space or aim and look-ahead go wrong at dpr != 1.
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 1200;
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const tracker = new MouseTracker({ target: canvas });
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 300 }));

    expect(tracker.screenX).toBe(400);
    expect(tracker.screenY).toBe(300);

    tracker.destroy();
  });

  it('converts screen pos to world pos and computes angle', () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const tracker = new MouseTracker({ target: el });
    const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });
    camera.x = 1000;
    camera.y = 1000;

    // Move mouse to screen center (400, 300) -> world (1000, 1000)
    el.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 300 }));
    const worldPos = tracker.getWorldPos(camera);
    expect(worldPos.x).toBeCloseTo(1000);
    expect(worldPos.y).toBeCloseTo(1000);

    // Move mouse to right of center (600, 300) -> world (1200, 1000)
    el.dispatchEvent(new MouseEvent('mousemove', { clientX: 600, clientY: 300 }));
    const angleRight = tracker.getAngleFrom(1000, 1000, camera);
    expect(angleRight).toBeCloseTo(0);

    // Move mouse below center (400, 500) -> world (1000, 1200)
    el.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 500 }));
    const angleDown = tracker.getAngleFrom(1000, 1000, camera);
    expect(angleDown).toBeCloseTo(Math.PI / 2);

    tracker.destroy();
  });

  it('ignores buttons and wheel while disabled', () => {
    const el = document.createElement('div');
    const tracker = new MouseTracker({ target: el });
    const downs: number[] = [];
    const wheels: number[] = [];
    tracker.onDown((button) => downs.push(button));
    tracker.onWheel((dy) => wheels.push(dy));
    tracker.setEnabled(false);
    el.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }));
    expect(downs).toEqual([]);
    expect(wheels).toEqual([]);
    expect(tracker.isLeftDown).toBe(false);
    tracker.setEnabled(true);
    el.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    expect(downs).toEqual([0]);
    tracker.destroy();
  });
});
