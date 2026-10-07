// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { createProject, type ScenarioProject } from '../../../../shared/typescript/scenario-schema';
import { EditorCatalog, type CatalogEntry } from './catalog/catalog';
import { DocumentStore } from './document/store';
import { SpatialIndex } from './document/spatial';
import { validateDocument } from './validation';

const entry = (over: Partial<CatalogEntry>): CatalogEntry => ({
  key: 'object:x',
  kind: 'object',
  ref: 'x',
  name: 'x',
  category: 'wall',
  layer: 'top',
  protocolType: 3,
  slot: 'solid',
  rotatable: false,
  overridable: [],
  searchText: '',
  ...over,
});

const catalog = new EditorCatalog(
  [
    entry({ ref: 'wood_wall', key: 'object:wood_wall', name: 'Wood wall' }),
    entry({ ref: 'wood_chest', key: 'object:wood_chest', name: 'Chest', containerSlots: 2 }),
    entry({ ref: 'ghoul', key: 'agent:ghoul', kind: 'agent', layer: 'creatures', category: 'creature' }),
  ],
  [
    { key: 'bandage', id: 38, name: 'Bandage', stack: 5 },
    { key: 'hatchet', id: 15, name: 'Hatchet', stack: 1 },
  ],
);

function codes(build: (p: ScenarioProject) => void) {
  const project = createProject({ id: 'p', title: 'T', tilesX: 20, tilesY: 20 });
  build(project);
  const store = new DocumentStore(project);
  const spatial = new SpatialIndex(store, catalog);
  const found = validateDocument(store.toProject(), catalog, spatial).map((d) => `${d.severity} ${d.code}`);
  spatial.dispose();
  return found;
}

describe('editor population diagnostics (same codes as the server compile)', () => {
  it('checks loadouts, container contents and loot items against the catalog', () => {
    const found = codes((p) => {
      p.entities.push(
        { id: 's', kind: 'spawn', ref: 'player', x: 550, y: 550, loadout: [{ item: 'hatchet', count: 2 }, { item: 'nope', count: 1 }] },
        { id: 'c', kind: 'object', ref: 'wood_chest', x: 750, y: 750, container: { fixed: [1, 2, 3].map(() => ({ item: 'bandage', count: 1 })) } },
        { id: 'w', kind: 'object', ref: 'wood_wall', x: 950, y: 950, container: { loot: 'l' } },
      );
      p.lootTables.push({ id: 'l', name: 'L', mode: 'independent', entries: [{ item: 'bandage', min: 1, max: 9, weight: 100 }] });
    });
    expect(found).toEqual(
      expect.arrayContaining(['error item.count', 'error content.missing', 'error container.slots', 'error override.unsupported']),
    );
    expect(found.filter((c) => c === 'error item.count')).toHaveLength(2); // loadout hatchet and loot bandage
  });

  it('reports blocked and denied spawns, blocked creatures, cramped spawners and permission conflicts', () => {
    const found = codes((p) => {
      p.entities.push(
        { id: 'w1', kind: 'object', ref: 'wood_wall', x: 550, y: 550 },
        { id: 's1', kind: 'spawn', ref: 'player', x: 550, y: 550 },
        { id: 's2', kind: 'spawn', ref: 'player', x: 1050, y: 1050 },
        { id: 'w2', kind: 'object', ref: 'wood_wall', x: 1550, y: 1550 },
        { id: 'a1', kind: 'agent', ref: 'ghoul', x: 1550, y: 1550 },
      );
      p.regions.push(
        { id: 'safe', name: 'Safe', priority: 0, shape: { type: 'rect', x: 1000, y: 1000, w: 200, h: 200 }, permissions: { spawn: 'deny' } },
        { id: 'open', name: 'Open', priority: 0, shape: { type: 'rect', x: 1100, y: 1100, w: 200, h: 200 }, permissions: { spawn: 'allow' } },
        {
          id: 'pen',
          name: 'Pen',
          priority: 0,
          shape: { type: 'rect', x: 1500, y: 1500, w: 100, h: 100 },
          spawner: { agent: 'ghoul', maxAlive: 1, batch: 1, everySeconds: 5 },
        },
      );
    });
    expect(found).toEqual(
      expect.arrayContaining([
        'warning spawn.blocked',
        'error spawn.denied',
        'error agent.blocked',
        'warning spawner.no-room',
        'info region.conflict',
      ]),
    );
  });
});
