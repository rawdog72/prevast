// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';

export interface AccountMail {
  send(email: string, purpose: 'verify' | 'reset', token: string): Promise<void>;
}

export interface MailConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  publicUrl: string;
}

export function loadMailConfig(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): MailConfig | null {
  const file = path.join(dir, '.account-mail.json');
  const config = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    : {};
  const read = (key: string, variable: string) => String(env[variable] ?? config[key] ?? '').trim();
  const host = read('host', 'ACCOUNT_SMTP_HOST');
  if (!host) return null;
  const port = Number(read('port', 'ACCOUNT_SMTP_PORT') || 587);
  const from = read('from', 'ACCOUNT_MAIL_FROM');
  const publicUrl = read('publicUrl', 'ACCOUNT_PUBLIC_URL');
  const url = new URL(publicUrl);
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('ACCOUNT_PUBLIC_URL must be an HTTPS origin (HTTP is allowed for localhost).');
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^[^\s@,;<>]+@[^\s@,;<>]+$/.test(from)
  )
    throw new Error('Set a valid ACCOUNT_SMTP_PORT and ACCOUNT_MAIL_FROM address.');
  return {
    host,
    port,
    from,
    publicUrl: url.origin,
    user: read('user', 'ACCOUNT_SMTP_USER'),
    password: String(env.ACCOUNT_SMTP_PASSWORD ?? config.password ?? ''),
  };
}

export function createAccountMail(config: MailConfig): AccountMail {
  const local = ['localhost', '127.0.0.1', '::1'].includes(config.host);
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: !local,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async send(email, purpose, token) {
      const verification = purpose === 'verify';
      const link = `${config.publicUrl}/#account-${purpose}=${encodeURIComponent(token)}`;
      await transport.sendMail({
        from: config.from,
        to: { name: '', address: email },
        subject: verification ? 'Verify your Prevast recovery email' : 'Reset your Prevast password',
        text: `${verification ? 'Confirm this email address for account recovery' : 'Choose a new password'}:\n\n${link}\n\nThis link works once and expires in ${verification ? 30 : 15} minutes. If you did not request it, ignore this email.`,
      });
    },
  };
}
