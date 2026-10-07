// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// AssetLoader: sprite loading, decoding, caching and day/night resolution.
// Nothing hardcodes image paths; sprite names come from
// entry.client and the renderers ask for them by name.
//
// Why it is built this way (measured 2026-09-16): drawing an HTMLImageElement is
// free but its first rasterisation costs 5-20 ms of decode + upload, and with
// every sprite loaded (453 MB decoded) the browser's decode cache thrashes,
// so the same sprites are decoded over and over -- frame stalls of 100-300 ms
// while standing still. So:
//   - images are fetched then decoded OFF the main thread (createImageBitmap)
//     and drawn as ImageBitmaps, which never need re-decoding;
//   - resident bitmaps are held under a memory budget with LRU eviction, and
//     the core set (creatures, effects, resources, badges) is pinned;
//   - requests go through a priority queue with a concurrency cap: a sprite
//     needed on screen now ('high') is never stuck behind hundreds of
//     background loads; predictive warm-ups ('normal') come next; the
//     HTTP-cache trickle ('low') only runs when nothing else is waiting;
//   - the manifest (built from public/img at build time) versions URLs so
//     the host can serve them immutable, and lets us skip names that do not
//     exist instead of 404ing.
import type { ContentStore } from '../content/store';

/** What the renderers draw. `image` is an ImageBitmap where supported. */
export interface Sprite {
  readonly name: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly image: CanvasImageSource;
}

export type LoadPriority = 'high' | 'normal' | 'low';

/** A decoded image plus how to release it. Injected so tests need no browser. */
export interface DecodedImage {
  image: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
}

export interface SpriteDecoder {
  decode(url: string, priority: LoadPriority): Promise<DecodedImage>;
  /** Fetches without decoding so a later load is an HTTP-cache hit. Optional. */
  prefetch?(url: string): Promise<void>;
}

export interface SpriteManifestEntry {
  w: number;
  h: number;
  /** Content hash: appended as `?v=` so the URL can be cached forever. */
  v: string;
}

export type SpriteManifest = Record<string, SpriteManifestEntry>;

export interface AssetStats {
  /** get() calls that returned a sprite / that could not. */
  hits: number;
  misses: number;
  /** Sprites handed out for the first time since they were decoded. */
  firstDraws: number;
  resident: number;
  residentBytes: number;
  inflight: number;
  queued: number;
  failed: number;
  decoded: number;
  decodeMs: number;
  evicted: number;
  /** Background HTTP-cache warm-ups done / still waiting. */
  prefetched: number;
  prefetchQueued: number;
}

export interface AssetLoaderOptions {
  decoder?: SpriteDecoder;
  basePath?: string;
  /** Concurrent decodes for high + normal work. */
  maxInflight?: number;
  /** Concurrent low-priority (background) decodes, only when nothing else waits. */
  maxLowInflight?: number;
  /** Decoded bytes kept resident before LRU eviction kicks in. */
  memoryBudgetBytes?: number;
  /** A sprite used more recently than this is never evicted. */
  idleEvictMs?: number;
}

/**
 * Inventory/UI icons (`client.icon` on items, equipables, etc.) name a sprite
 * *family*, not a file: the old button-state convention only ever shipped
 * `<name>-out.png` / `-in.png` / `-click.png`, never a bare `<name>.png`. The
 * DOM UI only ever shows the idle state, so this resolves straight to `-out`.
 */
export function inventoryIconSprite(iconName: string): string {
  return `${iconName}-out`;
}

/**
 * The DOM UI's icon for a sprite family: the `-out` button with its old frame
 * taken off, built into /icons by tools/assets/item-icons.ts. HUD slots draw
 * their own frame and hover/pressed states, so the in/click variants go unused.
 */
export function itemIconUrl(iconName: string): string {
  return `/icons/${iconName}.png`;
}

/** Highest valid base character skin id; day-skin0.png .. day-skin5.png are the only ones shipped. */
export const MAX_SKIN_ID = 5;

/**
 * Arm sprites are shared by pairs of skins (day-left-arm0/2/4.png only --
 * there is no day-left-arm1/3/5), so skin 1 draws with skin 0's arms, skin 3
 * with skin 2's, etc. Requesting `day-left-arm${skinId}` directly 404s for
 * every odd skin and everything above 5.
 */
export function skinArmIndex(skinId: number): number {
  const clamped = Math.max(0, Math.min(MAX_SKIN_ID, skinId));
  return clamped - (clamped % 2);
}

