// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTENT_TABLES, type ContentTable } from '../../../../shared/typescript/content-format';
import { ContentStore } from '../content/store';
import { AssetLoader, skinArmIndex, type DecodedImage, type SpriteDecoder } from './asset-loader';

/**
 * A decoder that resolves by hand: `finish(name)` completes a request in
 * whatever order the test wants, so queue ordering and eviction are observable.
 */
function manualDecoder(size = 100) {
  const pending = new Map<
    string,
    { resolve: (d: DecodedImage) => void; reject: (e: Error) => void }
  >();
  const started: string[] = [];
  const closed: string[] = [];
  const decoder: SpriteDecoder = {
    decode(url) {
      const name = url.replace(/^.*\/img\//, '').replace(/\.png.*$/, '');
      started.push(name);
      return new Promise<DecodedImage>((resolve, reject) => pending.set(name, { resolve, reject }));
    },
  };
  return {
    decoder,
    started,
    closed,
    pending,
    finish(name: string, w = size, h = size) {
      const p = pending.get(name);
      if (!p) throw new Error(`not started: ${name}`);
      pending.delete(name);
      p.resolve({
        image: { tag: name } as unknown as CanvasImageSource,
        width: w,
        height: h,
        close: () => closed.push(name),
      });
    },
    fail(name: string) {
      const p = pending.get(name);
      if (!p) throw new Error(`not started: ${name}`);
      pending.delete(name);
      p.reject(new Error('404'));
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function fixture(name: string): ContentTable {
  return JSON.parse(readFileSync(`tests/fixtures/content/${name}.json`, 'utf8')) as ContentTable;
}

function contentStore(): ContentStore {
  const store = new ContentStore();
  for (const name of CONTENT_TABLES) store.load(fixture(name));
  return store;
}

describe('AssetLoader', () => {
  it('resolves day and night sprite names accurately', () => {
    const loader = new AssetLoader({ decoder: manualDecoder().decoder });
    expect(loader.resolveSpriteName('day-wood1', false)).toBe('day-wood1');
    expect(loader.resolveSpriteName('day-wood1', true)).toBe('night-wood1');
    expect(loader.resolveSpriteName('inv-wood', true)).toBe('inv-wood');
  });

  it('loads through the decoder, dedupes in-flight requests and hands out the decoded sprite', async () => {
    const d = manualDecoder();
    const loader = new AssetLoader({ decoder: d.decoder });
    const p1 = loader.load('day-wood1');
    const p2 = loader.load('day-wood1');
    expect(p1).toBe(p2);
    expect(d.started).toEqual(['day-wood1']);

    d.finish('day-wood1', 200, 120);
    const sprite = await p1;
    expect(sprite.naturalWidth).toBe(200);
    expect(sprite.naturalHeight).toBe(120);
    expect(loader.get('day-wood1')).toBe(sprite);
    expect(loader.stats.resident).toBe(1);
    expect(loader.stats.residentBytes).toBe(200 * 120 * 4);
  });

  it('falls back to the day variant while the night one is still loading', async () => {
    const d = manualDecoder();
    const loader = new AssetLoader({ decoder: d.decoder });
    const dayP = loader.load('day-wood1');
    d.finish('day-wood1');
    const day = await dayP;

    expect(loader.get('day-wood1', true)).toBe(day);
    expect(d.started).toContain('night-wood1'); // the miss started the night variant
    d.finish('night-wood1');
    await flush();
    expect(loader.get('day-wood1', true)).not.toBe(day);
    expect(loader.get('day-wood1', false)).toBe(day);
  });

  it('starts loading a sprite the first time get() misses, at high priority ahead of queued work', async () => {
    const d = manualDecoder();
    const loader = new AssetLoader({ decoder: d.decoder, maxInflight: 1 });
    void loader.load('day-a', 'normal');
    void loader.load('day-b', 'normal');
    expect(d.started).toEqual(['day-a']); // one slot, taken by the first request
    expect(loader.get('day-urgent')).toBeUndefined();
    expect(loader.stats.misses).toBe(1);
    d.finish('day-a');
    await flush();
    // The visible-now miss jumps the queue: it starts before the earlier 'normal' request.
    expect(d.started).toEqual(['day-a', 'day-urgent']);
    d.finish('day-urgent');
    await flush();
    expect(loader.get('day-urgent')).toBeDefined();
    expect(d.started).toEqual(['day-a', 'day-urgent', 'day-b']);
  });

  it('warm() queues at normal priority without counting as a miss and is a no-op for known sprites', async () => {
    const d = manualDecoder();
    const loader = new AssetLoader({ decoder: d.decoder });
    loader.warm('day-x');
    loader.warm('day-x');
    expect(d.started).toEqual(['day-x']);
    expect(loader.stats.misses).toBe(0);
    d.finish('day-x');
    await flush();
    loader.warm('day-x');
    expect(d.started).toEqual(['day-x']);
  });

  it('warm() with isNight requests the night variant', () => {
    const d = manualDecoder();
    const loader = new AssetLoader({ decoder: d.decoder });
    loader.warm('day-x', true);
    expect(d.started).toEqual(['night-x']);
  });

  it('respects the concurrency limit and keeps low-priority work to a trickle behind everything else', async () => {
    const d = manualDecoder();
    const loader = new AssetLoader({ decoder: d.decoder, maxInflight: 2, maxLowInflight: 1 });
    void loader.load('day-n1', 'normal');
    void loader.load('day-n2', 'normal');
    void loader.load('day-n3', 'normal');
    void loader.load('day-l1', 'low');
    void loader.load('day-l2', 'low');
    // Normal work fills both slots; low never starts while anything higher is queued.
    expect(d.started).toEqual(['day-n1', 'day-n2']);
    d.finish('day-n1');
    await flush();
    expect(d.started).toEqual(['day-n1', 'day-n2', 'day-n3']);
    d.finish('day-n2');
    d.finish('day-n3');
    await flush();
    // Only one low-priority request at a time.
    expect(d.started).toEqual(['day-n1', 'day-n2', 'day-n3', 'day-l1']);
    expect(loader.stats.queued).toBe(1);
  });

  it('records failures, never retries them, and keeps get() cheap for them', async () => {
    const d = manualDecoder();
    const loader = new AssetLoader({ decoder: d.decoder });
    const p = loader.load('day-missing').catch(() => 'failed');
    d.fail('day-missing');
    expect(await p).toBe('failed');
    expect(loader.get('day-missing')).toBeUndefined();
    expect(d.started).toEqual(['day-missing']);
    expect(loader.stats.failed).toBe(1);
  });

  it('skips names the manifest does not list instead of requesting a 404', () => {
    const d = manualDecoder();
    const loader = new AssetLoader({ decoder: d.decoder });
    loader.setManifest({ 'day-wood1': { w: 10, h: 10, v: 'abc' } });
    expect(loader.get('day-nope')).toBeUndefined();
    void loader.load('day-wood1');
    expect(d.started).toEqual(['day-wood1']);
    expect(loader.stats.failed).toBe(1);
  });

  it('versions URLs from the manifest so they can be cached immutably', async () => {
    const urls: string[] = [];
    const decoder: SpriteDecoder = {
      decode: async (url) => {
        urls.push(url);
        return { image: {} as CanvasImageSource, width: 1, height: 1 };
      },
    };
    const loader = new AssetLoader({ decoder, basePath: '/img/' });
    loader.setManifest({ 'day-wood1': { w: 10, h: 10, v: 'c0ffee' } });
    await loader.load('day-wood1');
    expect(urls).toEqual(['/img/day-wood1.png?v=c0ffee']);
  });

  it('evicts the least recently used unpinned sprites once over the memory budget, never recent or pinned ones', async () => {
    const d = manualDecoder();
    // Each 100x100 sprite is 40,000 bytes; budget for two and a half.
    const loader = new AssetLoader({
      decoder: d.decoder,
      memoryBudgetBytes: 100_000,
      idleEvictMs: 1000,
    });
    loader.tick(0);
    const core = loader.preloadCore(['day-core']);
    d.finish('day-core');
    await core;
    for (const n of ['day-a', 'day-b', 'day-c']) {
      void loader.load(n);
      d.finish(n);
    }
    await flush();
    expect(loader.stats.residentBytes).toBe(160_000);

    loader.tick(1000);
    loader.get('day-a'); // used at t=1000
    loader.tick(1500);
    loader.get('day-c'); // used at t=1500
    loader.tick(5000); // sweep: over budget; oldest first -> b, then a; c survives because the budget is met
    expect(d.closed).toEqual(['day-b', 'day-a']);
    expect(d.closed).not.toContain('day-core'); // pinned
    expect(loader.stats.residentBytes).toBeLessThanOrEqual(100_000);
    // An evicted sprite reloads on demand.
    expect(loader.get('day-b')).toBeUndefined();
    expect(d.started.filter((n) => n === 'day-b')).toHaveLength(2);
  });

  it('warms the other palette for every sprite used recently', async () => {
    const d = manualDecoder();
    const loader = new AssetLoader({ decoder: d.decoder });
    loader.tick(0);
    for (const n of ['day-tree', 'day-rock', 'karma0']) {
      void loader.load(n);
      d.finish(n);
    }
    await flush();
    loader.tick(60_000); // long enough ago that merely having been loaded no longer counts as recent use
    loader.get('day-tree');
    loader.get('karma0');
    loader.warmVariants(true);
    expect(d.started).toEqual(['day-tree', 'day-rock', 'karma0', 'night-tree']);
  });

  it('collects the core set: creatures, effects, UI badges, resources and agents, but not building frames', () => {
    const core = AssetLoader.collectCoreSpriteNames(contentStore());
    expect(core.has('day-skin0')).toBe(true);
    expect(core.has('day-left-arm0')).toBe(true);
    expect(core.has('day-wood1')).toBe(true);
    expect(core.has('day-ghoul')).toBe(true);
    expect(core.has('day-run-effect')).toBe(true);
    expect(core.has('day-bullet1')).toBe(true);
    expect(core.has('karma0')).toBe(true);
    expect(core.has('day-wood-wall12')).toBe(false);
    expect(core.has('day-sofa1')).toBe(false);
    expect(core.size).toBeLessThan(200);
  });

  it('collects real sprite names from ContentStore tables without hardcoding', () => {
    const sprites = AssetLoader.collectSpriteNames(contentStore());
    expect(sprites.size).toBeGreaterThan(100);
    expect(sprites.has('day-wood1')).toBe(true);
    expect(sprites.has('day-ground-wood0')).toBe(true);
    expect(sprites.has('day-headscarf')).toBe(true);
    expect(sprites.has('day-stone-pickaxe')).toBe(true);
    expect(sprites.has('day-ghoul')).toBe(true);
    // Building frames (autotile walls, floors, broken stages, lamp colours, roads).
    expect(sprites.has('day-wood-wall12')).toBe(true);
    expect(sprites.has('day-wood-wall-broken1')).toBe(true);
    expect(sprites.has('day-lamp-light-green')).toBe(true);
    expect(sprites.has('day-road3')).toBe(true);
    expect(sprites.has('day-sofa1')).toBe(true);
    expect(sprites.has('day-campfire-light-1')).toBe(true);

    // Regression: only day-left/right-arm{0,2,4}.png actually ship (arms are
    // shared by pairs of skins) and only skin0..5.png exist. Preloading
    // day-skin6..15 / day-left-arm1,3,5,6..15 was 72 guaranteed 404s per load.
    for (const armIndex of [0, 2, 4]) {
      expect(sprites.has(`day-left-arm${armIndex}`)).toBe(true);
      expect(sprites.has(`day-right-arm${armIndex}`)).toBe(true);
    }
    for (const badIndex of [1, 3, 5, 6, 7, 15]) {
      expect(sprites.has(`day-left-arm${badIndex}`)).toBe(false);
      expect(sprites.has(`day-right-arm${badIndex}`)).toBe(false);
    }
    for (const badSkin of [6, 7, 15]) {
      expect(sprites.has(`day-skin${badSkin}`)).toBe(false);
    }
  });

  it('skinArmIndex pairs odd skins with the preceding even skin’s arm sprite', () => {
    expect(skinArmIndex(0)).toBe(0);
    expect(skinArmIndex(1)).toBe(0);
    expect(skinArmIndex(2)).toBe(2);
    expect(skinArmIndex(3)).toBe(2);
    expect(skinArmIndex(4)).toBe(4);
    expect(skinArmIndex(5)).toBe(4);
    // Out-of-range ids clamp instead of naming a file that was never shipped.
    expect(skinArmIndex(9)).toBe(4);
    expect(skinArmIndex(-1)).toBe(0);
  });
});

describe('AssetLoader background prefetch', () => {
  it('warms the HTTP cache two at a time only while the decode pipeline is idle, without decoding', async () => {
    const started: string[] = [];
    const prefetched: string[] = [];
    let release: (() => void)[] = [];
    const decoder: SpriteDecoder = {
      decode: (url) => {
        started.push(url);
        return new Promise<DecodedImage>((resolve) =>
          release.push(() => resolve({ image: {} as CanvasImageSource, width: 1, height: 1 })),
        );
      },
      prefetch: async (url) => {
        prefetched.push(url);
      },
    };
    const loader = new AssetLoader({ decoder, maxLowInflight: 2 });
    void loader.load('day-needed');
    loader.warmCache(['day-x', 'day-y', 'day-z', 'day-x']);
    expect(prefetched).toEqual([]); // pipeline busy
    expect(loader.stats.prefetchQueued).toBe(3);
    release.forEach((r) => r());
    release = [];
    await new Promise((r) => setTimeout(r, 0));
    expect(prefetched).toEqual(['/img/day-x.png', '/img/day-y.png', '/img/day-z.png']);
    expect(started).toEqual(['/img/day-needed.png']); // nothing decoded by the trickle
    expect(loader.get('day-x')).toBeUndefined(); // still loads (from cache) on demand
    expect(started).toContain('/img/day-x.png');
  });
});
