// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/game/aim-controller.ts
// The aim button: AIM to the server while it is held, and how far into the
// aimed view the camera is. The server decides when aiming is active
// (AIM_STATE). On a press the view starts at once when the client expects the
// server to agree, and AIM_STATE corrects it either way.
import type { AimStateEvent, NetEventBus } from '../net/events';

/** How long the camera takes into the aimed view, and back out of it. */
export const AIM_BLEND_MS = 150;
/** A press the server has not answered by now was refused: stop expecting it. */
export const AIM_PREDICT_MS = 300;

export interface AimSocket {
  aim(held: boolean): void;
}

export class AimController {
  /** The button as last sent. */
  held = false;
  /** 0 = hip, 1 = aimed: how far into the aimed view the camera is. */
  blend = 0;
  /** The server's maxViewportX/Y from AIM_STATE; null until the first. */
  viewport: { viewX: number; viewY: number } | null = null;
  private serverActive = false;
  private predictMs = 0;

  constructor(private readonly socket: AimSocket) {}

  /** The right button went down with a gun that can aim; `expectActive` when nothing would stop the server agreeing. */
  press(expectActive: boolean): void {
    if (this.held) return;
    this.held = true;
    this.socket.aim(true);
    this.predictMs = expectActive ? AIM_PREDICT_MS : 0;
  }

  /** The right button came up, or the page lost focus. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    this.socket.aim(false);
    this.predictMs = 0;
  }

  onAimState(e: AimStateEvent): void {
    this.serverActive = e.active;
    this.viewport = { viewX: e.viewX, viewY: e.viewY };
    this.predictMs = 0;
  }

  /** Aimed as far as the view is concerned: the server says so, or a press expects it to. Never once let go. */
  get active(): boolean {
    return this.held && (this.serverActive || this.predictMs > 0);
  }

  update(deltaMs: number): void {
    if (this.predictMs > 0) this.predictMs = Math.max(0, this.predictMs - deltaMs);
    const step = deltaMs / AIM_BLEND_MS;
    this.blend = this.active ? Math.min(1, this.blend + step) : Math.max(0, this.blend - step);
  }

  attachBus(bus: NetEventBus): () => void {
    return bus.on('aimState', (e) => this.onAimState(e));
  }
}
