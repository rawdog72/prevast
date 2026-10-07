// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson, gameplayHash, gameplayView } from './scenario-canonical';
import {
  createProject,
  hasErrors,
  parseProjectText,
  polygonSelfIntersects,
  requiredFeatures,
  SCENARIO_FORMAT,
  validateProject,
  type ScenarioProject,
} from './scenario-schema';

const CORPUS = 'tests/fixtures/scenarios';
const corpus = JSON.parse(readFileSync(`${CORPUS}/corpus.json`, 'utf8')) as {
  file: string;
  valid: boolean;
  codes: string[];
}[];

describe('scenario structural validation corpus', () => {
  for (const entry of corpus) {
    it(entry.file, () => {
      const result = parseProjectText(readFileSync(`${CORPUS}/${entry.file}`, 'utf8'));
      if (entry.valid) {
        expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expect(result.project).toBeDefined();
      } else {
        expect(result.project).toBeUndefined();
        const codes = new Set(result.diagnostics.map((d) => d.code));
        for (const code of entry.codes) expect(codes, JSON.stringify(result.diagnostics)).toContain(code);
      }
    });
  }
});

describe('scenario validation details', () => {
  it('rejects oversized text before parsing it', () => {
    const huge = ' '.repeat(40 * 1024 * 1024);
    expect(parseProjectText(huge).diagnostics[0]?.code).toBe('budget.bytes');
  });

  it('points diagnostics at the offending entity', () => {
    const project = createProject({ id: 'p', title: 'T', tilesX: 10, tilesY: 10 });
    project.entities.push({ id: 'w1', kind: 'object', ref: 'wood_wall', x: 1150, y: 50 });
    const d = validateProject(project).diagnostics.find((x) => x.code === 'entity.out-of-bounds');
    expect(d).toMatchObject({ target: 'w1', path: 'entities[0]' });
  });

  it('accepts a freshly created project', () => {
    const result = validateProject(createProject({ id: 'p', title: 'T', tilesX: 150, tilesY: 150 }));
    expect(hasErrors(result.diagnostics)).toBe(false);
  });

  it('checks the entity budget before the full parse', () => {
    const project = createProject({ id: 'p', title: 'T', tilesX: 10, tilesY: 10 }) as unknown as {
      entities: unknown[];
    };
    project.entities = new Array(200001).fill(0);
    expect(validateProject(project).diagnostics.map((d) => d.code)).toEqual(['budget.entities']);
  });

  it('detects polygon self-intersection but allows a concave simple polygon', () => {
    expect(polygonSelfIntersects([[0, 0], [10, 10], [10, 0], [0, 10]])).toBe(true);
    expect(polygonSelfIntersects([[0, 0], [10, 0], [10, 10], [5, 3], [0, 10]])).toBe(false);
  });

  it('migrates a schema 1 project, adding an empty loot table list', () => {
    const result = parseProjectText(readFileSync(`${CORPUS}/valid-house.prevast.json`, 'utf8'));
    expect(result.project?.schemaVersion).toBe(2);
    expect(result.project?.lootTables).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toContain('schema.migrated');
  });

  it('declares exactly the features the population fixture uses', () => {
    const project = parseProjectText(readFileSync(`${CORPUS}/valid-population.prevast.json`, 'utf8')).project!;
    expect(requiredFeatures(project)).toEqual(project.requiredFeatures);
  });

  it('only warns about a template container whose loot table is missing', () => {
    const project = createProject({ id: 'p', title: 'T', tilesX: 10, tilesY: 10 });
    project.templates.push({
      id: 't1',
      name: 'Hut',
      revision: 1,
      size: { w: 2, h: 2 },
      entities: [{ id: 'a', kind: 'object', ref: 'wood_chest', x: 50, y: 50, container: { loot: 'gone' } }],
      groups: [],
      regions: [],
    });
    const result = validateProject(project);
    expect(hasErrors(result.diagnostics)).toBe(false);
    expect(result.diagnostics.find((d) => d.code === 'ref.dangling-loot')?.severity).toBe('warning');
  });

  it('derives required features from content', () => {
    expect(
      requiredFeatures({
        entities: [{ id: 'a', kind: 'object', ref: 'x', x: 50, y: 50, overrides: { healthMax: 5 } }],
        regions: [],
      }),
    ).toEqual(['overrides.health', 'world.v1']);
  });
});

describe('scenario format id', () => {
  it('reads a project saved under the old format id as the current one, with the same gameplay hash', async () => {
    const legacy = parseProjectText(readFileSync(`${CORPUS}/valid-legacy-format.prevast.json`, 'utf8')).project!;
    const current = parseProjectText(readFileSync(`${CORPUS}/valid-minimum.prevast.json`, 'utf8')).project!;
    expect(legacy.format).toBe(SCENARIO_FORMAT);
    expect(await gameplayHash(legacy)).toBe(await gameplayHash(current));
  });
});

describe('scenario canonical form', () => {
  const house = parseProjectText(readFileSync(`${CORPUS}/valid-house.prevast.json`, 'utf8'))
    .project as ScenarioProject;

  it('ignores ordering and editor metadata', async () => {
    const shuffled: ScenarioProject = structuredClone(house);
    shuffled.entities.reverse();
    shuffled.editor = { camera: { x: 1, y: 2, zoom: 0.5 } };
    shuffled.title = 'Renamed';
    shuffled.revision = 9;
    expect(await gameplayHash(shuffled)).toBe(await gameplayHash(house));
  });

  it('changes when gameplay changes', async () => {
    const moved: ScenarioProject = structuredClone(house);
    moved.entities[0]!.overrides = { healthMax: 9001 };
    expect(await gameplayHash(moved)).not.toBe(await gameplayHash(house));
  });

  for (const name of ['valid-house', 'valid-population']) {
    it(`matches the cross-language fixture ${name}`, async () => {
      const project = parseProjectText(readFileSync(`${CORPUS}/${name}.prevast.json`, 'utf8')).project!;
      const expected = readFileSync(`${CORPUS}/canonical/${name}.canonical.json`, 'utf8').trimEnd();
      expect(canonicalJson(gameplayView(project))).toBe(expected);
      const hash = readFileSync(`${CORPUS}/canonical/${name}.sha256`, 'utf8').trim();
      expect(await gameplayHash(project)).toBe(hash);
    });
  }
});
