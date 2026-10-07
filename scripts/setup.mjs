// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = resolve(root, 'runtime/development');
mkdirSync(runtime, { recursive: true });

function secretFile(name, make) {
  const file = resolve(runtime, name);
  // Owner-only where the filesystem has POSIX modes (Windows ignores it).
  if (!existsSync(file)) writeFileSync(file, make(), { mode: 0o600 });
  return readFileSync(file, 'utf8').trim();
}

const token = secretFile('.listing-token', () => randomBytes(32).toString('hex') + '\n');
// Account tickets: the web host signs with this key; game servers get the
// public half as accountPublicKey (base64 of the raw 65-byte P-256 point).
const signingKey = secretFile('.account-signing-key', () =>
  generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString(),
);
const jwk = createPublicKey(createPrivateKey(signingKey)).export({ format: 'jwk' });
const publicKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x, 'base64url'),
  Buffer.from(jwk.y, 'base64url'),
]).toString('base64');
const adminToken = secretFile('.account-admin-token', () => randomBytes(32).toString('hex') + '\n');
const progressTokens = JSON.parse(secretFile('.account-progress-tokens', () => '{}\n'));

// Puts this machine's account keys into a config.lua. A NEW config (from a
// config/<profile>.lua template, which carries the keys empty) gets the
// empty keys filled. An EXISTING config only gains a key whose line is absent
// altogether: there `key = ""` is an operator switching the feature off, and
// any other value is theirs too, so neither is ever replaced.
function fillAccountKeys(text, { fillEmpty }) {
  let result = text;
  const id = /^listingId\s*=\s*"([A-Za-z0-9._-]+)"/m.exec(text)?.[1];
  const existing = /^accountProgressToken\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  if (id) progressTokens[id] ??= existing || randomBytes(32).toString('hex');
  for (const [key, value] of [
    ['accountPublicKey', publicKey],
    ['accountAdminToken', adminToken],
    ['accountProgressToken', id ? progressTokens[id] : ''],
  ]) {
    const empty = new RegExp(`^${key}\\s*=\\s*""\\s*$`, 'm');
    if (!new RegExp(`^${key}\\s*=`, 'm').test(result)) result += `\n${key} = "${value}"\n`;
    else if (fillEmpty && empty.test(result)) result = result.replace(empty, `${key} = "${value}"`);
  }
  return result;
}

for (const profile of ['development', 'benchmark']) {
  const dir = resolve(root, 'runtime', profile);
  mkdirSync(resolve(dir, 'storage'), { recursive: true });
  const config = resolve(dir, 'config.lua');
  if (!existsSync(config)) {
    const template = readFileSync(resolve(root, 'config', `${profile}.lua`), 'utf8');
    const filled = fillAccountKeys(
      template
        .replace(/^listingToken\s*=.*$/m, `listingToken = "${token}"`)
        .replace(/^adminPassword\s*=.*$/m, `adminPassword = "${randomBytes(16).toString('hex')}"`),
      { fillEmpty: true },
    );
    // It holds passwords, listing credentials and account service tokens.
    writeFileSync(config, filled, { mode: 0o600 });
    console.log(`Created runtime/${profile}/config.lua`);
  } else {
    // Existing configs are preserved; only account keys missing entirely are
    // appended, so an operator's values (including "") are never replaced.
    const text = readFileSync(config, 'utf8');
    const filled = fillAccountKeys(text, { fillEmpty: false });
    if (filled !== text) {
      writeFileSync(config, filled);
      console.log(`Added missing account keys to runtime/${profile}/config.lua`);
    }
  }
}
writeFileSync(
  resolve(runtime, '.account-progress-tokens'),
  JSON.stringify(progressTokens, null, 2) + '\n',
  { mode: 0o600 },
);
// The isolated scenario profile: the development config with its own ports,
// no database, no listing and no account progress, running the World Editor
// project in runtime/scenario/scenario.prevast.json (export one from the
// editor). Derived here rather than kept as a third template, so it cannot
// drift from development in everything but what makes it isolated.
{
  const dir = resolve(root, 'runtime', 'scenario');
  mkdirSync(resolve(dir, 'storage'), { recursive: true });
  const config = resolve(dir, 'config.lua');
  if (!existsSync(config)) {
    const overrides = {
      gameProtocolPort: '8272',
      statusProtocolPort: '8271',
      httpPort: '8280',
      serverName: '"Scenario test"',
      serverVisible: 'false',
      listingUrl: '""',
      listingId: '"prevast-scenario"',
      useDatabase: 'false',
      recordAccountProgress: 'false',
      perfStats: 'false',
      adminPassword: `"${randomBytes(16).toString('hex')}"`,
    };
    let text = readFileSync(resolve(root, 'config', 'development.lua'), 'utf8');
    for (const [key, value] of Object.entries(overrides))
      text = text.replace(new RegExp(`^${key}\\s*=.*$`, 'm'), `${key} = ${value}`);
    text +=
      '\n-- World & Mode Editor project run as the world (relative to this directory).\nscenarioFile = "scenario.prevast.json"\n';
    writeFileSync(config, text, { mode: 0o600 });
    console.log('Created runtime/scenario/config.lua (isolated scenario profile)');
  }
}
console.log('Local runtime is ready. Existing configuration and storage are preserved.');
// The original Devast.io art is not in the repository (original-assets/README.md).
// Names only here; `npm run assets:check` also compares sizes and hashes.
{
  const manifest = JSON.parse(readFileSync(resolve(root, 'original-assets', 'manifest.json'), 'utf8'));
  const names = Object.keys(manifest.files);
  const present = names.filter((name) => existsSync(resolve(root, 'original-assets', name))).length;
  console.log(
    present === names.length
      ? `Original assets: all ${names.length} files present.`
      : `Original assets: ${present} of ${names.length} files present. See original-assets/README.md.`,
  );
}
console.log(
  'Accounts are off until runtime/development/.accounts-db holds a URL such as mysql://root@127.0.0.1:3306/prevast_accounts',
);
