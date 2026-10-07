// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { createAccountMail, loadMailConfig } from './mail';

describe('account SMTP', () => {
  it('requires a fixed HTTPS origin outside localhost and rejects invalid sender configuration', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'account-mail-'));
    try {
      expect(loadMailConfig(dir, {})).toBeNull();
      const env = {
        ACCOUNT_SMTP_HOST: 'smtp.example.com',
        ACCOUNT_MAIL_FROM: 'accounts@example.com',
        ACCOUNT_PUBLIC_URL: 'https://game.example.com',
      };
      expect(loadMailConfig(dir, env)).toMatchObject({
        host: 'smtp.example.com',
        port: 587,
        publicUrl: 'https://game.example.com',
      });
      expect(() =>
        loadMailConfig(dir, { ...env, ACCOUNT_PUBLIC_URL: 'http://game.example.com' }),
      ).toThrow(/HTTPS/);
      expect(() =>
        loadMailConfig(dir, { ...env, ACCOUNT_PUBLIC_URL: 'https://game.example.com/other' }),
      ).toThrow(/origin/);
      expect(() =>
        loadMailConfig(dir, { ...env, ACCOUNT_MAIL_FROM: 'a@example.com,b@example.com' }),
      ).toThrow(/MAIL_FROM/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('delivers an expiring recovery link through a local SMTP server without real recipients', async () => {
    let message = '';
    const server = createServer((socket) => {
      socket.write('220 localhost test SMTP\r\n');
      let buffer = '',
        data = false;
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        for (;;) {
          const end = buffer.indexOf('\r\n');
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (data) {
            if (line === '.') {
              data = false;
              socket.write('250 queued\r\n');
            } else message += line + '\n';
          } else if (/^EHLO/.test(line)) socket.write('250 localhost\r\n');
          else if (line === 'DATA') {
            data = true;
            socket.write('354 send message\r\n');
          } else if (line === 'QUIT') socket.end('221 goodbye\r\n');
          else socket.write('250 OK\r\n');
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const mail = createAccountMail({
        host: '127.0.0.1',
        port: (server.address() as { port: number }).port,
        user: '',
        password: '',
        from: 'accounts@example.test',
        publicUrl: 'https://game.example.test',
      });
      await mail.send('player@example.test', 'reset', 'A'.repeat(43));
      expect(message).toContain('Subject: Reset your Prevast password');
      expect(message.replace(/=\n/g, '').replace(/=3D/g, '=')).toContain(
        '/#account-reset=' + 'A'.repeat(43),
      );
      expect(message.replace(/=\n/g, '')).toContain('15 minutes');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
