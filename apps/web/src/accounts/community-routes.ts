// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import { createAdmission } from '../rate-limit';
import { CommunityError, type AccountCommunity } from './community';
import { readCookie, SESSION_COOKIE, type AccountRouterOptions } from './account-routes';
import type { Rankings } from '../../../../shared/typescript/account-community';

export function mountCommunityRoutes(router: Router, options: AccountRouterOptions): void {
  const admission = createAdmission(),
    writes = createAdmission({ perIpTokens: 12, perIpRefillPerMs: 0.002 });
  const json = express.json({ limit: '512kb' });
  const handle =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await fn(req, res);
      } catch (e) {
        if (e instanceof CommunityError) res.status(e.status).json({ error: e.message });
        else next(e);
      }
    };
  const community = (): AccountCommunity => {
    const c = options.service()?.community;
    if (!c) throw new CommunityError(503, 'Account progression is unavailable.');
    return c;
  };
  const account = async (req: Request) => {
    const a = await options.service()?.me(readCookie(req.headers.cookie, SESSION_COOKIE));
    if (!a) throw new CommunityError(401, 'Sign in to manage your account.');
    return a;
  };
  const server = (req: Request) => {
    const id = options.progressServer?.(req.get('x-account-progress-token'));
    if (!id) throw new CommunityError(403, 'Account progress token required.');
    return id;
  };
  const requireJson = (req: Request, res: Response, next: NextFunction) => {
    if (req.is('application/json')) next();
    else res.status(415).json({ error: 'Use a JSON request.' });
  };
  const offset = (req: Request) => {
    const n = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(n) || n < 0) throw new CommunityError(400, 'Invalid page.');
    return n;
  };
  const identity = (value: unknown) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1 || id > 0xffffffff)
      throw new CommunityError(400, 'Invalid identity.');
    return id;
  };
  router.get(
    '/api/account/community',
    admission,
    handle(async (req, res) => {
      res.json(await community().profile((await account(req)).id));
    }),
  );
  router.post(
    '/api/account/clan',
    writes,
    requireJson,
    json,
    handle(async (req, res) => {
      res.json(await community().command((await account(req)).id, req.body));
    }),
  );
  router.get(
    '/api/account/clan/roster',
    admission,
    handle(async (req, res) => {
      const a = await account(req),
        p = await community().profile(a.id);
      if (!p.clan) throw new CommunityError(404, 'You do not belong to a clan.');
      res.json(
        await community().clan(
          p.clan.id,
          a.id,
          offset(req),
          String(req.query.search ?? '').slice(0, 40),
        ),
      );
    }),
  );
  router.get(
    '/api/community/rankings',
    admission,
    handle(async (req, res) => {
      res.set('Cache-Control', 'public, max-age=30');
      res.json(
        await community().rankings(
          req.query.season === undefined ? undefined : String(req.query.season),
          (req.query.metric ?? 'score') as Rankings['metric'],
          offset(req),
        ),
      );
    }),
  );
  router.get(
    '/api/community/clans/:id',
    admission,
    handle(async (req, res) => {
      res.json(
        await community().clan(
          identity(req.params.id),
          0,
          offset(req),
          String(req.query.search ?? '').slice(0, 40),
        ),
      );
    }),
  );
  router.get(
    '/api/community/players/:id',
    admission,
    handle(async (req, res) => {
      const p = await community().profile(identity(req.params.id));
      res.json({
        accountId: p.accountId,
        name: p.name,
        completedRuns: p.completedRuns,
        averageScore: p.averageScore,
        bestScore: p.bestScore,
        clan: p.clan
          ? { id: p.clan.id, name: p.clan.name, tag: p.clan.tag, rank: p.clan.rank }
          : null,
      });
    }),
  );
  for (const action of ['report', 'boot', 'state'] as const) {
    router.post(
      '/api/servers/community/' + action,
      admission,
      requireJson,
      json,
      handle(async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const id = server(req),
          c = community();
        if (action === 'report') res.json(await c.report(id, req.body));
        else if (action === 'boot') {
          await c.boot(id, String(req.body?.bootId ?? ''));
          res.json({ ok: true });
        } else {
          const ids = req.body?.accounts;
          if (
            !Array.isArray(ids) ||
            ids.length > 255 ||
            ids.some((v) => !Number.isSafeInteger(v) || v < 1)
          )
            throw new CommunityError(400, 'Expected up to 255 account ids.');
          res.json({
            ...c.serverRules(id),
            identities: await c.identities(ids),
            bests: await c.bests(ids),
          });
        }
      }),
    );
  }
}
