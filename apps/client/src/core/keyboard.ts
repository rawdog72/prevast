// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { MoveMask } from '../net/opcodes';

export type GameAction =
  | 'interact' // E, Space
  | 'extra_interact' // F
  | 'reload_rotate' // R
  | 'toggle_craft' // C
  | 'toggle_map' // M
  | 'toggle_team' // T
  | 'toggle_quests' // J
  | 'toggle_inventory' // I, B
  | 'toggle_skills' // K, O
  | 'chat' // Enter
  | 'cancel' // Escape
  | 'toggle_profiler' // F2
  | 'slot_0' // 1
  | 'slot_1' // 2
  | 'slot_2' // 3
  | 'slot_3' // 4
  | 'slot_4' // 5
  | 'slot_5' // 6
  | 'slot_6' // 7
  | 'slot_7' // 8
  | 'slot_8' // 9
  | 'slot_9'; // 0

export type ActionListener = (action: GameAction, event: KeyboardEvent) => void;

export interface KeyboardTrackerOptions {
  target?: EventTarget;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export class KeyboardTracker {
  private readonly target: EventTarget;
  private readonly keys = new Set<string>();
  private readonly actionListeners = new Set<ActionListener>();
  private textInputMode = false;
  private enabled = true;

  constructor(options: KeyboardTrackerOptions = {}) {
    this.target = options.target ?? (typeof window !== 'undefined' ? window : ({} as EventTarget));
    this.bind();
  }

  private readonly handleKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    if (!this.enabled) return;
    const code = event.code;

    // Typing into a window's form field (clan name, ...) is not gameplay: the
    // letters must not move the player or toggle windows. Escape still closes.
    if (isEditableTarget(event.target)) {
      if (code === 'Escape') this.emitAction('cancel', event);
      return;
    }
    this.keys.add(code);

    if (this.textInputMode) {
      if (code === 'Enter' || code === 'Escape') {
        this.emitAction(code === 'Enter' ? 'chat' : 'cancel', event);
      }
      return;
    }

    // Prevent default browser behavior for movement / action keys
    if (
      code === 'Space' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'Tab'
    ) {
      event.preventDefault();
    }

    const action = this.mapCodeToAction(code);
    if (action) {
      this.emitAction(action, event);
    }
  };

  private readonly handleKeyUp = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    this.keys.delete(event.code);
  };

  private readonly handleBlur = (): void => {
    this.releaseKeys();
  };

  private bind(): void {
    if (!this.target.addEventListener) return;
    this.target.addEventListener('keydown', this.handleKeyDown);
    this.target.addEventListener('keyup', this.handleKeyUp);
    this.target.addEventListener('blur', this.handleBlur);
  }

  destroy(): void {
    if (!this.target.removeEventListener) return;
    this.target.removeEventListener('keydown', this.handleKeyDown);
    this.target.removeEventListener('keyup', this.handleKeyUp);
    this.target.removeEventListener('blur', this.handleBlur);
    this.keys.clear();
    this.actionListeners.clear();
  }

  /** Off: keys are neither tracked nor turned into actions (the game is not running). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.releaseKeys();
  }

  /** Forgets every held key, as if all were released (the page lost focus). */
  releaseKeys(): void {
    this.keys.clear();
  }

  setTextInputMode(active: boolean): void {
    this.textInputMode = active;
    if (active) {
      this.keys.clear();
    }
  }

  isTextInputMode(): boolean {
    return this.textInputMode;
  }

  onAction(listener: ActionListener): () => void {
    this.actionListeners.add(listener);
    return () => {
      this.actionListeners.delete(listener);
    };
  }

  private emitAction(action: GameAction, event: KeyboardEvent): void {
    for (const listener of this.actionListeners) {
      listener(action, event);
    }
  }

  isUp(): boolean {
    if (this.textInputMode) return false;
    return this.keys.has('KeyW') || this.keys.has('KeyZ') || this.keys.has('ArrowUp');
  }

  isDown(): boolean {
    if (this.textInputMode) return false;
    return this.keys.has('KeyS') || this.keys.has('ArrowDown');
  }

  isLeft(): boolean {
    if (this.textInputMode) return false;
    return this.keys.has('KeyA') || this.keys.has('KeyQ') || this.keys.has('ArrowLeft');
  }

  isRight(): boolean {
    if (this.textInputMode) return false;
    return this.keys.has('KeyD') || this.keys.has('ArrowRight');
  }

  isShift(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  isAlt(): boolean {
    return this.keys.has('AltLeft') || this.keys.has('AltRight');
  }

  isCtrl(): boolean {
    return this.keys.has('ControlLeft') || this.keys.has('ControlRight');
  }

  getMoveMask(): MoveMask {
    if (this.textInputMode) return MoveMask.NONE;
    let mask = MoveMask.NONE;
    if (this.isLeft()) mask |= MoveMask.LEFT;
    if (this.isRight()) mask |= MoveMask.RIGHT;
    if (this.isDown()) mask |= MoveMask.DOWN;
    if (this.isUp()) mask |= MoveMask.UP;
    return mask;
  }

  private mapCodeToAction(code: string): GameAction | null {
    switch (code) {
      case 'KeyE':
      case 'Space':
        return 'interact';
      case 'KeyF':
        return 'extra_interact';
      case 'KeyR':
        return 'reload_rotate';
      case 'KeyC':
        return 'toggle_craft';
      case 'KeyM':
        return 'toggle_map';
      case 'KeyT':
        return 'toggle_team';
      case 'KeyJ':
        return 'toggle_quests';
      case 'KeyI':
      case 'KeyB':
        return 'toggle_inventory';
      case 'KeyK':
      case 'KeyO':
        return 'toggle_skills';
      case 'Enter':
      case 'NumpadEnter':
        return 'chat';
      case 'Escape':
        return 'cancel';
      case 'F2':
        return 'toggle_profiler';
      case 'Digit1':
      case 'Numpad1':
        return 'slot_0';
      case 'Digit2':
      case 'Numpad2':
        return 'slot_1';
      case 'Digit3':
      case 'Numpad3':
        return 'slot_2';
      case 'Digit4':
      case 'Numpad4':
        return 'slot_3';
      case 'Digit5':
      case 'Numpad5':
        return 'slot_4';
      case 'Digit6':
      case 'Numpad6':
        return 'slot_5';
      case 'Digit7':
      case 'Numpad7':
        return 'slot_6';
      case 'Digit8':
      case 'Numpad8':
        return 'slot_7';
      case 'Digit9':
      case 'Numpad9':
        return 'slot_8';
      case 'Digit0':
      case 'Numpad0':
        return 'slot_9';
      default:
        return null;
    }
  }
}
