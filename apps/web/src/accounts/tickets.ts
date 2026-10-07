// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Game login tickets: "account A named N in group G may join server S until T
// (nonce X)", signed with ECDSA P-256 so any game server can verify it with the
// public key alone. The C++ side is apps/server/src/network/account_ticket.cpp;
// the payload is plain '|'-separated ASCII so it needs no JSON parser there.
import crypto from 'node:crypto';

export const TICKET_VERSION = 1;
export const TICKET_LIFETIME_S = 60;

export interface TicketClaims {
  accountId: number;
  name: string;
  groupId: number;
  /**
   * `<listingId>@<host>:<port>`: the target server's listingId and the address
   * its registry entry holds (IPv6 hosts bracketed).
   */
  serverId: string;
  /** Unix seconds. */
  expiresAt: number;
  nonce: string;
}

export function encodeTicketPayload(c: TicketClaims): string {
  for (const field of [c.name, c.serverId, c.nonce]) {
    if (field.includes('|')) throw new Error('ticket fields cannot contain "|"');
  }
  return [TICKET_VERSION, c.accountId, c.name, c.groupId, c.serverId, c.expiresAt, c.nonce].join('|');
}

export const newNonce = (): string => crypto.randomBytes(16).toString('base64url');

export function rawPublicKey(key: crypto.KeyObject): string {
  const jwk = key.export({ format: 'jwk' });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url'),
  ]).toString('base64');
}

function publicKeyFromRaw(raw: string): crypto.KeyObject {
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('expected a 65-byte uncompressed P-256 point');
  return crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: bytes.subarray(1, 33).toString('base64url'),
      y: bytes.subarray(33).toString('base64url'),
    },
    format: 'jwk',
  });
}

export class TicketSigner {
  private constructor(
    private readonly privateKey: crypto.KeyObject,
    readonly publicKeyRaw: string,
  ) {}

  static fromPem(pem: string): TicketSigner {
    const privateKey = crypto.createPrivateKey(pem);
    if (
      privateKey.asymmetricKeyType !== 'ec' ||
      privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    ) {
      throw new Error('The account signing key must be an EC P-256 (prime256v1) key.');
    }
    return new TicketSigner(privateKey, rawPublicKey(crypto.createPublicKey(privateKey)));
  }

  static generatePem(): string {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  }

  sign(claims: TicketClaims): string {
    const payload = Buffer.from(encodeTicketPayload(claims), 'utf8');
    const signature = crypto.sign('sha256', payload, { key: this.privateKey, dsaEncoding: 'ieee-p1363' });
    return `${payload.toString('base64url')}.${signature.toString('base64url')}`;
  }
}

export function readTicket(ticket: string, publicKeyRaw: string): TicketClaims | null {
  const parts = ticket.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const payload = Buffer.from(parts[0], 'base64url');
  const valid = crypto.verify(
    'sha256',
    payload,
    { key: publicKeyFromRaw(publicKeyRaw), dsaEncoding: 'ieee-p1363' },
    Buffer.from(parts[1], 'base64url'),
  );
  if (!valid) return null;
  const f = payload.toString('utf8').split('|');
  if (f.length !== 7 || f[0] !== String(TICKET_VERSION)) return null;
  return {
    accountId: Number(f[1]),
    name: f[2]!,
    groupId: Number(f[3]),
    serverId: f[4]!,
    expiresAt: Number(f[5]),
    nonce: f[6]!,
  };
}