function nightVariant(name: string): string | undefined {
  return name.startsWith('day-') ? `night-${name.slice(4)}` : undefined;
}

function dayVariant(name: string): string | undefined {
  return name.startsWith('night-') ? `day-${name.slice(6)}` : undefined;
}

const PRIORITY_RANK: Record<LoadPriority, number> = { high: 0, normal: 1, low: 2 };

/**
 * Browser decoder: fetch (with the request priority hint where supported),
 * then createImageBitmap so the PNG is decoded on a worker thread. Falls
 * back to an <img> + decode() where ImageBitmap is unavailable.
 */
export function browserSpriteDecoder(): SpriteDecoder {
  const hasBitmap = typeof createImageBitmap === 'function' && typeof fetch === 'function';
  return {
    async decode(url, priority) {
      if (hasBitmap) {
        const res = await fetch(url, {
          priority: priority === 'high' ? 'high' : priority === 'low' ? 'low' : 'auto',
        } as RequestInit);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        return {
          image: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          close: () => bitmap.close(),
        };
      }
      if (typeof Image === 'undefined')
        throw new Error('No image decoder available in this environment');
      const img = new Image();
      img.src = url;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`Failed to load ${url}`));
      });
      if (typeof img.decode === 'function') await img.decode().catch(() => undefined);
      return { image: img, width: img.naturalWidth, height: img.naturalHeight };
    },
    async prefetch(url) {
      if (typeof fetch !== 'function') return;
      const res = await fetch(url, { priority: 'low' } as RequestInit);
      // The body must be consumed for the response to land in the HTTP cache.
      if (res.ok) await res.arrayBuffer();
    },
  };
}

interface Entry {
  name: string;
  state: 'idle' | 'queued' | 'loading' | 'ready' | 'failed';
  priority: LoadPriority;
  sprite?: Sprite;
  close?: () => void;
  bytes: number;
  lastUse: number;
  pinned: boolean;
  drawn: boolean;
  promise?: Promise<Sprite>;
  resolve?: (s: Sprite) => void;
  reject?: (e: Error) => void;
}

const SWEEP_INTERVAL_MS = 2000;
const RECENT_USE_MS = 30_000;

export class AssetLoader {
  private readonly entries = new Map<string, Entry>();
  private readonly queues: Record<LoadPriority, Entry[]> = { high: [], normal: [], low: [] };
  private readonly decoder: SpriteDecoder;
  private readonly basePath: string;
  private readonly maxInflight: number;
  private readonly maxLowInflight: number;
  private readonly idleEvictMs: number;
  private memoryBudgetBytes: number;
  private manifest?: SpriteManifest;
  private inflightHigh = 0;
  private inflightLow = 0;
  private readonly prefetchQueue: string[] = [];
  private readonly prefetchSeen = new Set<string>();
  private prefetchInflight = 0;
  private clock = 0;
  private lastSweep = 0;

  readonly stats: AssetStats = {
    hits: 0,
    misses: 0,
    firstDraws: 0,
    resident: 0,
    residentBytes: 0,
    inflight: 0,
    queued: 0,
    failed: 0,
    decoded: 0,
    decodeMs: 0,
    evicted: 0,
    prefetched: 0,
    prefetchQueued: 0,
  };

  constructor(options: AssetLoaderOptions = {}) {
    this.decoder = options.decoder ?? browserSpriteDecoder();
    this.basePath = options.basePath ?? '/img/';
    this.maxInflight = options.maxInflight ?? 6;
    this.maxLowInflight = options.maxLowInflight ?? 2;
    this.memoryBudgetBytes = options.memoryBudgetBytes ?? defaultMemoryBudget();
    this.idleEvictMs = options.idleEvictMs ?? 10_000;
  }

  /** Names, sizes and content hashes of every shipped sprite (see tools/assets/sprite-manifest.ts). */
  setManifest(manifest: SpriteManifest): void {
    this.manifest = manifest;
  }

  get hasManifest(): boolean {
    return this.manifest !== undefined;
  }

  setMemoryBudget(bytes: number): void {
    this.memoryBudgetBytes = bytes;
  }

  spriteUrl(name: string): string {
    const v = this.manifest?.[name]?.v;
    return `${this.basePath}${name}.png${v ? `?v=${v}` : ''}`;
  }

