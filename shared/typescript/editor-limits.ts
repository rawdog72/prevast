// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The TypeScript view of shared/editor/limits.json. The C++ server reads the
// same file through a generated header (tools/editor/generate-contract.mjs), so
// a limit changes in one place for both languages.
import limitsJson from '../editor/limits.json' with { type: 'json' };

export interface EditorLimits {
  contractVersion: number;
  world: {
    tileSize: number;
    positionMax: number;
    minTiles: number;
    maxTiles: number;
    referenceTilesX: number;
    referenceTilesY: number;
  };
  project: {
    schemaVersion: number;
    maxBytes: number;
    maxEntities: number;
    maxGroups: number;
    maxGroupDepth: number;
    maxTemplates: number;
    maxTemplateEntities: number;
    maxRegions: number;
    maxEffects: number;
    maxNpcs: number;
    maxSpawns: number;
    maxLootTables: number;
    maxLootEntries: number;
    maxLoadoutItems: number;
    maxSpawnerAlive: number;
    maxScenarioAgents: number;
    maxTagsPerEntity: number;
    maxIdLength: number;
    maxNameLength: number;
    maxTagLength: number;
  };
  overrides: { healthMax: number };
}

export const EDITOR_LIMITS: Readonly<EditorLimits> = Object.freeze(
  limitsJson as unknown as EditorLimits,
);

export const TILE_SIZE = EDITOR_LIMITS.world.tileSize;
export const HALF_TILE = TILE_SIZE / 2;
