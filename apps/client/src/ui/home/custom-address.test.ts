// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { parseCustomAddress } from './custom-address';

describe('parseCustomAddress', () => {
  it('parses host:port, defaulting to the game port', () => {
    expect(parseCustomAddress('127.0.0.1:7172', false)).toEqual({
      host: '127.0.0.1',
      port: 7172,
      tls: false,
    });
    expect(parseCustomAddress('example.com', false)).toEqual({
      host: 'example.com',
      port: 7172,
      tls: false,
    });
  });

  it('understands ws:// and wss:// with scheme default ports', () => {
    expect(parseCustomAddress('wss://example.com', true)).toEqual({
      host: 'example.com',
      port: 443,
      tls: true,
    });
    expect(parseCustomAddress('ws://example.com', false)).toEqual({
      host: 'example.com',
      port: 80,
      tls: false,
    });
  });

  it('keeps IPv6 brackets', () => {
    expect(parseCustomAddress('[::1]:7172', false).host).toBe('[::1]');
  });

  it.each([
    '',
    'http://example.com',
    'ws://user:pass@host:7172',
    'ws://host:99999',
    'host:0',
    'host:7172/path',
    'host:7172?q=x',
  ])('rejects %j', (value) => {
    expect(() => parseCustomAddress(value, false)).toThrow();
  });

  it('requires wss on an https page', () => {
    expect(() => parseCustomAddress('127.0.0.1:7172', true)).toThrow(/wss/);
  });
});
