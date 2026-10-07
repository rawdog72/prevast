// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { createProject, type ScenarioEntity } from '../../../../../shared/typescript/scenario-schema';
import { EditorCatalog, type CatalogEntry } from '../catalog/catalog';
import {
  createTemplate,
  extractFragment,
  groupSelection,
  insertFragment,
  instantiateTemplate,
  placeEntities,
  removeWithDependents,
  transformSelection,
} from './ops';
import { SpatialIndex } from './spatial';
import { DocumentStore } from './store';

const entry = (over: Partial<CatalogEntry>): CatalogEntry => ({
  key: `object:${over.ref}`,
  kind: 'object',
  ref: 'x',
  name: 'x',
  category: 'wall',
  layer: 'top',
  protocolType: 3,
  slot: 'solid',
  rotatable: false,
  overridable: ['healthMax'],
  searchText: '',
  ...over,
});

const catalog = new EditorCatalog([
  entry({ ref: 'wood_wall', key: 'object:wood_wall' }),
  entry({ ref: 'floor', key: 'object:floor', slot: 'floor', category: 'floor', layer: 'floors' }),
  entry({ ref: 'bench', key: 'object:bench', rotatable: true, secondTile: { 0: { di: 0, dj: 1 }, 1: { di: 1, dj: 0 }, 2: { di: 0, dj: -1 }, 3: { di: -1, dj: 0 } } }),
  entry({ ref: 'merchant', key: 'npc:merchant', kind: 'npc', layer: 'npcs', category: 'npc' }),
]);

function setup(size = 20) {
  const store = new DocumentStore(createProject({ id: 'p', title: 'T', tilesX: size, tilesY: size }));
  const spatial = new SpatialIndex(store, catalog);
  return { store, spatial };
}

const wall = (tx: number, ty: number): Omit<ScenarioEntity, 'id'> => ({
  kind: 'object',
  ref: 'wood_wall',
  x: tx * 100 + 50,
  y: ty * 100 + 50,
  rotation: 0,
});

