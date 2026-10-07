// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import express, { Router } from 'express';
import type { Registry } from './registry';
import { createAdmission } from './rate-limit';
import { createRegistryStream } from './registry-stream';
import { SERVER_LIST_PATH, SERVER_LIST_EVENTS_PATH } from '../../../shared/typescript/server-list';

export function createRegistryRouter(
  registry: Registry,
  validToken: (token: unknown) => boolean,
): Router {
  const router = Router();
  const admission = createAdmission();

  router.post('/api/servers/heartbeat', admission, express.json({ limit: '16kb' }), (req, res) => {
    const result = registry.heartbeat(req.body);
    res.status(result.status).json(result.body);
  });

  router.get(SERVER_LIST_PATH, admission, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(registry.listed());
  });

  router.get(SERVER_LIST_EVENTS_PATH, admission, createRegistryStream(registry));

  // Everything the registry knows, hidden servers included. For operators.
  router.get('/api/servers', admission, (req, res) => {
    const header = req.get('authorization') ?? '';
    if (!header.startsWith('Bearer ') || !validToken(header.slice(7))) {
      res.status(403).json({ error: 'operator authentication required' });
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.json(registry.all());
  });

  return router;
}
