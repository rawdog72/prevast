// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The server list as the host serves it to the client. The C++ server posts
// heartbeats (apps/web/src/registry.ts normalises them into this shape).
export const SERVER_TYPES = ['survival', 'ghoul', 'br', 'private', 'community'] as const;
export type ServerType = (typeof SERVER_TYPES)[number];

export const SERVER_STATES = ['open', 'closed', 'maintenance', 'startup'] as const;
export type ServerState = (typeof SERVER_STATES)[number];

export interface ListedServer {
  id: string;
  name: string;
  type: ServerType;
  location: string;
  host: string;
  port: number;
  tls: boolean;
  /** Status-protocol port, or null when the server did not report one. */
  statusPort: number | null;
  players: number;
  max: number;
  mapX: number;
  mapY: number;
  state: ServerState;
}

export const SERVER_LIST_PATH = '/api/servers/list';
/** SSE: every connection starts with a complete `servers` snapshot. */
export const SERVER_LIST_EVENTS_PATH = '/api/servers/events';
