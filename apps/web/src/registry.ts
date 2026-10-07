// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Registry for the client's server list.
//
// Each game server POSTs what it is and how full it is every few seconds; this
// keeps the latest beat per server and serves the visible ones. A server that
// stops beating ages out, so the list needs no maintenance by hand. The
// HTTP wrapper lives in registry-routes.ts.
import net from 'node:net';
import {
  SERVER_STATES,
  SERVER_TYPES,
  type ListedServer,
  type ServerState,
  type ServerType,
} from '../../../shared/typescript/server-list';

/** A server is dropped after this many missed beats. */
export const MISSED_BEATS_BEFORE_DROP = 3;
export const DEFAULT_INTERVAL_SECONDS = 10;
export const MAX_INTERVAL_SECONDS = 300;
export const MAX_SERVERS = 1000;

const MAX_NAME_LENGTH = 24;
const MAX_LOCATION_LENGTH = 16;
const MAX_ID_LENGTH = 64;
const MAX_HOST_LENGTH = 255;

export interface RegistryEntry extends ListedServer {
  visible: boolean;
  version: number;
  uptime: number;
  interval: number;
  lastSeen: number;
}

export interface HeartbeatResult {
  status: number;
  body: Record<string, unknown>;
}

function asString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  // Control characters would reach a browser dropdown; strip them here.
  return value
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function asInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** A TCP port, or null: 0, 70000 or "x" is a broken beat, never port 1 or 65535. */
function asPort(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value as string) ? (value as T) : fallback;
}

export function validHost(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return (
    net.isIP(bare) !== 0 ||
    (host.length <= 253 &&
      host
        .split('.')
        .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))
  );
}

