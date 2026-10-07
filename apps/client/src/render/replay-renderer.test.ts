// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Replay integration test verifying that real server frames populate WorldState
// and render cleanly through GameRenderer.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTENT_TABLES, type ContentTable } from '../../../../shared/typescript/content-format';
import { AssetLoader } from '../assets/asset-loader';
import { ContentStore } from '../content/store';
import { Camera } from '../core/camera';
import { unwrapBatch } from '../net/batch';
import { dispatchServerMessage } from '../net/dispatcher';
import { NetEventBus } from '../net/events';
import { WorldState } from '../world/world-state';
import { GameRenderer } from './renderer';

function fixture(name: string): ContentTable {
  return JSON.parse(readFileSync(`tests/fixtures/content/${name}.json`, 'utf8')) as ContentTable;
}

function createMockContext(): {
  ctx: CanvasRenderingContext2D;
  calls: { saves: number; restores: number; images: number; rects: number };
} {
  const calls = { saves: 0, restores: 0, images: 0, rects: 0 };
  const ctx: Partial<CanvasRenderingContext2D> = {
    save: () => {
      calls.saves++;
    },
    restore: () => {
      calls.restores++;
    },
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    fillRect: () => {
      calls.rects++;
    },
    strokeRect: () => {
      calls.rects++;
    },
    fillText: () => {},
    strokeText: () => {},
    drawImage: () => {
      calls.images++;
    },
    createRadialGradient: () =>
      ({
        addColorStop: () => {},
      }) as unknown as CanvasGradient,
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('Replay -> World -> Renderer Integration', () => {
  it('decodes real captured frames into WorldState and renders without error', () => {
    // 1. Content
    const store = new ContentStore();
    for (const name of CONTENT_TABLES) store.load(fixture(name));

    // 2. World & Network
    const bus = new NetEventBus();
    const world = new WorldState();
    world.attachBus(bus);

    // 3. Load real captured server frames
    const bin = readFileSync('tests/fixtures/net/login-and-ticks.bin');
    let offset = 0;
    let framesReplayed = 0;

    let messagesProcessed = 0;
    while (offset + 4 <= bin.length) {
      const frameLen = bin.readUInt32LE(offset);
      offset += 4;
      const frameBytes = bin.subarray(offset, offset + frameLen);
      offset += frameLen;

      const messages = unwrapBatch(frameBytes);
      for (const msg of messages) {
        dispatchServerMessage(msg, bus);
        messagesProcessed++;
      }
      framesReplayed++;
    }

    expect(framesReplayed).toBeGreaterThan(0);
    expect(messagesProcessed).toBeGreaterThan(10);
    expect(world.ownGuid).toBeGreaterThanOrEqual(0);
    expect(world.entities.count).toBeGreaterThan(0);

    // Verify local player entity is in the world
    const localEntity = world.getLocalEntity();
    expect(localEntity).toBeDefined();

    // 4. Render the world
    const camera = new Camera({ viewportWidth: 1280, viewportHeight: 720 });
    camera.update(localEntity!.x, localEntity!.y);

    const assets = new AssetLoader();
    const renderer = new GameRenderer();
    const { ctx, calls } = createMockContext();

    renderer.render({ ctx, camera, world, content: store, assets });

    expect(calls.saves).toBeGreaterThan(0);
    expect(calls.saves).toBe(calls.restores);
    expect(calls.rects).toBeGreaterThan(0);
  });
});
