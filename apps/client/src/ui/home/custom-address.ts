// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

export interface ServerAddress {
  host: string;
  port: number;
  tls: boolean;
}

const DEFAULT_GAME_PORT = 7172;

/** "host:port", "ws://host:port" or "wss://host:port" typed by the player. */
export function parseCustomAddress(value: string, securePage: boolean): ServerAddress {
  const raw = String(value).trim();
  if (!raw) throw new Error('Enter a server address.');
  const hasScheme = /^[a-z]+:\/\//i.test(raw);
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `ws://${raw}`);
  } catch {
    throw new Error('Use an IP or hostname with a valid port.');
  }
  if (
    !/^wss?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== '/')
  ) {
    throw new Error('Use host:port or ws://host:port, without a path or login details.');
  }
  if (securePage && url.protocol !== 'wss:') {
    throw new Error('This HTTPS page needs a secure wss:// server.');
  }
  const tls = url.protocol === 'wss:';
  const port = Number(url.port || (hasScheme ? (tls ? 443 : 80) : DEFAULT_GAME_PORT));
  if (!(port >= 1 && port <= 65535)) throw new Error('Port must be between 1 and 65535.');
  return { host: url.hostname, port, tls };
}
