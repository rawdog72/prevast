// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { MoveMask } from '../net/opcodes';
import { KeyboardTracker } from './keyboard';

describe('KeyboardTracker', () => {
  it('computes movement mask from directional keys', () => {
    const target = new EventTarget();
    const tracker = new KeyboardTracker({ target });

    expect(tracker.getMoveMask()).toBe(MoveMask.NONE);

    // Press W (Up)
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(tracker.isUp()).toBe(true);
    expect(tracker.getMoveMask()).toBe(MoveMask.UP);

    // Press D (Right)
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
    expect(tracker.isRight()).toBe(true);
    expect(tracker.getMoveMask()).toBe(MoveMask.UP | MoveMask.RIGHT);

    // Release W
    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    expect(tracker.isUp()).toBe(false);
    expect(tracker.getMoveMask()).toBe(MoveMask.RIGHT);

    tracker.destroy();
  });

  it('supports arrow keys and AZERTY layout', () => {
    const target = new EventTarget();
    const tracker = new KeyboardTracker({ target });

    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' })); // Z = Up in AZERTY
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ' })); // Q = Left in AZERTY
    expect(tracker.isUp()).toBe(true);
    expect(tracker.isLeft()).toBe(true);
    expect(tracker.getMoveMask()).toBe(MoveMask.UP | MoveMask.LEFT);

    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyZ' }));
    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyQ' }));

    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown' }));
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft' }));
    expect(tracker.isDown()).toBe(true);
    expect(tracker.isLeft()).toBe(true);
    expect(tracker.getMoveMask()).toBe(MoveMask.DOWN | MoveMask.LEFT);

    tracker.destroy();
  });

  it('emits action events on keydown', () => {
    const target = new EventTarget();
    const tracker = new KeyboardTracker({ target });

    const actions: string[] = [];
    const unbind = tracker.onAction((action) => {
      actions.push(action);
    });

    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' }));
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC' }));
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));

    expect(actions).toEqual(['interact', 'slot_0', 'toggle_craft', 'cancel']);

    unbind();
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }));
    expect(actions).toEqual(['interact', 'slot_0', 'toggle_craft', 'cancel']);

    tracker.destroy();
  });

  it('suspends movement and non-dialog actions during textInputMode', () => {
    const target = new EventTarget();
    const tracker = new KeyboardTracker({ target });

    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(tracker.isUp()).toBe(true);

    tracker.setTextInputMode(true);
    expect(tracker.isTextInputMode()).toBe(true);
    expect(tracker.isUp()).toBe(false);
    expect(tracker.getMoveMask()).toBe(MoveMask.NONE);

    const actions: string[] = [];
    tracker.onAction((action) => actions.push(action));

    // Game action keys ignored in text mode
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' }));
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC' }));
    expect(actions).toHaveLength(0);

    // Enter and Escape still emit chat/cancel
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
    expect(actions).toEqual(['chat', 'cancel']);

    tracker.setTextInputMode(false);
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' }));
    expect(actions).toEqual(['chat', 'cancel', 'interact']);

    tracker.destroy();
  });

  it('tracks shift, alt, and ctrl modifiers', () => {
    const target = new EventTarget();
    const tracker = new KeyboardTracker({ target });

    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'ControlRight' }));
    expect(tracker.isShift()).toBe(true);
    expect(tracker.isCtrl()).toBe(true);
    expect(tracker.isAlt()).toBe(false);

    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' }));
    expect(tracker.isShift()).toBe(false);

    tracker.destroy();
  });
});

describe('KeyboardTracker and form fields', () => {
  it('leaves keys typed into an input alone (no movement, no window toggles), except Escape', () => {
    const tracker = new KeyboardTracker({ target: window });
    const actions: string[] = [];
    tracker.onAction((a) => actions.push(a));
    const input = document.createElement('input');
    document.body.appendChild(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
    expect(tracker.isUp()).toBe(false);
    expect(actions).toEqual([]);

    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    expect(actions).toEqual(['cancel']);

    input.remove();
    tracker.destroy();
  });

  it('ignores keys while disabled and forgets held keys when disabled', () => {
    const target = new EventTarget();
    const tracker = new KeyboardTracker({ target });
    const actions: string[] = [];
    tracker.onAction((a) => actions.push(a));
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    tracker.setEnabled(false);
    expect(tracker.isUp()).toBe(false);
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC' }));
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
    expect(actions).toEqual([]);
    expect(tracker.isRight()).toBe(false);
    tracker.setEnabled(true);
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC' }));
    expect(actions).toEqual(['toggle_craft']);
    tracker.destroy();
  });
});