  /**
   * Resolves the sprite name based on whether it is night.
   * If isNight is true and name starts with 'day-', converts to 'night-'.
   */
  resolveSpriteName(name: string, isNight = false): string {
    return (isNight && nightVariant(name)) || name;
  }

  /**
   * Synchronously gets a sprite from the cache if available.
   * If isNight is true, tries the night variant first, falling back to day.
   *
   * A sprite nobody has asked for yet starts loading on this first miss (the
   * old client's `loadImage` on draw), at high priority: it is on screen now.
   */
  get(name: string, isNight = false): Sprite | undefined {
    const night = isNight ? nightVariant(name) : undefined;
    if (night) {
      const hit = this.ready(night);
      if (hit) return hit;
      this.request(night, 'high');
    }
    const hit = this.ready(name);
    if (hit) return hit;
    this.request(name, 'high');
    this.stats.misses++;
    return undefined;
  }

  /** True when `get()` would return a sprite right now (no side effects). */
  has(name: string, isNight = false): boolean {
    const night = isNight ? nightVariant(name) : undefined;
    return (
      (night !== undefined && this.entries.get(night)?.state === 'ready') ||
      this.entries.get(name)?.state === 'ready'
    );
  }

  /**
   * Asks for a sprite that will probably be needed soon (an entity the
   * server sent that is still off screen). Queued behind on-screen misses,
   * ahead of the background trickle. Cheap when already resident.
   */
  warm(name: string, isNight = false): void {
    const target = (isNight && nightVariant(name)) || name;
    const e = this.entries.get(target);
    if (e && e.state !== 'idle') return;
    this.request(target, 'normal');
  }

  /** Asynchronously loads a single sprite by name (without .png extension). */
  load(name: string, priority: LoadPriority = 'normal'): Promise<Sprite> {
    const e = this.request(name, priority);
    if (e.state === 'ready' && e.sprite) return Promise.resolve(e.sprite);
    if (e.state === 'failed') return Promise.reject(new Error(`Failed to load sprite: ${name}`));
    return e.promise!;
  }

  /**
   * Loads the sprites every session needs before anything else, and pins
   * them so the memory sweep never evicts them. Resolves when they are all
   * settled (missing ones are tolerated).
   */
  async preloadCore(
    names: Iterable<string>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const list = [...names].filter(Boolean);
    let done = 0;
    await Promise.all(
      list.map((name) => {
        const e = this.request(name, 'high');
        e.pinned = true;
        return this.load(name, 'high')
          .catch(() => undefined)
          .then(() => onProgress?.(++done, list.length));
      }),
    );
  }

  /**
   * Fetches sprites in the background, without decoding, so a later
   * on-demand load is served from the HTTP cache. Two at a time, only while
   * the decode pipeline is idle, and never for anything already known. No
   * decoding: on a two-core machine decoding thousands of PNGs would compete
   * with the game itself.
   */
  warmCache(names: Iterable<string>): void {
    if (!this.decoder.prefetch) return;
    for (const name of names) {
      if (!name || this.prefetchSeen.has(name)) continue;
      if (this.manifest && !this.manifest[name]) continue;
      this.prefetchSeen.add(name);
      this.prefetchQueue.push(name);
    }
    this.stats.prefetchQueued = this.prefetchQueue.length;
    this.pumpPrefetch();
  }

  /**
   * Queues the other palette (night for day, day for night) of every sprite
   * used in the last 30 s so the switch does not pop. Called by the game
   * loop shortly before dusk / dawn.
   */
  warmVariants(isNight: boolean): void {
    for (const e of this.entries.values()) {
      if (e.state !== 'ready' || this.clock - e.lastUse > RECENT_USE_MS) continue;
      const other = isNight ? nightVariant(e.name) : dayVariant(e.name);
      if (other) this.warm(other);
    }
  }

  /**
   * Frame clock for LRU bookkeeping; runs the memory sweep every couple of
   * seconds. `now` is performance.now()-like milliseconds.
   */
  tick(now: number): void {
    this.clock = now;
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    this.sweep();
  }

  /** Releases everything not pinned (leaving the game). */
  releaseUnpinned(): void {
    for (const e of this.entries.values()) {
      if (e.state === 'ready' && !e.pinned) this.evict(e);
    }
  }

  // ---- internals ----------------------------------------------------------------

