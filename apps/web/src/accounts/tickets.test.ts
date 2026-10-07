// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { encodeTicketPayload, newNonce, readTicket, TicketSigner, type TicketClaims } from './tickets';

const claims: TicketClaims = {
  accountId: 42,
  name: 'Alice',
  groupId: 3,
  serverId: 'prevast-development',
  expiresAt: 1_800_000_060,
  nonce: 'abcDEF123_-',
};

describe('tickets', () => {
  it('encodes the payload in field order', () => {
    expect(encodeTicketPayload(claims)).toBe('1|42|Alice|3|prevast-development|1800000060|abcDEF123_-');
  });

  it('carries a server id bound to a bracketed IPv6 address', () => {
    const signer = TicketSigner.fromPem(TicketSigner.generatePem());
    const bound = { ...claims, serverId: 'prevast-development@[2001:db8::1]:7172' };
    expect(readTicket(signer.sign(bound), signer.publicKeyRaw)).toEqual(bound);
  });

  it('refuses a field containing the separator', () => {
    expect(() => encodeTicketPayload({ ...claims, serverId: 'a|b' })).toThrow();
  });

  it('signs tickets that verify with the raw public key only', () => {
    const signer = TicketSigner.fromPem(TicketSigner.generatePem());
    const other = TicketSigner.fromPem(TicketSigner.generatePem());
    const ticket = signer.sign(claims);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(ticket.length).toBeLessThanOrEqual(512);
    expect(Buffer.from(signer.publicKeyRaw, 'base64')).toHaveLength(65);
    expect(readTicket(ticket, signer.publicKeyRaw)).toEqual(claims);
    expect(readTicket(ticket, other.publicKeyRaw)).toBeNull();
    const [payload] = ticket.split('.');
    const forged = `${payload}.${other.sign(claims).split('.')[1]}`;
    expect(readTicket(forged, signer.publicKeyRaw)).toBeNull();
    expect(readTicket('garbage', signer.publicKeyRaw)).toBeNull();
  });

  it('makes url-safe 16-byte nonces', () => {
    const nonce = newNonce();
    expect(Buffer.from(nonce, 'base64url')).toHaveLength(16);
    expect(newNonce()).not.toBe(nonce);
  });

  it('rejects keys that are not P-256', () => {
    expect(() => TicketSigner.fromPem('not a key')).toThrow();
  });
});
