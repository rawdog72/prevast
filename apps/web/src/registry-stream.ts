// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import type { RequestHandler, Response } from 'express';
import type { Registry } from './registry';

export const LIST_STREAM_BATCH_MS = 1_000;
export const LIST_STREAM_KEEPALIVE_MS = 25_000;

interface StreamOptions {
  maxConnections?: number;
  maxConnectionsPerIp?: number;
}

interface Viewer {
  response: Response;
  ip: string;
  lastSnapshot: string;
  blocked: boolean;
}

/** One shared subscription/timer per web host, independent of viewer count. */
export function createRegistryStream(
  registry: Registry,
  options: StreamOptions = {},
): RequestHandler {
  const viewers = new Set<Viewer>();
  const perIp = new Map<string, number>();
  const maxConnections = options.maxConnections ?? 512;
  const maxPerIp = options.maxConnectionsPerIp ?? 32;
  let unsubscribe: (() => void) | undefined;
  let batch: ReturnType<typeof setTimeout> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const write = (viewer: Viewer, frame: string): void => {
    const res = viewer.response;
    if (res.destroyed || res.writableEnded) return;
    // Never queue an unbounded history behind a slow reader. The next
    // connection gets a fresh snapshot, so losing intermediate states is safe.
    if (viewer.blocked) {
      res.destroy();
      return;
    }
    viewer.blocked = !res.write(frame);
  };

  const sendSnapshot = (viewer: Viewer, snapshot: string): void => {
    if (viewer.lastSnapshot === snapshot) return;
    viewer.lastSnapshot = snapshot;
    write(viewer, `event: servers\ndata: ${snapshot}\n\n`);
  };

  const changed = (): void => {
    if (batch || viewers.size === 0) return;
    // Coalesce a burst into one current snapshot, never a packet per beat or
    // per player event. Unchanged beats renew expiry but produce no SSE data.
    batch = setTimeout(() => {
      batch = undefined;
      const snapshot = JSON.stringify(registry.listed());
      for (const viewer of viewers) sendSnapshot(viewer, snapshot);
    }, LIST_STREAM_BATCH_MS);
    batch.unref();
  };

  return (req, res) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (viewers.size >= maxConnections || (perIp.get(ip) ?? 0) >= maxPerIp) {
      res.set('Retry-After', '20').status(503).json({ error: 'server list stream busy' });
      return;
    }

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform also keeps the compression middleware from buffering SSE.
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const viewer: Viewer = { response: res, ip, lastSnapshot: '', blocked: false };
    viewers.add(viewer);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    res.on('drain', () => {
      viewer.blocked = false;
    });
    res.once('close', () => {
      viewers.delete(viewer);
      const remaining = (perIp.get(viewer.ip) ?? 1) - 1;
      if (remaining) perIp.set(viewer.ip, remaining);
      else perIp.delete(viewer.ip);
      if (viewers.size !== 0) return;
      unsubscribe?.();
      unsubscribe = undefined;
      clearTimeout(batch);
      batch = undefined;
      clearInterval(keepalive);
      keepalive = undefined;
    });

    if (!unsubscribe) {
      unsubscribe = registry.subscribe(changed);
      keepalive = setInterval(() => {
        for (const client of viewers) write(client, ': keepalive\n\n');
      }, LIST_STREAM_KEEPALIVE_MS);
      keepalive.unref();
    }
    // Registration and snapshot are synchronous: there is no fetch/subscribe
    // gap in which an update could be missed. Reconnects always start here.
    const snapshot = JSON.stringify(registry.listed());
    viewer.lastSnapshot = snapshot;
    write(viewer, `retry: 5000\nevent: servers\ndata: ${snapshot}\n\n`);
  };
}
