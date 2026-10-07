// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// HTTP wrapper around AccountService. Two audiences:
//   /api/account/*          the start page, authenticated by the session cookie;
//   /api/servers/accounts/* game servers running !setgroup, authenticated by
//                           ACCOUNT_ADMIN_TOKEN (NOT the listing token, which
//                           every listed server holds).
import express, {
  Router,
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { STATUS_CODES } from 'node:http';
import { createAdmission } from '../rate-limit';
import { SESSION_LIFETIME_MS, type AccountService, type ServiceResult } from './account-service';
import type { AccountProgressInfo } from '../../../../shared/typescript/account-profile';
import type { ProgressSnapshot } from './store';
import { mountCommunityRoutes } from './community-routes';

export const SESSION_COOKIE = 'prevast_session';

export interface AccountRouterOptions {
  /**
   * Read on every request: null while accounts are off, including while the
   * web host is still waiting for its accounts database (index.ts).
   */
  service: () => AccountService | null;
  validAdminToken: (token: unknown) => boolean;
  progressServer?: (token: unknown) => string | null;
  profile?: (snapshot: ProgressSnapshot) => Promise<AccountProgressInfo>;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined; // malformed %-escapes: no session, not a 500
      }
    }
  }
  return undefined;
}

function sessionCookie(req: Request, value: string, maxAgeMs: number | null): string {
  const parts = [`${SESSION_COOKIE}=${value}`, 'Path=/api', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeMs !== null) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  // Behind a TLS-terminating proxy req.secure is only true with TRUST_PROXY
  // set; production is HTTPS either way, so never send the cookie in clear.
  if (req.secure || process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

export function createAccountRouter(options: AccountRouterOptions): Router {
  const router = Router();
  // Tighter than the registry: login/register are what a guesser hammers.
  const admission = createAdmission({ perIpTokens: 10, perIpRefillPerMs: 0.002 });
  const readAdmission = createAdmission();
  const serverAdmission = createAdmission();
  const json = express.json({ limit: '4kb' });
  router.use('/api/account', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // JSON-only writes already avoid simple cross-origin forms. Explicitly
    // reject foreign origins as well, including sibling subdomains.
    const origin = req.get('origin');
    if (req.method !== 'GET' && origin && origin !== `${req.protocol}://${req.get('host')}`) {
      res.status(403).json({ error: 'Use the account page on this site.' });
      return;
    }
    next();
  });
  const requireJson: RequestHandler = (req, res, next) => {
    if (req.is('application/json')) next();
    else res.status(415).json({ error: 'expected application/json' });
  };
  // Pins the service for the rest of the request; handlers behind this read
  // it with accounts(res).
  const enabled: RequestHandler = (_req, res, next) => {
    const service = options.service();
    if (!service) {
      res.status(503).json({ error: 'accounts-disabled' });
      return;
    }
    res.locals.accounts = service;
    next();
  };
  const accounts = (res: Response): AccountService => res.locals.accounts as AccountService;
  const adminAuth: RequestHandler = (req, res, next) => {
    if (options.validAdminToken(req.get('x-account-admin-token'))) next();
    else res.status(403).json({ error: 'account admin token required' });
  };
  const progressAuth: RequestHandler = (req, res, next) => {
    const server = options.progressServer?.(req.get('x-account-progress-token'));
    if (!server) {
      res.status(403).json({ error: 'account progress token required' });
      return;
    }
    res.locals.progressServer = server;
    next();
  };
  const token = (req: Request) => readCookie(req.headers.cookie, SESSION_COOKIE);
  const failed = <T>(
    res: Response,
    r: ServiceResult<T>,
  ): r is { ok: false; status: number; error: string } => {
    if (r.ok) return false;
    res.status(r.status).json({ error: r.error });
    return true;
  };
  const post = [admission, enabled, requireJson, json];

  router.get('/api/account/me', readAdmission, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const service = options.service();
    if (!service) {
      res.json({ enabled: false });
      return;
    }
    const account = await service.me(token(req));
    res.json(account ? { enabled: true, account } : { enabled: true });
  });

  router.get('/api/account/public-key', admission, enabled, (_req, res) => {
    res.json({ publicKey: accounts(res).publicKeyRaw });
  });

  for (const action of ['register', 'login'] as const) {
    router.post(`/api/account/${action}`, ...post, async (req, res) => {
      const r = await accounts(res)[action](req.body, deviceLabel(req.get('user-agent') ?? ''));
      if (failed(res, r)) return;
      res.setHeader(
        'Set-Cookie',
        sessionCookie(
          req,
          r.sessionToken,
          req.body?.remember === false ? null : SESSION_LIFETIME_MS,
        ),
      );
      res.json({ account: r.account });
    });
  }

  router.post('/api/account/logout', ...post, async (req, res) => {
    await accounts(res).logout(token(req));
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    res.json({ ok: true });
  });

  router.post('/api/account/password', ...post, async (req, res) => {
    const r = await accounts(res).changePassword(token(req), req.body);
    if (failed(res, r)) return;
    res.json({ ok: true });
  });

  for (const action of ['security', 'sessions'] as const) {
    router.get(`/api/account/${action}`, readAdmission, enabled, async (req, res) => {
      const r = await accounts(res)[action](token(req));
      if (!failed(res, r)) res.json(r);
    });
  }
  router.get('/api/account/progress', readAdmission, enabled, async (req, res) => {
    const r = await accounts(res).myProgress(token(req));
    if (failed(res, r)) return;
    if (!options.profile) {
      res.status(503).json({ error: 'Profile content is unavailable.' });
      return;
    }
    res.json(await options.profile(r));
  });
  router.post('/api/account/sessions/revoke', ...post, async (req, res) => {
    const r = await accounts(res).revokeSession(token(req), req.body);
    if (failed(res, r)) return;
    if (r.signedOut) res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    res.json(r);
  });
  for (const [route, action] of [
    ['recovery-code', 'recoveryCode'],
    ['email', 'verifyEmail'],
  ] as const) {
    router.post(`/api/account/${route}`, ...post, async (req, res) => {
      const r = await accounts(res)[action](token(req), req.body);
      if (!failed(res, r)) res.json(r);
    });
  }
  for (const [route, action] of [
    ['email/confirm', 'confirmEmail'],
    ['recovery/request', 'requestReset'],
    ['recovery/reset', 'resetPassword'],
  ] as const) {
    router.post(`/api/account/${route}`, ...post, async (req, res) => {
      const r = await accounts(res)[action](req.body);
      if (!failed(res, r)) res.json(r);
    });
  }

  router.post('/api/account/ticket', ...post, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const r = await accounts(res).issueTicket(token(req), req.body);
    if (failed(res, r)) return;
    res.json({ ticket: r.ticket });
  });

  router.get(
    '/api/servers/accounts/:ref',
    serverAdmission,
    enabled,
    adminAuth,
    async (req, res) => {
      const account = await accounts(res).lookup(String(req.params.ref));
      if (!account) res.status(404).json({ error: 'No such account.' });
      else res.json(account);
    },
  );

  router.post(
    '/api/servers/accounts/group',
    serverAdmission,
    enabled,
    adminAuth,
    requireJson,
    json,
    async (req, res) => {
      const r = await accounts(res).setGroup(req.body);
      if (failed(res, r)) return;
      res.json({ account: r.account });
    },
  );

  // Progress credentials grant no account administration. Their server id
  // namespaces batch deduplication so two servers cannot collide.
  const progressJson = express.json({ limit: '512kb' });
  router.get(
    '/api/servers/progress/:accountId',
    serverAdmission,
    enabled,
    progressAuth,
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const r = await accounts(res).progress(Number(req.params.accountId));
      if (failed(res, r)) return;
      res.json({ stats: r.stats, achievements: r.achievements });
    },
  );

  router.post(
    '/api/servers/progress',
    serverAdmission,
    enabled,
    progressAuth,
    requireJson,
    progressJson,
    async (req, res) => {
      const r = await accounts(res).applyProgress(req.body, res.locals.progressServer as string);
      if (failed(res, r)) return;
      res.json({ ok: true, applied: r.applied });
    },
  );

  mountCommunityRoutes(router, options);

  // Express 5 forwards a rejected async handler here automatically; this is
  // about the response shape, not crash safety -- an unexpected error must
  // still answer JSON, not Express's default HTML/stack-trace page. A client
  // error that carries its status (body-parser's 400 bad JSON, 413 too
  // large) keeps it, with a generic message.
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    const e = error as { status?: unknown; statusCode?: unknown } | null;
    const status = Number(e?.status ?? e?.statusCode);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      res.status(status).json({ error: STATUS_CODES[status] ?? 'Bad request.' });
      return;
    }
    console.error('[accounts]', error);
    res.status(500).json({ error: 'Internal error.' });
  };
  router.use(onError);

  return router;
}

function deviceLabel(agent: string): string {
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Browser';
  const system = /Android/.test(agent)
    ? 'Android'
    : /iPhone|iPad/.test(agent)
      ? 'iOS'
      : /Windows/.test(agent)
        ? 'Windows'
        : /Macintosh/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : '';
  return system ? `${browser} on ${system}` : browser;
}