describe('document store and operations', () => {
  it('a brush stroke is one undo step and replaces pieces in the same slot', () => {
    const { store, spatial } = setup();
    store.begin('Paint');
    placeEntities(store, spatial, catalog, [wall(1, 1), wall(2, 1), wall(3, 1)]);
    placeEntities(store, spatial, catalog, [{ ...wall(2, 1), ref: 'floor' }]);
    placeEntities(store, spatial, catalog, [wall(2, 1)]); // identical: no-op
    store.commit();
    expect(store.entities.size).toBe(4);
    expect(spatial.cell(2, 1)).toMatchObject({ solid: expect.any(String), floor: expect.any(String) });
    store.undo();
    expect(store.entities.size).toBe(0);
    expect(spatial.cell(1, 1)).toBeUndefined();
    store.redo();
    expect(store.entities.size).toBe(4);
  });

  it('only the selected walls carry a health override through copy and paste', () => {
    const { store, spatial } = setup();
    const ids = placeEntities(store, spatial, catalog, [wall(1, 1), wall(2, 1), wall(3, 1), wall(4, 1), wall(5, 1)]);
    store.transact('Health', () => {
      for (const id of ids.slice(0, 3)) store.put('entity', { ...store.entities.get(id)!, overrides: { healthMax: 9000 } });
    });
    const fragment = extractFragment(store, ids)!;
    const pasted = insertFragment(store, spatial, catalog, fragment, { x: 100, y: 500 });
    expect(pasted.ok).toBe(true);
    const healths = [...store.entities.values()].filter((e) => e.y === 550).sort((a, b) => a.x - b.x).map((e) => e.overrides?.healthMax);
    expect(healths).toEqual([9000, 9000, 9000, undefined, undefined]);
    // Fresh identities for the copy.
    expect(new Set(store.entities.keys()).size).toBe(10);
  });

  it('four quarter turns restore geometry exactly', () => {
    const { store, spatial } = setup();
    const ids = placeEntities(store, spatial, catalog, [
      wall(3, 3),
      wall(4, 3),
      { kind: 'object', ref: 'bench', x: 350, y: 550, rotation: 0 },
      { kind: 'npc', ref: 'merchant', x: 432, y: 471, angle: 10 },
    ]);
    const before = JSON.stringify([...store.entities.values()]);
    for (let i = 0; i < 4; i++)
      expect(transformSelection(store, spatial, catalog, ids, { dx: 0, dy: 0, turns: 1, pivot: { x: 400, y: 400 } }).ok).toBe(true);
    expect(JSON.stringify([...store.entities.values()])).toBe(before);
  });

  it('an invalid move changes nothing and names the offenders', () => {
    const { store, spatial } = setup(10);
    const ids = placeEntities(store, spatial, catalog, [wall(8, 1), wall(9, 1)]);
    placeEntities(store, spatial, catalog, [wall(8, 2)]);
    const version = store.version;
    const off = transformSelection(store, spatial, catalog, ids, { dx: 100, dy: 0, turns: 0, pivot: { x: 0, y: 0 } });
    expect(off.ok).toBe(false);
    expect(off.offenders).toEqual([ids[1]]);
    const clash = transformSelection(store, spatial, catalog, ids, { dx: 0, dy: 100, turns: 0, pivot: { x: 0, y: 0 } });
    expect(clash.ok).toBe(false);
    expect(store.version).toBe(version);
    expect(transformSelection(store, spatial, catalog, ids, { dx: 50, dy: 0, turns: 0, pivot: { x: 0, y: 0 } }).ok).toBe(false);
  });

  it('a group transform carries children, nested groups and attached regions', () => {
    const { store, spatial } = setup();
    const [a, b] = placeEntities(store, spatial, catalog, [wall(1, 1), wall(2, 1)]);
    const npc = placeEntities(store, spatial, catalog, [{ kind: 'npc', ref: 'merchant', x: 180, y: 250 }])[0]!;
    store.put('region', { id: 'r1', name: 'Warm', attach: npc, priority: 0, shape: { type: 'circle', x: 0, y: 0, r: 100 } });
    const house = groupSelection(store, [a!, b!, npc], 'house', 'House')!;
    const city = groupSelection(store, [house], 'city', 'City')!;
    expect(store.groups.get(house)!.parent).toBe(city);
    expect(transformSelection(store, spatial, catalog, [city], { dx: 500, dy: 200, turns: 0, pivot: { x: 0, y: 0 } }).ok).toBe(true);
    expect(store.entities.get(a!)).toMatchObject({ x: 650, y: 350 });
    expect(store.entities.get(npc)).toMatchObject({ x: 680, y: 450 });
    expect(store.regions.get('r1')!.shape).toMatchObject({ x: 0, y: 0 });
    store.undo();
    expect(store.entities.get(a!)).toMatchObject({ x: 150, y: 150 });
  });

  it('deleting a group removes its contents and attached regions in one step', () => {
    const { store, spatial } = setup();
    const [a] = placeEntities(store, spatial, catalog, [wall(1, 1)]);
    store.put('region', { id: 'r1', name: 'Rad', attach: a!, priority: 0, shape: { type: 'circle', x: 0, y: 0, r: 100 } });
    const g = groupSelection(store, [a!], 'group', 'G')!;
    expect(removeWithDependents(store, [g]).sort()).toEqual([a!, g, 'r1'].sort());
    expect(store.entities.size + store.groups.size + store.regions.size).toBe(0);
    store.undo();
    expect(store.regions.get('r1')?.attach).toBe(a);
  });

  it('templates are reusable independent copies', () => {
    const { store, spatial } = setup();
    const ids = placeEntities(store, spatial, catalog, [wall(1, 1), wall(2, 1), { kind: 'npc', ref: 'merchant', x: 190, y: 260 }]);
    const t = createTemplate(store, ids, 'Hut')!;
    expect(store.templates.get(t)!.size).toEqual({ w: 2, h: 2 });
    const placed = instantiateTemplate(store, spatial, catalog, t, { x: 1000, y: 1000 });
    expect(placed.ok).toBe(true);
    const group = store.groups.get(placed.ids[0]!)!;
    expect(group.template).toEqual({ id: t, revision: 1, linked: false });
    expect(store.descendants(group.id)).toHaveLength(3);
    const blocked = instantiateTemplate(store, spatial, catalog, t, { x: 1000, y: 1000 });
    expect(blocked.ok).toBe(false);
    expect(store.groups.size).toBe(1);
  });

  it('round-trips through the project format without losing identity', () => {
    const { store, spatial } = setup();
    placeEntities(store, spatial, catalog, [wall(1, 1)]);
    const project = store.toProject();
    const reopened = new DocumentStore(project);
    expect(reopened.toProject()).toEqual(project);
    expect(reopened.allocId('e')).not.toBe([...store.entities.keys()][0]);
  });
});
