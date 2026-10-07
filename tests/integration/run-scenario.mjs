// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Boots a fresh server on a World Editor project and runs the live scenario
// checks against it. Logs stay under runtime/scenario-live/<time>/.
//   node tests/integration/run-scenario.mjs   (npm run test:scenario)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const binary = resolve(root, 'dist/server/Release/prevast_server.exe');
assert(existsSync(binary), 'Run npm run server:build first');
const project = resolve(root, 'tests/fixtures/scenarios/boot/population-live.prevast.json');
const run = resolve(root, 'runtime/scenario-live', new Date().toISOString().replaceAll(/[:.]/g, '-'));
mkdirSync(join(run, 'storage'), { recursive: true });

const ports = [];
while (ports.length < 3) {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  if (!ports.includes(port)) ports.push(port);
}
const [gamePort, statusPort, httpPort] = ports;
let config = readFileSync(resolve(root, 'config/development.lua'), 'utf8');
const settings = {
  contentPath: resolve(root, 'data/XML').replaceAll('\\', '/'),
  storagePath: 'storage', ip: '127.0.0.1',
  gameProtocolPort: gamePort, statusProtocolPort: statusPort, httpPort,
  publicHost: '127.0.0.1', publicPort: 0, listingUrl: '', listingId: 'isolated-scenario',
  useDatabase: false, recordAccountProgress: false, worldType: 'pvp',
  scenarioFile: project.replaceAll('\\', '/'),
};
for (const [key, value] of Object.entries(settings)) {
  const line = `${key} = ${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}\\s*=.*$`, 'm');
  config = pattern.test(config) ? config.replace(pattern, line) : config + '\n' + line + '\n';
}
writeFileSync(join(run, 'config.lua'), config);

const children = [];
function launch(name, command, args, cwd, env = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.failure = null;
  child.on('error', (error) => { child.failure = error; });
  const log = join(run, `${name}.log`);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => appendFileSync(log, chunk));
  children.push(child);
  return child;
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
try {
  const game = launch('server', binary, [], run);
  const deadline = Date.now() + 60000;
  const log = join(run, 'server.log');
  let ready = false;
  while (Date.now() < deadline) {
    assert(!game.failure && game.exitCode === null, `Server exited; see ${log}`);
    if (existsSync(log) && readFileSync(log, 'utf8').includes('Server Online')) { ready = true; break; }
    await wait(250);
  }
  assert(ready, `Startup timed out; see ${log}`);
  const test = launch('scenario', process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), resolve(root, 'tests/integration/live-scenario-test.ts')], root,
    { SCENARIO_TEST_URL: `ws://127.0.0.1:${gamePort}` });
  const [code] = await once(test, 'exit');
  const testLog = join(run, 'scenario.log');
  if (existsSync(testLog)) process.stdout.write(readFileSync(testLog, 'utf8'));
  assert.equal(code, 0, `live-scenario-test failed; see ${run}`);
  console.log(`Scenario integration passed. Logs: ${run}`);
} finally {
  for (const child of [...children].reverse()) {
    if (child.exitCode !== null || child.signalCode !== null || child.failure) continue;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
}
