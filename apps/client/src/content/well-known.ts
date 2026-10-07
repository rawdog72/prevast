// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Keys client logic depends on by name. ContentStore.assertWellKnown() fails
// at content-ready with a readable list if any is missing. Later milestones append here
// when they write code that names a key; nothing else may hardcode a key or an id.
import type { ContentTableName } from '../../../../shared/typescript/content-format';

export const WELL_KNOWN_KEYS: Partial<Record<ContentTableName, readonly string[]>> = {
  items: ['wood', 'stone', 'hatchet', 'campfire', 'workbench', 'furniture', 'road'],
  equipables: ['hand', 'place_object'],
  objects: ['campfire', 'workbench', 'road', 'wood_wall'],
  resources: ['wood', 'stone'],
  agents: ['normal_ghoul'],
  modes: ['survival'],
};
