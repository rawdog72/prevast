// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Token-bucket admission for the registry routes: one bucket per remote IP plus
// a global one, so a single chatty client cannot starve everyone else and a
// flood cannot exhaust the process.
import type { RequestHandler } from 'express';

interface Budget {
  tokens: number;
  at: number;
}

export interface AdmissionOptions {
  now?: () => number;
  perIpTokens?: number;
  perIpRefillPerMs?: number;
  globalTokens?: number;
  globalRefillPerMs?: number;
  maxTrackedIps?: number;
}

const CLEANUP_EVERY_MS = 30_000;

export function createAdmission(options: AdmissionOptions = {}): RequestHandler {
  const now = options.now ?? Date.now;
  const perIp = options.perIpTokens ?? 20;
  const perIpRefill = options.perIpRefillPerMs ?? 0.01;
  const globalMax = options.globalTokens ?? 200;
  const globalRefill = options.globalRefillPerMs ?? 0.1;
  const maxTrackedIps = options.maxTrackedIps ?? 4096;

  const budgets = new Map<string, Budget>();
  let nextCleanup = 0;
  let globalBudget = globalMax;
  let globalAt = now();

  return (req, res, next) => {
    const t = now();
    if (t >= nextCleanup) {
      for (const [ip, budget] of budgets) if (t - budget.at > CLEANUP_EVERY_MS) budgets.delete(ip);
      nextCleanup = t + CLEANUP_EVERY_MS;
    }
    globalBudget = Math.min(globalMax, globalBudget + Math.max(0, t - globalAt) * globalRefill);
    globalAt = t;

    // req.ip is the socket address unless `trust proxy` is set (TRUST_PROXY),
    // in which case it is the client a trusted proxy forwarded for -- without
    // that, every player behind the proxy would share one budget.
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    let budget = budgets.get(ip);
    if (!budget) {
      if (budgets.size >= maxTrackedIps) {
        res.status(429).json({ error: 'busy' });
        return;
      }
      budget = { tokens: perIp, at: t };
      budgets.set(ip, budget);
    }
    budget.tokens = Math.min(perIp, budget.tokens + Math.max(0, t - budget.at) * perIpRefill);
    budget.at = t;
    if (budget.tokens < 1 || globalBudget < 1) {
      res.status(429).json({ error: 'rate limit' });
      return;
    }
    budget.tokens--;
    globalBudget--;
    next();
  };
}
