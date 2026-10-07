// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Builds the browser bundle and the host. `--watch` rebuilds on change and
// runs the host with node --watch so it restarts when its bundle changes.
import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildItemIcons } from '../tools/assets/item-icons.ts';
import { exportAll } from '../tools/content/export-content.ts';
import { buildSpriteManifest } from '../tools/assets/sprite-manifest.ts';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
exportAll('data/XML', 'config/development.lua', 'dist/content');

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');
// Each application owns its output; never remove C++ binaries or runtime data.
if (watch) {
  rmSync('dist/client', { recursive: true, force: true });
  rmSync('dist/web', { recursive: true, force: true });
}
mkdirSync('dist', { recursive: true });
console.log(`sprite manifest: ${buildSpriteManifest()} sprites`);
// Frameless HUD icons (/icons/<name>.png) from the old `<name>-out.png` buttons.
const icons = buildItemIcons();
console.log(`hud icons: ${icons.stripped} stripped, ${icons.copied} copied, ${icons.unchanged} unchanged`);

/** @type {esbuild.BuildOptions} */
const client = {
  entryPoints: ['apps/client/src/main.ts'],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  outfile: 'dist/client/client.js',
  sourcemap: true,
  minify,
  logLevel: 'info',
};

/** @type {esbuild.BuildOptions} */
const server = {
  entryPoints: ['apps/web/src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node18'],
  packages: 'external',
  outfile: 'dist/web/index.js',
  sourcemap: true,
  minify,
  logLevel: 'info',
};

if (!watch) {
  await Promise.all([esbuild.build(client), esbuild.build(server)]);
} else {
  const contexts = await Promise.all([esbuild.context(client), esbuild.context(server)]);
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.watch()));
  const host = spawn(process.execPath, ['--watch', 'dist/web/index.js'], { stdio: 'inherit' });
  const stop = () => {
    host.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
