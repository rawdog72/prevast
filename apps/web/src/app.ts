// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import compression from 'compression';
import express from 'express';
import path from 'node:path';
import type { AccountService } from './accounts/account-service';
import { createAccountRouter } from './accounts/account-routes';
import { accountProfile } from './accounts/profile';
import { Registry } from './registry';
import { createRegistryRouter } from './registry-routes';

export interface AppOptions {
  /** Repository root: `dist/client` and `public` are resolved against it. */
  root: string;
  /** The user's copy of the original assets (img/, audio/); default `<root>/original-assets`. */
  originalAssets?: string;
  validToken: (token: unknown) => boolean;
  registry?: Registry;
  /**
   * Read per request; null (or no getter) = accounts disabled, and the start
   * page hides the account area.
   */
  accounts?: () => AccountService | null;
  validAccountAdminToken?: (token: unknown) => boolean;
  accountProgressServer?: (token: unknown) => string | null;
}

/**
 * TRUST_PROXY as Express's `trust proxy` setting: a hop count ("1"), true or
 * false, or an address list such as "loopback" or "loopback, 10.0.0.0/8".
 */
export function parseTrustProxy(value: string): number | boolean | string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  return trimmed;
}

export function createApp(options: AppOptions): express.Express {
  const registry = options.registry ?? new Registry(options.validToken);
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy, this is what makes req.ip (rate limits) and
  // req.secure (the session cookie) describe the real client.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) app.set('trust proxy', parseTrustProxy(trustProxy));
  // The bundle, stylesheets and content tables shrink 4-5x gzipped; PNGs are
  // skipped by the default filter's size/type heuristics.
  app.use(compression());
  // Registered before the static mounts so nothing on disk can shadow them.
  app.use(createRegistryRouter(registry, options.validToken));
  app.use(
    createAccountRouter({
      service: options.accounts ?? (() => null),
      validAdminToken: options.validAccountAdminToken ?? (() => false),
      progressServer: options.accountProgressServer,
      profile: (snapshot) => accountProfile(options.root, snapshot),
    }),
  );
  // Generated content tables for browser startup. Test fixtures are separate.
  app.use('/content', express.static(path.join(options.root, 'dist', 'content'), { maxAge: '1h' }));
  // The bundle revalidates on every load (ETag), and so must the stylesheet,
  // page and sprite manifest that ship with it -- a deploy must not leave
  // players on last hour's CSS against this hour's DOM. Images and audio may
  // be cached for a day; a sprite requested with its manifest hash
  // (`?v=<hash>`, see tools/assets/sprite-manifest.ts) is immutable for a year.
  app.use(express.static(path.join(options.root, 'dist', 'client'), { maxAge: 0 }));
  const assets = (dir: string) =>
    express.static(dir, {
      maxAge: '1d',
      setHeaders: (res, filePath) => {
        if (/\.(css|html)$/i.test(filePath)) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (
          /\.png$/i.test(filePath) &&
          typeof (res.req?.query as { v?: unknown } | undefined)?.v === 'string'
        ) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
  app.use(assets(path.join(options.root, 'apps', 'client', 'public')));
  // The original Devast.io art is not in the repository: each operator supplies
  // their own copy (original-assets/README.md). The project's own files above win.
  const originals = options.originalAssets ?? path.join(options.root, 'original-assets');
  app.use('/img', assets(path.join(originals, 'img')));
  app.use('/audio', assets(path.join(originals, 'audio')));
  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  return app;
}
