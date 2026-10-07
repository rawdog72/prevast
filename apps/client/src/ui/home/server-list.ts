// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import {
  SERVER_LIST_PATH,
  SERVER_STATES,
  SERVER_TYPES,
  type ListedServer,
  type ServerType,
} from '../../../../../shared/typescript/server-list';

export type HomeMode = 'survival' | 'ghoul' | 'br' | 'private' | 'custom';
export const HOME_MODES: readonly HomeMode[] = ['survival', 'ghoul', 'br', 'private', 'custom'];

const TYPES_FOR_MODE: Record<Exclude<HomeMode, 'custom'>, readonly ServerType[]> = {
  survival: ['survival'],
  ghoul: ['ghoul'],
  br: ['br'],
  private: ['private', 'community'],
};

export function serversForMode(list: readonly ListedServer[], mode: HomeMode): ListedServer[] {
  if (mode === 'custom') return [];
  const types = TYPES_FOR_MODE[mode];
  return list.filter((server) => types.includes(server.type));
}

/** Stable identity of a listed server across refreshes. */
export function serverKey(server: Pick<ListedServer, 'host' | 'port'>): string {
  return `${server.host}:${server.port}`;
}

/** What a status probe contributed; `rttMs` null means it did not answer. */
export interface PingResult {
  rttMs: number | null;
  players?: number;
  max?: number;
}

export function optionLabel(server: ListedServer, ping?: PingResult): string {
  // Registry snapshots are authoritative; an older RTT probe must not replace
  // newer player counts delivered by the listing stream.
  const { players, max } = server;
  const parts = [server.name, `${players}${max > 0 ? `/${max}` : ''} players`];
  if (server.location) parts.push(server.location);
  if (server.mapX > 0 && server.mapY > 0) parts.push(`${server.mapX}x${server.mapY}`);
  if (ping) parts.push(ping.rttMs === null ? 'no response' : `${ping.rttMs} ms`);
  let label = parts.join('  -  ');
  if (server.state === 'closed') label += '  (closed)';
  else if (max > 0 && players >= max) label += '  (full)';
  return label;
}

export function parseServerList(data: unknown): ListedServer[] {
  if (!Array.isArray(data)) throw new Error('Server list is not an array.');
  for (const value of data) {
    if (!value || typeof value !== 'object') throw new Error('Invalid server listing.');
    const s = value as Record<string, unknown>;
    if (
      !['id', 'name', 'location', 'host'].every((key) => typeof s[key] === 'string') ||
      !['port', 'players', 'max', 'mapX', 'mapY'].every(
        (key) => typeof s[key] === 'number' && Number.isFinite(s[key]),
      ) ||
      typeof s.tls !== 'boolean' ||
      (s.statusPort !== null &&
        (typeof s.statusPort !== 'number' || !Number.isFinite(s.statusPort))) ||
      !SERVER_TYPES.includes(s.type as ServerType) ||
      !SERVER_STATES.includes(s.state as ListedServer['state'])
    )
      throw new Error('Invalid server listing.');
  }
  return data as ListedServer[];
}

export async function fetchServerList(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ListedServer[]> {
  const response = await fetchImpl(SERVER_LIST_PATH, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`Server list request failed (${response.status}).`);
  return parseServerList(await response.json());
}
