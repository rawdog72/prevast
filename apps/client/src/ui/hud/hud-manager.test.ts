// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetLoader } from '../../assets/asset-loader';
import { ContentStore } from '../../content/store';
import { ClanStore } from '../../world/clan-store';
import { InventoryStore } from '../../world/inventory-store';
import { WorldState, newPlayerInfo } from '../../world/world-state';
import { HudManager } from './hud-manager';

function createMockCanvasContext(): CanvasRenderingContext2D {
  return {
    setTransform: () => {},
    clearRect: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    rect: () => {},
    clip: () => {},
    fillRect: () => {},
    fillText: () => {},
    drawImage: () => {},
    translate: () => {},
    rotate: () => {},
    setLineDash: () => {},
    font: '',
    textAlign: '',
    textBaseline: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
}

function buildHudDom(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="hud-controls"></div>
    <div class="hud-alerts"></div>
    <div class="hud-invitation" hidden></div>
    <div class="hud-topright">
      <canvas class="hud-minimap" width="120" height="120"></canvas>
      <div class="hud-leaderboard"></div>
    </div>
    <div class="hud-chat"></div>
    <div class="hud-gauges"></div>
    <div class="hud-hotbar"></div>
  `;
  return root;
}

describe('HudManager', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      createMockCanvasContext() as unknown as RenderingContext,
    );
  });

  it('mounts every HUD region and updates without throwing', () => {
    const root = buildHudDom();
    const hud = new HudManager();
    const world = new WorldState();
    const inventory = new InventoryStore();
    const content = new ContentStore();
    const assets = new AssetLoader();

    inventory.setSlot(0, { iid: 1, count: 25 });
    world.players.set(1, {
      ...newPlayerInfo(1, 'Survivor'),
      score: 350,
    });
    world.leaderboard = [{ guid: 1, karma: 0, score: 350 }];

    expect(() =>
      hud.mount(
        root,
        () => {},
        () => {},
      ),
    ).not.toThrow();
    expect(() =>
      hud.update({
        world,
        inventory,
        clans: new ClanStore(world),
        content,
        assets,
      }),
    ).not.toThrow();

    // Hotbar reflects the equipped count, leaderboard reflects the server's list.
    expect(root.querySelector('.hud-slot .hud-slot-count')?.textContent).toBe('25');
    expect(root.querySelector('.hud-leaderboard-row .name')?.textContent).toContain('Survivor');
  });

  it('puts the bag into the bottom-right corner cell when the DOM has one', () => {
    const root = buildHudDom();
    const corner = document.createElement('div');
    corner.className = 'hud-bag-corner';
    root.appendChild(corner);
    const hud = new HudManager();
    hud.mount(
      root,
      () => {},
      () => {},
    );
    expect(corner.querySelector('.hud-bag')).not.toBeNull();
    expect(root.querySelector('.hud-hotbar .hud-bag')).toBeNull();
  });

  it('builds the chat console (tabs, log, input) inside .hud-chat', () => {
    const root = buildHudDom();
    const hud = new HudManager();
    hud.mount(
      root,
      () => {},
      () => {},
    );
    const chat = root.querySelector('.hud-chat')!;
    expect(chat.classList.contains('hud-chat-console')).toBe(true);
    expect(chat.querySelector('.hud-chat-tabs')).not.toBeNull();
    expect(chat.querySelector('.hud-chat-log')).not.toBeNull();
    expect(chat.querySelector('input.hud-chat-input')).not.toBeNull();
  });
});
