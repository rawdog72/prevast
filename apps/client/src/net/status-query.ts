// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The game server's status protocol (protocolstatus.cpp): open a WebSocket to
// the status port, send the text frame "[255]", receive one JSON text frame,
// and the server closes. Used by the home screen for a client-measured ping
// and live counts.

export interface ServerStatus {
  uptime: number;
  players: number;
  playersMax: number;
  mapName?: string;
  version?: number | string;
  client?: string;
  // Sent by newer servers only.
  mode?: string;
  protocolVersion?: number;
  contentHash?: string;
}

export interface StatusProbe {
  rttMs: number;
  status: ServerStatus;
}

export interface StatusTarget {
  host: string;
  port: number;
  tls: boolean;
}

export interface StatusQueryOptions extends StatusTarget {
  timeoutMs?: number;
  signal?: AbortSignal;
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
}

const STATUS_REQUEST = '[255]';
const DEFAULT_TIMEOUT_MS = 3000;

export function statusUrl(target: StatusTarget): string {
  return `${target.tls ? 'wss' : 'ws'}://${target.host}:${target.port}`;
}

export function queryServerStatus(options: StatusQueryOptions): Promise<StatusProbe> {
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const now = options.now ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Status query cancelled.'));
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocketImpl(statusUrl(options));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let sentAt = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Status query timed out.')), timeoutMs);
    const cancel = () => finish(new Error('Status query cancelled.'));
    options.signal?.addEventListener('abort', cancel, { once: true });

    function finish(error: Error | null, probe?: StatusProbe): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      if (error) reject(error);
      else resolve(probe as StatusProbe);
    }

    socket.onopen = () => {
      sentAt = now();
      socket.send(STATUS_REQUEST);
    };
    socket.onmessage = (event) => {
      const rttMs = Math.round(now() - sentAt);
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        finish(new Error('Status reply is not JSON.'));
        return;
      }
      if (!parsed || typeof parsed !== 'object') {
        finish(new Error('Status reply is not an object.'));
        return;
      }
      finish(null, { rttMs, status: parsed as ServerStatus });
    };
    socket.onerror = () => finish(new Error('Status socket failed.'));
    socket.onclose = () => finish(new Error('Status socket closed before replying.'));
  });
}
