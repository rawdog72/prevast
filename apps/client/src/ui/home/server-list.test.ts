// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import type { ListedServer } from '../../../../../shared/typescript/server-list';
import { fetchServerList, optionLabel, serverKey, serversForMode } from './server-list';

const server = (extra: Partial<ListedServer>): ListedServer => ({
  id: 'x',
  name: 'Local',
  type: 'survival',
  location: '',
  host: '127.0.0.1',
  port: 7172,
  tls: false,
  statusPort: 7171,
  players: 2,
  max: 40,
  mapX: 0,
  mapY: 0,
  state: 'open',
  ...extra,
});

describe('serversForMode', () => {
  const list = [
    server({ id: 's', type: 'survival' }),
    server({ id: 'g', type: 'ghoul' }),
    server({ id: 'b', type: 'br' }),
    server({ id: 'p', type: 'private' }),
    server({ id: 'c', type: 'community' }),
  ];
  it('maps modes to types, and private covers community', () => {
    expect(serversForMode(list, 'survival').map((s) => s.id)).toEqual(['s']);
    expect(serversForMode(list, 'ghoul').map((s) => s.id)).toEqual(['g']);
    expect(serversForMode(list, 'br').map((s) => s.id)).toEqual(['b']);
    expect(serversForMode(list, 'private').map((s) => s.id)).toEqual(['p', 'c']);
    expect(serversForMode(list, 'custom')).toEqual([]);
  });
});

describe('optionLabel', () => {
  it('shows name, players, and optional location, map size, ping and closed state', () => {
    expect(optionLabel(server({}))).toBe('Local  -  2/40 players');
    expect(optionLabel(server({ location: 'EU', mapX: 120, mapY: 90, state: 'closed' }))).toBe(
      'Local  -  2/40 players  -  EU  -  120x90  (closed)',
    );
    expect(optionLabel(server({ max: 0 }), { rttMs: 31, players: 5 })).toBe(
      'Local  -  2 players  -  31 ms',
    );
    expect(optionLabel(server({}), { rttMs: null })).toBe('Local  -  2/40 players  -  no response');
  });
});

describe('optionLabel full hint', () => {
  it('marks a full server as a hint', () => {
    expect(optionLabel(server({ players: 40, max: 40 }))).toBe('Local  -  40/40 players  (full)');
    expect(optionLabel(server({ players: 3, max: 0 }))).toBe('Local  -  3 players');
  });
});

describe('serverKey / fetchServerList', () => {
  it('keys by host:port', () => {
    expect(serverKey(server({}))).toBe('127.0.0.1:7172');
  });
  it('fetches and validates the list', async () => {
    const ok = (async () => new Response(JSON.stringify([server({})]))) as unknown as typeof fetch;
    expect(await fetchServerList(ok)).toEqual([server({})]);
    const bad = (async () => new Response('{}')) as unknown as typeof fetch;
    await expect(fetchServerList(bad)).rejects.toThrow(/array/);
    const malformed = (async () => new Response('[{}]')) as unknown as typeof fetch;
    await expect(fetchServerList(malformed)).rejects.toThrow(/Invalid/);
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(fetchServerList(down)).rejects.toThrow(/503/);
  });
});
