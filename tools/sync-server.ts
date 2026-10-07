// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Optional compatibility bundle for the local game server runtime.
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';

interface SyncDestination {
  label: string;
  targetJs: string;
  targetMap?: string;
}

export function syncServer(options: { rootDir?: string; autoBuild?: boolean; destinations?: SyncDestination[] } = {}): {
  success: boolean;
  copied: string[];
} {
  const root = options.rootDir ?? resolve('.');
  const distJs = resolve(root, 'dist/client/client.js');
  const distMap = resolve(root, 'dist/client/client.js.map');

  if (!existsSync(distJs) && (options.autoBuild ?? true)) {
    console.info('[sync] dist/client/client.js not found, running build...');
    execSync('npm run build', { cwd: root, stdio: 'inherit' });
  }

  if (!existsSync(distJs)) {
    console.error(`[sync Error] Client bundle not found at ${distJs}`);
    return { success: false, copied: [] };
  }

  const jsSize = statSync(distJs).size;
  const jsKb = (jsSize / 1024).toFixed(1);
  console.info(`[sync] Source bundle: ${distJs} (${jsKb} KB)`);

  const destinations: SyncDestination[] = options.destinations ?? [{
    label: 'Local development runtime',
    targetJs: resolve(root, 'runtime/development/client.js'),
    targetMap: resolve(root, 'runtime/development/client.js.map'),
  }];

  const copied: string[] = [];

  for (const dest of destinations) {
    const parentDir = dirname(dest.targetJs);
    if (!existsSync(parentDir)) {
      console.info(`[sync] Skipping ${dest.label} (${parentDir} does not exist)`);
      continue;
    }

    try {
      copyFileSync(distJs, dest.targetJs);
      copied.push(dest.targetJs);
      console.info(`[sync] Copied to ${dest.label} -> ${dest.targetJs}`);

      if (dest.targetMap && existsSync(distMap)) {
        copyFileSync(distMap, dest.targetMap);
        copied.push(dest.targetMap);
      }
    } catch (err) {
      console.warn(`[sync Warning] Failed to copy to ${dest.targetJs}:`, err);
    }
  }

  console.info(`[sync] Completed successfully: synchronized to ${copied.length} file(s).`);
  return { success: true, copied };
}

// Run CLI directly if invoked
if (process.argv[1]?.endsWith('sync-server.ts')) {
  const result = syncServer();
  if (!result.success) {
    process.exit(1);
  }
}