  private ready(name: string): Sprite | undefined {
    const e = this.entries.get(name);
    if (!e || e.state !== 'ready' || !e.sprite) return undefined;
    e.lastUse = this.clock;
    this.stats.hits++;
    if (!e.drawn) {
      e.drawn = true;
      this.stats.firstDraws++;
    }
    return e.sprite;
  }

  private request(name: string, priority: LoadPriority): Entry {
    let e = this.entries.get(name);
    if (!e) {
      e = {
        name,
        state: 'idle',
        priority,
        bytes: 0,
        lastUse: this.clock,
        pinned: false,
        drawn: false,
      };
      this.entries.set(name, e);
    }
    if (e.state === 'ready' || e.state === 'failed' || e.state === 'loading') {
      return e;
    }
    if (e.state === 'idle') {
      if (this.manifest && !this.manifest[name]) {
        // Known not to exist: fail without a request (was a 404 per draw).
        e.state = 'failed';
        this.stats.failed++;
        return e;
      }
      e.state = 'queued';
      e.priority = priority;
      e.promise = new Promise<Sprite>((resolve, reject) => {
        e!.resolve = resolve;
        e!.reject = reject;
      });
      // Nobody awaiting a warm-up should see an unhandled rejection.
      e.promise.catch(() => undefined);
      this.queues[priority].push(e);
    } else if (PRIORITY_RANK[priority] < PRIORITY_RANK[e.priority]) {
      // Bump: the entry stays in its old queue (skipped there) and joins the new one.
      e.priority = priority;
      this.queues[priority].push(e);
    }
    this.pump();
    return e;
  }