function compareEntries(a: RegistryEntry, b: RegistryEntry): number {
  return (
    a.type.localeCompare(b.type) ||
    a.location.localeCompare(b.location) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

function toListed(entry: RegistryEntry): ListedServer {
  const { id, name, type, location, host, port, tls, statusPort, players, max, mapX, mapY, state } =
    entry;
  return { id, name, type, location, host, port, tls, statusPort, players, max, mapX, mapY, state };
}

/** Stored data is validated strictly; restoring must never invent a server address. */
function isSnapshotEntry(value: unknown): value is RegistryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const string = (key: string, length: number) =>
    typeof entry[key] === 'string' && entry[key] === asString(entry[key], length);
  const integer = (key: string, min: number, max: number) =>
    typeof entry[key] === 'number' &&
    Number.isSafeInteger(entry[key]) &&
    entry[key] >= min &&
    entry[key] <= max;
  return (
    string('id', MAX_ID_LENGTH) &&
    entry.id !== '' &&
    string('host', MAX_HOST_LENGTH) &&
    validHost(entry.host as string) &&
    integer('port', 1, 65535) &&
    (entry.statusPort === null || integer('statusPort', 1, 65535)) &&
    typeof entry.tls === 'boolean' &&
    typeof entry.visible === 'boolean' &&
    (string('name', MAX_NAME_LENGTH) || entry.name === entry.id) &&
    entry.name !== '' &&
    string('location', MAX_LOCATION_LENGTH) &&
    (SERVER_TYPES as readonly unknown[]).includes(entry.type) &&
    (SERVER_STATES as readonly unknown[]).includes(entry.state) &&
    ['players', 'max', 'mapX', 'mapY', 'version'].every((key) => integer(key, 0, 100000)) &&
    integer('uptime', 0, Number.MAX_SAFE_INTEGER) &&
    integer('interval', 1, MAX_INTERVAL_SECONDS) &&
    integer('lastSeen', 0, Number.MAX_SAFE_INTEGER)
  );
}

export class Registry {
  private readonly servers = new Map<string, RegistryEntry>();
  private readonly listeners = new Set<() => void>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private notifying = false;

  constructor(
    private readonly validToken: (token: unknown) => boolean,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = console.log,
  ) {}

  heartbeat(body: unknown): HeartbeatResult {
    if (!body || typeof body !== 'object') {
      return { status: 400, body: { error: 'expected a JSON object' } };
    }
    const beat = body as Record<string, unknown>;
    if (!this.validToken(beat.token)) return { status: 403, body: { error: 'bad token' } };

    const now = this.now();
    this.dropStale(now);
    const id = asString(beat.id, MAX_ID_LENGTH);
    if (!id) return { status: 400, body: { error: 'missing id' } };

    if (beat.offline) {
      if (this.servers.delete(id)) {
        this.log(`[registry] ${id} went offline`);
        this.changed();
      }
      return { status: 200, body: { ok: true } };
    }

    let host = asString(beat.host, MAX_HOST_LENGTH);
    const port = asPort(beat.port);
    if (!host || port === null || !validHost(host)) {
      return { status: 400, body: { error: 'missing host or port' } };
    }
    if (net.isIP(host) === 6) host = `[${host}]`;
    if (!this.servers.has(id) && this.servers.size >= MAX_SERVERS) {
      return { status: 503, body: { error: 'registry full' } };
    }

    const known = this.servers.has(id);
    const entry: RegistryEntry = {
      id,
      host,
      port,
      tls: Boolean(beat.tls),
      statusPort: asPort(beat.statusPort),
      name: asString(beat.name, MAX_NAME_LENGTH) || id,
      type: oneOf<ServerType>(beat.type, SERVER_TYPES, 'survival'),
      location: asString(beat.location, MAX_LOCATION_LENGTH),
      players: asInt(beat.players, 0, 100000, 0),
      max: asInt(beat.max, 0, 100000, 0),
      mapX: asInt(beat.mapX, 0, 100000, 0),
      mapY: asInt(beat.mapY, 0, 100000, 0),
      state: oneOf<ServerState>(beat.state, SERVER_STATES, 'open'),
      visible: Boolean(beat.visible),
      version: asInt(beat.version, 0, 100000, 0),
      uptime: asInt(beat.uptime, 0, Number.MAX_SAFE_INTEGER, 0),
      interval: asInt(beat.interval, 1, MAX_INTERVAL_SECONDS, DEFAULT_INTERVAL_SECONDS),
      lastSeen: now,
    };
    this.servers.set(id, entry);
    if (!known) this.log(`[registry] ${id} joined the list as "${entry.name}" (${entry.type})`);
    this.changed();
    return { status: 200, body: { ok: true } };
  }

  /** Changes include unchanged heartbeats because their freshness must be persisted. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.scheduleExpiry();
    return () => {
      this.listeners.delete(listener);
      this.scheduleExpiry();
    };
  }

  /** Live entries only, including hidden servers, without credentials or derived fields. */
  snapshot(): RegistryEntry[] {
    this.dropStale(this.now());
    return [...this.servers.values()].map((entry) => ({ ...entry }));
  }

  /** Restore a validated, authenticated snapshot without renewing any heartbeat. */
  restore(snapshot: unknown): boolean {
    const now = this.now();
    if (!Array.isArray(snapshot) || snapshot.length > MAX_SERVERS) return false;
    if (!snapshot.every(isSnapshotEntry)) return false;
    const ids = new Set<string>();
    for (const entry of snapshot) {
      if (entry.lastSeen > now || ids.has(entry.id)) return false;
      ids.add(entry.id);
    }
    this.servers.clear();
    for (const entry of snapshot) {
      if (now - entry.lastSeen <= entry.interval * 1000 * MISSED_BEATS_BEFORE_DROP) {
        // Copy known fields only; no extra properties from disk enter the registry.
        const { visible, version, uptime, interval, lastSeen } = entry;
        this.servers.set(entry.id, {
          ...toListed(entry),
          visible,
          version,
          uptime,
          interval,
          lastSeen,
        });
      }
    }
    this.changed();
    return true;
  }

  /** Visible, live servers in a stable order. Hidden servers are filtered here, never in the browser. */
  listed(): ListedServer[] {
    this.dropStale(this.now());
    return [...this.servers.values()]
      .filter((e) => e.visible)
      .sort(compareEntries)
      .map(toListed);
  }

  /**
   * `host:port` of a live server with this id, hidden or not (IPv6 hosts
   * bracketed, as stored), or null. Login tickets are signed only for these
   * and bind this address, so a heartbeat that reuses another server's id with
   * its own host gets tickets the real server refuses.
   */
  address(id: string): string | null {
    this.dropStale(this.now());
    const entry = this.servers.get(id);
    return entry ? `${entry.host}:${entry.port}` : null;
  }

  /** Everything the registry knows, hidden servers included. For operators. */
  all(): (RegistryEntry & { secondsSinceBeat: number })[] {
    const now = this.now();
    this.dropStale(now);
    return [...this.servers.values()].map((entry) => ({
      ...entry,
      secondsSinceBeat: Math.round((now - entry.lastSeen) / 1000),
    }));
  }

  private dropStale(now: number): void {
    let changed = false;
    for (const [id, entry] of this.servers) {
      if (now - entry.lastSeen > entry.interval * 1000 * MISSED_BEATS_BEFORE_DROP) {
        this.servers.delete(id);
        changed = true;
        this.log(`[registry] ${id} timed out and left the list`);
      }
    }
    if (changed) this.changed();
  }

  private changed(): void {
    this.scheduleExpiry();
    // A subscriber may read listed()/snapshot(), which also discard stale entries.
    if (this.notifying) return;
    this.notifying = true;
    try {
      for (const listener of this.listeners) listener();
    } finally {
      this.notifying = false;
    }
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (this.listeners.size === 0 || this.servers.size === 0) return;
    let expires = Infinity;
    for (const entry of this.servers.values()) {
      expires = Math.min(
        expires,
        entry.lastSeen + entry.interval * 1000 * MISSED_BEATS_BEFORE_DROP + 1,
      );
    }
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = undefined;
        this.dropStale(this.now());
        this.scheduleExpiry();
      },
      Math.max(1, expires - this.now()),
    );
    this.expiryTimer.unref();
  }
}
