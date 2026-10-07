// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_TABLES, type ContentTable } from '../../../../shared/typescript/content-format';
import { AssetLoader } from '../assets/asset-loader';
import { ContentStore } from '../content/store';
import { ProjectDb } from './storage/project-db';
import { WorldEditor } from './world-editor';

function fakeContext(): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = {};
  return new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'createImageData')
        return (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
      if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (key === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function loadContent(): ContentStore {
  const store = new ContentStore();
  store.loadAll(
    CONTENT_TABLES.map((name) => JSON.parse(readFileSync(`tests/fixtures/content/${name}.json`, 'utf8')) as ContentTable),
  );
  return store;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// The controller's internals, for driving it without a real browser.
interface Internals {
  session: {
    store: import('./document/store').DocumentStore;
    ctx: import('./editor-context').EditorContext;
  } | null;
  camera: import('../core/camera').Camera;
  canvas: HTMLCanvasElement;
  titleInput: HTMLInputElement;
  tool: { id: string };
  pickEntry(entry: unknown): void;
  tick(delta: number, now: number): void;
  save(): Promise<boolean>;
}

function pointer(canvas: HTMLCanvasElement, type: string, x: number, y: number, extra: MouseEventInit = {}): void {
  canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, ...extra }));
}

describe('WorldEditor', () => {
  const content = loadContent();

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext() as never);
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
    HTMLElement.prototype.releasePointerCapture ??= () => {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    localStorage.clear();
  });

  async function openNew(db = new ProjectDb(`t${Math.random()}`, new IDBFactory())) {
    const onExit = vi.fn();
    const editor = new WorldEditor({ content, assets: new AssetLoader(), onExit, db });
    editor.start();
    for (let i = 0; i < 20 && !document.querySelector('.we-dialog form'); i++) await flush();
    const form = document.querySelector<HTMLFormElement>('.we-dialog form');
    expect(form).not.toBeNull();
    form!.dispatchEvent(new Event('submit', { cancelable: true }));
    const internals = editor as unknown as Internals;
    for (let i = 0; i < 20 && !internals.session; i++) await flush();
    expect(internals.session).not.toBeNull();
    // A known view: screen (0, 0) is world (0, 0) at 100 % zoom.
    internals.camera.setViewport(800, 600);
    internals.camera.setZoom(1);
    internals.camera.x = 400;
    internals.camera.y = 300;
    return { editor, internals, onExit, db };
  }

  it('paints a wall stroke as one undoable step and renders it', async () => {
    const { editor, internals } = await openNew();
    const s = internals.session!;
    internals.pickEntry(s.ctx.catalog.get('object:wood_wall'));
    expect(internals.tool.id).toBe('place');
    pointer(internals.canvas, 'pointerdown', 150, 150);
    pointer(internals.canvas, 'pointermove', 350, 150);
    pointer(internals.canvas, 'pointermove', 550, 150);
    pointer(internals.canvas, 'pointerup', 550, 150);
    expect(s.store.entities.size).toBe(5);
    internals.tick(16, 16);
    expect(s.store.undo()).toBe(true);
    expect(s.store.entities.size).toBe(0);
    s.store.redo();
    internals.tick(16, 32);
    // Zoomed far out the overview path renders instead of sprites.
    internals.camera.setZoom(0.02);
    internals.tick(16, 48);
    editor.stop();
  });

  it('keeps keyboard input in text fields away from the canvas', async () => {
    const { editor, internals } = await openNew();
    const s = internals.session!;
    internals.pickEntry(s.ctx.catalog.get('object:wood_wall'));
    pointer(internals.canvas, 'pointerdown', 150, 150);
    pointer(internals.canvas, 'pointerup', 150, 150);
    s.ctx.selection.set([...s.store.entities.keys()]);
    internals.titleInput.focus();
    internals.titleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    internals.titleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    expect(s.store.entities.size).toBe(1);
    expect(internals.tool.id).toBe('place');
    internals.canvas.focus();
    internals.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true }));
    expect(internals.tool.id).toBe('select');
    editor.stop();
  });

  it('saves revisions and reopens them with identities intact', async () => {
    const db = new ProjectDb('reopen', new IDBFactory());
    const { editor, internals } = await openNew(db);
    const s = internals.session!;
    internals.pickEntry(s.ctx.catalog.get('object:wood_wall'));
    pointer(internals.canvas, 'pointerdown', 150, 150);
    pointer(internals.canvas, 'pointerup', 150, 150);
    const [id] = [...s.store.entities.keys()];
    expect(await internals.save()).toBe(true);
    expect(s.store.dirty).toBe(false);
    const stored = await db.load(s.store.projectId);
    expect(stored?.revision).toBe(1);
    expect(stored?.project.entities.map((e) => e.id)).toEqual([id]);
    editor.stop();
  });

  it('authors loadouts, container loot and spawners through the inspector', async () => {
    const { editor, internals } = await openNew();
    const s = internals.session!;
    const { store } = s;
    store.transact('setup', () => {
      store.put('entity', { id: 'sp', kind: 'spawn', ref: 'player', x: 550, y: 550 });
      store.put('entity', { id: 'ch', kind: 'object', ref: 'wood_chest', x: 750, y: 750 });
      store.put('region', { id: 'rg', name: 'Pen', priority: 0, shape: { type: 'circle', x: 1500, y: 1500, r: 300 } });
    });
    const inspector = () => document.querySelector('.we-inspector')!;
    const show = (ids: string[]) => {
      s.ctx.selection.set(ids);
      internals.tick(16, performance.now());
    };
    const change = (key: string, value: string) => {
      const el = inspector().querySelector<HTMLInputElement | HTMLSelectElement>(`[data-key="${key}"]`);
      expect(el, key).not.toBeNull();
      el!.value = value;
      el!.dispatchEvent(new Event('change'));
      internals.tick(16, performance.now());
    };
    const click = (label: string) => {
      const b = [...inspector().querySelectorAll('button')].find((x) => x.textContent === label);
      expect(b, label).toBeDefined();
      b!.click();
      internals.tick(16, performance.now());
    };

    show(['sp']);
    change('loadout-mode', 'custom');
    expect(store.entities.get('sp')!.loadout).toEqual([]);
    click('Add item');
    change('loadout-item0', 'bandage');
    change('loadout-count0', '3');
    expect(store.entities.get('sp')!.loadout).toEqual([{ item: 'bandage', count: 3 }]);

    show([]);
    click('Add loot table');
    const [table] = [...store.lootTables.values()];
    expect(table?.mode).toBe('weighted');

    show(['ch']);
    change('container-mode', 'authored');
    change('container-loot', table!.id);
    change('container-refill', '120');
    expect(store.entities.get('ch')!.container).toEqual({ loot: table!.id, refillSeconds: 120 });

    show([]);
    click('Delete table');
    expect(store.lootTables.size).toBe(1); // still used by the chest
    expect(s.ctx.selection.values()).toEqual(['ch']);

    show(['rg']);
    click('Add spawner');
    change('spawner-maxAlive', '7');
    expect(store.regions.get('rg')!.spawner).toMatchObject({ maxAlive: 7, batch: 2, everySeconds: 30 });
    expect(store.toProject().requiredFeatures).toEqual(expect.arrayContaining(['population.loot', 'population.spawners', 'population.spawns']));
    editor.stop();
  });

  it('leaves nothing behind across repeated entry and exit', async () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    for (let i = 0; i < 3; i++) {
      const { editor } = await openNew();
      editor.stop();
    }
    expect(document.querySelectorAll('.we-root')).toHaveLength(0);
    const count = (spy: typeof added) => spy.mock.calls.filter(([type]) => ['keydown', 'keyup', 'blur', 'beforeunload'].includes(type as string)).length;
    expect(count(removed)).toBe(count(added));
  });
});