  private pump(): void {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const next = this.dequeue();
      if (!next) break;
      this.start(next);
    }
    this.stats.queued =
      this.queues.high.length + this.queues.normal.length + this.queues.low.length;
    this.stats.inflight = this.inflightHigh + this.inflightLow;
    this.pumpPrefetch();
  }

  private get pipelineIdle(): boolean {
    return (
      this.inflightHigh === 0 && this.queues.high.length === 0 && this.queues.normal.length === 0
    );
  }

  private pumpPrefetch(): void {
    const prefetch = this.decoder.prefetch;
    if (!prefetch) return;
    while (
      this.pipelineIdle &&
      this.prefetchInflight < this.maxLowInflight &&
      this.prefetchQueue.length
    ) {
      const name = this.prefetchQueue.shift()!;
      // Loaded on demand in the meantime: nothing to warm.
      const e = this.entries.get(name);
      if (e && e.state !== 'idle') continue;
      this.prefetchInflight++;
      prefetch
        .call(this.decoder, this.spriteUrl(name))
        .catch(() => undefined)
        .then(() => {
          this.prefetchInflight--;
          this.stats.prefetched++;
          this.stats.prefetchQueued = this.prefetchQueue.length;
          this.pumpPrefetch();
        });
    }
    this.stats.prefetchQueued = this.prefetchQueue.length;
  }

  private dequeue(): Entry | undefined {
    // Stale queue entries (bumped to a higher queue, or already started) are
    // skipped: the entry's own `priority` says which queue really owns it.
    const take = (priority: LoadPriority): Entry | undefined => {
      const q = this.queues[priority];
      while (q.length) {
        const e = q.shift()!;
        if (e.state === 'queued' && e.priority === priority) return e;
      }
      return undefined;
    };
    if (this.inflightHigh < this.maxInflight) {
      const e = take('high') ?? take('normal');
      if (e) return e;
    }
    // Low work only runs on an idle pipeline: HTTP/1.1 gives six
    // connections per host and none of them should be busy with a
    // background sprite when an on-screen one is waiting.
    if (this.pipelineIdle && this.inflightLow < this.maxLowInflight) {
      return take('low');
    }
    return undefined;
  }

  private start(e: Entry): void {
    e.state = 'loading';
    const low = e.priority === 'low';
    if (low) this.inflightLow++;
    else this.inflightHigh++;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    this.decoder
      .decode(this.spriteUrl(e.name), e.priority)
      .then(
        (decoded) => {
          this.stats.decoded++;
          this.stats.decodeMs += (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
          e.sprite = {
            name: e.name,
            naturalWidth: decoded.width,
            naturalHeight: decoded.height,
            image: decoded.image,
          };
          e.close = decoded.close;
          e.bytes = decoded.width * decoded.height * 4;
          e.state = 'ready';
          e.lastUse = this.clock;
          this.stats.resident++;
          this.stats.residentBytes += e.bytes;
          e.resolve?.(e.sprite);
        },
        (err: unknown) => {
          e.state = 'failed';
          this.stats.failed++;
          e.reject?.(err instanceof Error ? err : new Error(String(err)));
        },
      )
      .finally(() => {
        if (low) this.inflightLow--;
        else this.inflightHigh--;
        e.resolve = undefined;
        e.reject = undefined;
        this.pump();
      });
  }

  private sweep(): void {
    if (this.stats.residentBytes <= this.memoryBudgetBytes) return;
    const candidates: Entry[] = [];
    for (const e of this.entries.values()) {
      if (e.state === 'ready' && !e.pinned && this.clock - e.lastUse >= this.idleEvictMs)
        candidates.push(e);
    }
    candidates.sort((a, b) => a.lastUse - b.lastUse);
    // Free down to 80% of the budget so the sweep is not back every 2 s.
    const target = this.memoryBudgetBytes * 0.8;
    for (const e of candidates) {
      if (this.stats.residentBytes <= target) break;
      this.evict(e);
    }
  }

  private evict(e: Entry): void {
    e.close?.();
    e.close = undefined;
    e.sprite = undefined;
    e.promise = undefined;
    e.state = 'idle';
    e.drawn = false;
    this.stats.resident--;
    this.stats.residentBytes -= e.bytes;
    this.stats.evicted++;
    e.bytes = 0;
  }

  // ---- content-driven name collection -------------------------------------------

  /**
   * The sprites every session draws within seconds of joining: characters
   * and their effects, world resources, agents, the interaction badges and
   * the minimap / leaderboard icons. Loaded up front and pinned; everything
   * else (building frames, loot, held items, wearables) streams in on demand
   * and via predictive warm-ups.
   */
  static collectCoreSpriteNames(store: ContentStore): Set<string> {
    const names = new Set<string>();

    // Base skin & arm sprites. Arm sprites are shared by pairs of skins -- see skinArmIndex.
    for (let skin = 0; skin <= MAX_SKIN_ID; skin++) {
      names.add(`day-skin${skin}`);
      const armIndex = skinArmIndex(skin);
      names.add(`day-left-arm${armIndex}`);
      names.add(`day-right-arm${armIndex}`);
    }

    // Common UI/game sprites
    names.add('day-dead-player');
    names.add('arrow-minimap');
    names.add('arrow-minimap2');
    names.add('house-icon');
    names.add('city-icon');
    // Leaderboard karma badges and the over-head gauge alert bubbles
    // (alert{type}_{level}: type 0 health / 1 hunger / 2 cold / 3 radiation).
    for (let i = 0; i <= 5; i++) names.add(`karma${i}`);
    for (let type = 0; type < 4; type++)
      for (let level = 0; level < 3; level++) names.add(`alert${type}_${level}`);

    // Character effects: hurt/heal/eat overlays, sprint dust, muzzle flashes.
    names.add('hurt-player');
    names.add('heal-player');
    names.add('food-player');
    names.add('day-run-effect');
    for (let i = 0; i < 3; i++) names.add(`day-gun-effect${i}`);
    for (let i = 0; i < 5; i++) names.add(`day-laser-effect${i}`);

    // Projectiles and explosions (render/renderer.ts resolveEntitySprite).
    if (store.has('projectiles')) {
      for (const proj of Object.values(store.table('projectiles'))) {
        for (const frame of proj.client?.frame ?? []) {
          if (frame.sprite) names.add(frame.sprite);
        }
      }
    } else {
      names.add('day-bullet1');
    }
    for (let i = 0; i < 10; i++) names.add(`day-explosion${i}`);

    // Resources: the world is full of them from the first frame.
    if (store.has('resources')) {
      for (const res of Object.values(store.table('resources'))) {
        const client = res.client as Record<string, unknown> | undefined;
        const types = client?.type as Array<{ sprite?: string }> | undefined;
        if (!Array.isArray(types)) continue;
        for (const t of types) if (t.sprite) names.add(t.sprite);
      }
    }

    // Building effects shared by every lit campfire / busy container, and the
    // interaction badges (render/interact-prompt.ts).
    for (const name of [
      'day-campfire-light-1',
      'day-campfire-light-2',
      'day-campfire-light-3',
      'day-campfire-light-down',
      'day-unusable',
      'loot',
      'loot2',
      'timer',
      'timer-arrow',
      'timer-lights',
      'wrong-tool',
      'hand-tool',
      'hint-rotate',
      'craft-grid',
      // The E badge over an NPC in talking range (input-manager.ts).
      'e-npc',
    ]) {
      names.add(name);
    }

    // Agents (ghouls, bots)
    if (store.has('agents')) {
      for (const agent of Object.values(store.table('agents'))) {
        const client = agent.client as Record<string, unknown> | undefined;
        if (!client) continue;
        for (const key of ['head', 'death', 'hurt'] as const) {
          if (typeof client[key] === 'string') names.add(client[key] as string);
        }
        for (const key of ['leftArm', 'rightArm'] as const) {
          const limb = client[key] as { sprite?: string } | undefined;
          if (limb?.sprite) names.add(limb.sprite);
        }
      }
    }

    return names;
  }

  /**
   * Collects every presentation sprite name from the content tables: the
   * core set plus loot, icons, held items, wearables and every building
   * frame. Used for the background HTTP-cache trickle and by tests.
   */
  static collectSpriteNames(store: ContentStore): Set<string> {
    const names = AssetLoader.collectCoreSpriteNames(store);

    // Items (loot sprites & icons)
    if (store.has('items')) {
      const items = store.table('items');
      for (const item of Object.values(items)) {
        const client = item.client as Record<string, unknown> | undefined;
        if (!client) continue;
        if (typeof client.icon === 'string') names.add(inventoryIconSprite(client.icon));
        const loots = client.loot as Array<{ sprite?: string }> | undefined;
        if (Array.isArray(loots)) {
          for (const l of loots) {
            if (l.sprite) names.add(l.sprite);
          }
        }
      }
    }

    // Equipables (held weapons & arms)
    if (store.has('equipables')) {
      const equipables = store.table('equipables');
      for (const eq of Object.values(equipables)) {
        const client = eq.client as Record<string, unknown> | undefined;
        if (!client) continue;
        const held = client.held as { sprite?: string } | undefined;
        if (held?.sprite) names.add(held.sprite);
        const projectileHeld = client.projectileHeld as { sprite?: string } | undefined;
        if (projectileHeld?.sprite) names.add(projectileHeld.sprite);
        const leftArm = client.leftArm as { sprite?: string } | undefined;
        if (leftArm?.sprite) names.add(leftArm.sprite);
        const rightArm = client.rightArm as { sprite?: string } | undefined;
        if (rightArm?.sprite) names.add(rightArm.sprite);
        for (const key of ['cartridge', 'blueprint', 'pencil'] as const) {
          if (typeof client[key] === 'string') names.add(client[key] as string);
        }
      }
    }

    // Wearables (head, leftArm, rightArm)
    if (store.has('wearables')) {
      const wearables = store.table('wearables');
      for (const w of Object.values(wearables)) {
        const client = w.client as Record<string, unknown> | undefined;
        if (!client) continue;
        if (typeof client.head === 'string') names.add(client.head);
        if (typeof client.leftArm === 'string') names.add(client.leftArm);
        if (typeof client.rightArm === 'string') names.add(client.rightArm);
      }
    }

    // Objects and furniture: blueprints plus every frame list a building
    // renderer can pick from (autotile frames, broken stages, lamp colours,
    // road variants, spike covers...).
    for (const tableName of ['objects', 'furnitures'] as const) {
      if (!store.has(tableName)) continue;
      for (const obj of Object.values(store.table(tableName))) {
        const client = obj.client as Record<string, unknown> | undefined;
        if (!client) continue;
        for (const key of [
          'blueprint',
          'redprint',
          'sprite',
          'builder',
          'interact',
          'interactClose',
        ] as const) {
          if (typeof client[key] === 'string') names.add(client[key] as string);
        }
        for (const key of [
          'frame',
          'broken',
          'hidden',
          'deployed',
          'on',
          'top',
          'light',
          'variant',
        ] as const) {
          const list = client[key];
          if (!Array.isArray(list)) continue;
          for (const f of list as { sprite?: string }[]) {
            if (f?.sprite) names.add(f.sprite);
          }
        }
      }
    }

    return names;
  }
}

/** Decoded-bytes budget: a quarter of device memory, clamped to 128-384 MB. */
function defaultMemoryBudget(): number {
  const gb =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
      : undefined;
  const mb = gb ? Math.round(gb * 1024 * 0.25) : 256;
  return Math.max(128, Math.min(384, mb)) * 1024 * 1024;
}
