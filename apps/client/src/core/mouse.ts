// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import type { Camera } from './camera';
import { angle } from './math2d';

export interface MouseTrackerOptions {
  target?: HTMLElement;
}

export type MouseButtonListener = (
  button: number,
  screenPos: { x: number; y: number },
  event: MouseEvent,
) => void;
export type MouseMoveListener = (screenPos: { x: number; y: number }, event: MouseEvent) => void;
export type MouseWheelListener = (deltaY: number, event: WheelEvent) => void;

export class MouseTracker {
  private readonly target: HTMLElement | null;

  // Screen coordinates in CSS pixels relative to the target element -- the
  // same space the Camera viewport uses (CanvasManager scales the backing
  // store by devicePixelRatio and applies a matching context transform, so
  // world rendering is in CSS pixels too). Reporting backing-store pixels here
  // made aim and camera look-ahead scale wrong whenever devicePixelRatio != 1.
  screenX = 0;
  screenY = 0;

  // Raw client coordinates
  clientX = 0;
  clientY = 0;

  isLeftDown = false;
  isRightDown = false;
  isMiddleDown = false;

  /** False until the first mouse event: before that screenX/Y are a placeholder, not a cursor. */
  hasPosition = false;

  private readonly downListeners = new Set<MouseButtonListener>();
  private readonly upListeners = new Set<MouseButtonListener>();
  private readonly moveListeners = new Set<MouseMoveListener>();
  private readonly wheelListeners = new Set<MouseWheelListener>();
  private enabled = true;

  constructor(options: MouseTrackerOptions = {}) {
    this.target = options.target ?? null;
    this.bind();
  }

  private updateScreenPos(clientX: number, clientY: number): void {
    this.clientX = clientX;
    this.clientY = clientY;
    this.hasPosition = true;

    if (!this.target || !this.target.getBoundingClientRect) {
      this.screenX = clientX;
      this.screenY = clientY;
      return;
    }

    const rect = this.target.getBoundingClientRect();
    this.screenX = clientX - rect.left;
    this.screenY = clientY - rect.top;
  }

  private readonly handleMouseMove = (event: MouseEvent): void => {
    this.updateScreenPos(event.clientX, event.clientY);
    const pos = { x: this.screenX, y: this.screenY };
    for (const listener of this.moveListeners) {
      listener(pos, event);
    }
  };

  /** Moves over anything but the canvas (HUD, windows, a dragged item); the canvas has its own listener. */
  private readonly handleWindowMouseMove = (event: MouseEvent): void => {
    if (this.target && event.target instanceof Node && this.target.contains(event.target)) return;
    this.handleMouseMove(event);
  };

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (!this.enabled) return;
    this.updateScreenPos(event.clientX, event.clientY);
    if (event.button === 0) this.isLeftDown = true;
    if (event.button === 2) this.isRightDown = true;
    if (event.button === 1) this.isMiddleDown = true;

    const pos = { x: this.screenX, y: this.screenY };
    for (const listener of this.downListeners) {
      listener(event.button, pos, event);
    }
  };

  private readonly handleMouseUp = (event: MouseEvent): void => {
    if (!this.enabled) return;
    this.updateScreenPos(event.clientX, event.clientY);
    if (event.button === 0) this.isLeftDown = false;
    if (event.button === 2) this.isRightDown = false;
    if (event.button === 1) this.isMiddleDown = false;

    const pos = { x: this.screenX, y: this.screenY };
    for (const listener of this.upListeners) {
      listener(event.button, pos, event);
    }
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!this.enabled) return;
    for (const listener of this.wheelListeners) {
      listener(event.deltaY, event);
    }
  };

  private readonly handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private bind(): void {
    const el = this.target;
    if (!el || !el.addEventListener) return;

    // Buttons are the canvas's own (a click on a HUD button is not an
    // attack), but the cursor position is tracked window-wide like the old
    // client's Mouse: the player keeps facing the pointer while it is over
    // the HUD, a window, or a dragged hotbar item -- and throws that way.
    el.addEventListener('mousemove', this.handleMouseMove);
    el.addEventListener('mousedown', this.handleMouseDown);
    el.addEventListener('mouseup', this.handleMouseUp);
    el.addEventListener('wheel', this.handleWheel, { passive: true });
    el.addEventListener('contextmenu', this.handleContextMenu);

    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', this.handleWindowMouseMove);
      window.addEventListener('mouseup', this.handleMouseUp);
    }
  }

  destroy(): void {
    const el = this.target;
    if (el && el.removeEventListener) {
      el.removeEventListener('mousemove', this.handleMouseMove);
      el.removeEventListener('mousedown', this.handleMouseDown);
      el.removeEventListener('mouseup', this.handleMouseUp);
      el.removeEventListener('wheel', this.handleWheel);
      el.removeEventListener('contextmenu', this.handleContextMenu);
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('mousemove', this.handleWindowMouseMove);
      window.removeEventListener('mouseup', this.handleMouseUp);
    }

    this.downListeners.clear();
    this.upListeners.clear();
    this.moveListeners.clear();
    this.wheelListeners.clear();
  }

  /** Off: buttons and wheel are ignored (the game is not running); the cursor is still tracked. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.releaseButtons();
  }

  /** Forgets every held button, as if all were released (the page lost focus). */
  releaseButtons(): void {
    this.isLeftDown = false;
    this.isRightDown = false;
    this.isMiddleDown = false;
  }

  onDown(listener: MouseButtonListener): () => void {
    this.downListeners.add(listener);
    return () => this.downListeners.delete(listener);
  }

  onUp(listener: MouseButtonListener): () => void {
    this.upListeners.add(listener);
    return () => this.upListeners.delete(listener);
  }

  onMove(listener: MouseMoveListener): () => void {
    this.moveListeners.add(listener);
    return () => this.moveListeners.delete(listener);
  }

  onWheel(listener: MouseWheelListener): () => void {
    this.wheelListeners.add(listener);
    return () => this.wheelListeners.delete(listener);
  }

  getWorldPos(camera: Camera): { x: number; y: number } {
    return camera.screenToWorld(this.screenX, this.screenY);
  }

  /**
   * Angle from world coordinates (e.g. player position) to cursor in world space (radians).
   */
  getAngleFrom(wx: number, wy: number, camera: Camera): number {
    const cursor = this.getWorldPos(camera);
    return angle(wx, wy, cursor.x, cursor.y);
  }
}
