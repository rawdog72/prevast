// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Automated end-to-end live smoke test verifying:
// 1. Site HTTP endpoints & bundle delivery
// 2. Status WS query (7171)
// 3. Game WS connection, login, content sync, and ticks (7172)
// 4. Start-screen DOM wiring against live services (JSDOM)
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';
import { unwrapBatch } from '../../apps/client/src/net/batch';
import { DisconnectReason, ServerOpcode } from '../../apps/client/src/net/opcodes';
import { queryServerStatus } from '../../apps/client/src/net/status-query';
import { StartScreen, type JoinRequest } from '../../apps/client/src/ui/home/start-screen';

const webUrl = process.env.SMOKE_WEB_URL ?? 'http://127.0.0.1:3100';
const gamePort = Number(process.env.SMOKE_GAME_PORT ?? 8172);
const statusPort = Number(process.env.SMOKE_STATUS_PORT ?? 8171);

async function testHttp(): Promise<void> {
  console.log('[Smoke] Testing HTTP endpoints...');
  const resHtml = await fetch(`${webUrl}/`);
  if (resHtml.status !== 200) throw new Error(`GET / returned status ${resHtml.status}`);
  const html = await resHtml.text();
  if (!html.includes('id="can"') || !html.includes('src="/client.js"')) {
    throw new Error('GET / did not contain expected HTML elements');
  }
  console.log('  ✓ GET / returned valid game HTML');

  const resJs = await fetch(`${webUrl}/client.js`);
  if (resJs.status !== 200) throw new Error(`GET /client.js returned ${resJs.status}`);
  const js = await resJs.text();
  if (js.length < 500_000) throw new Error(`client.js suspiciously small: ${js.length} bytes`);
  console.log(`  ✓ GET /client.js returned valid bundle (${(js.length / 1024).toFixed(1)} KB)`);

  const resList = await fetch(`${webUrl}/api/servers/list`);
  if (resList.status !== 200) throw new Error(`GET /api/servers/list returned ${resList.status}`);
  const list = await resList.json();
  if (!Array.isArray(list) || list.length === 0) throw new Error('Server list empty');
  console.log(
    `  ✓ GET /api/servers/list returned ${list.length} server(s): "${list[0].name}" (${list[0].id})`,
  );
}

async function testStatusWs(): Promise<void> {
  console.log('[Smoke] Testing status WebSocket on the configured status port...');
  const probe = await queryServerStatus({
    host: '127.0.0.1',
    port: statusPort,
    tls: false,
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  console.log(
    `  ✓ Status probe succeeded in ${probe.rttMs.toFixed(1)}ms: players=${probe.status.players}/${probe.status.playersMax}, uptime=${probe.status.uptime}s`,
  );
}

async function testServerListStream(): Promise<void> {
  console.log('[Smoke] Testing immediate server-list snapshot and reconnect...');
  // Each connection must have its own snapshot; neither waits for the next
  // game-server heartbeat nor depends on a preceding GET /api/servers/list.
  for (let attempt = 0; attempt < 2; attempt++) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5000);
    try {
      const response = await fetch(`${webUrl}/api/servers/events`, { signal: abort.signal });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
        throw new Error(`Server-list stream unavailable: ${response.status}`);
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let frame = '';
      while (!frame.includes('\n\n')) {
        const { done, value } = await reader.read();
        if (done) throw new Error('Server-list stream ended before initial snapshot');
        frame += decoder.decode(value, { stream: true });
      }
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      const list = data ? JSON.parse(data.slice(6)) : null;
      if (!Array.isArray(list) || !list.some((entry) => entry.id === 'isolated-smoke')) {
        throw new Error('Initial server-list stream snapshot is missing the live server');
      }
    } finally {
      clearTimeout(timeout);
      abort.abort();
    }
  }
  console.log('  ✓ Both stream connections received the live server immediately.');
}

// Protocol 30, version 0 (exempt from the version check), empty session token,
// ids 0/0, no ad blocker, empty password, then [u16 len][account ticket].
function loginPacket(nickname: string, ticket = ''): Buffer {
  const str = (text: string): Buffer => {
    const bytes = Buffer.from(text, 'utf8');
    const len = Buffer.alloc(2);
    len.writeUInt16LE(bytes.length, 0);
    return Buffer.concat([len, bytes]);
  };
  const head = Buffer.alloc(3);
  head.writeUInt8(30, 0);
  head.writeUInt16LE(0, 1);
  const ids = Buffer.alloc(8);
  const ad = Buffer.alloc(1);
  return Buffer.concat([head, str(''), ids, str(nickname), ad, str(''), str(ticket)]);
}

async function testGameWs(): Promise<void> {
  console.log('[Smoke] Testing game WebSocket on the configured game port...');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gamePort}`);
    let frames = 0;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout waiting for game frames after ${frames} frames`));
    }, 5000);

    ws.on('open', () => {
      console.log('  ✓ Connected to game server. Sending login packet...');
      ws.send(loginPacket('SmokeBot'));
    });

    ws.on('message', (data) => {
      frames++;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const opcode = buf[0];
      console.log(`  ✓ Received frame #${frames}: opcode ${opcode} (${buf.length} bytes)`);
      if (frames >= 3) {
        clearTimeout(timer);
        ws.close();
        console.log(`  ✓ Received ${frames} game frames cleanly.`);
        resolve();
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function testRejectedAccountTicket(): Promise<void> {
  console.log('[Smoke] A rejected account ticket never creates a guest...');
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gamePort}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('no frames after login with a ticket'));
    }, 5000);
    ws.on('open', () => ws.send(loginPacket('TicketBot', 'bm90LmEudGlja2V0.c2ln')));
    ws.on('message', (data) => {
      for (const packet of unwrapBatch(new Uint8Array(data as Buffer))) {
        if (packet[0] === ServerOpcode.HANDSHAKE) {
          clearTimeout(timer);
          ws.close();
          reject(new Error('A rejected account ticket created a player'));
          return;
        }
        if (packet[0] === ServerOpcode.DISCONNECT_REASON) {
          clearTimeout(timer);
          ws.close();
          if (packet[1] === DisconnectReason.ACCOUNT_REQUIRED) resolve();
          else reject(new Error(`Expected ACCOUNT_REQUIRED (15), got ${packet[1]}`));
        }
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  console.log('  ✓ Account join refused; guest play requires a separate login.');
}

async function testRefusedLoginGetsReason(): Promise<void> {
  console.log('[Smoke] A malformed login is refused with DISCONNECT_REASON and never joins...');
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gamePort}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('no DISCONNECT_REASON after a malformed login'));
    }, 5000);
    // One byte past the end of a valid frame: the server refuses it as INVALID_LOGIN.
    ws.on('open', () => ws.send(Buffer.concat([loginPacket('BadBot'), Buffer.from([0])])));
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      // A CONTENT_MANIFEST may come first and is ignored.
      if (buf[0] === ServerOpcode.HANDSHAKE) {
        clearTimeout(timer);
        ws.close();
        reject(new Error('HANDSHAKE after a malformed login'));
        return;
      }
      if (buf[0] === ServerOpcode.DISCONNECT_REASON) {
        clearTimeout(timer);
        ws.close();
        if (buf[1] !== DisconnectReason.INVALID_LOGIN) reject(new Error(`expected INVALID_LOGIN (6), got reason ${buf[1]}`));
        else resolve();
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  console.log('  ✓ Refused with INVALID_LOGIN.');
}

async function testLiveStartScreen(): Promise<void> {
  console.log('[Smoke] Testing live StartScreen UI with live server list and ping...');
  const html = readFileSync('apps/client/public/index.html', 'utf8');
  const dom = new JSDOM(html, { url: `${webUrl}/`, pretendToBeVisual: true });
  const { document, window } = dom.window;

  let joinReq: JoinRequest | null = null;
  const screen = new StartScreen({
    document,
    onJoin: (req) => {
      joinReq = req;
    },
    fetchList: async () => {
      const res = await fetch(`${webUrl}/api/servers/list`);
      return res.json();
    },
    ping: async (target) => {
      return queryServerStatus({
        ...target,
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      });
    },
  });

  screen.show();
  // Allow async fetchList and ping to resolve
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const select = document.querySelector<HTMLSelectElement>('#servers');
    if (select && select.options.length > 0 && select.options[0]?.textContent) break;
  }

  const select = document.querySelector<HTMLSelectElement>('#servers');
  if (!select || select.options.length === 0) {
    throw new Error('Server dropdown was not populated by live StartScreen');
  }

  const optText = select.options[0]?.textContent ?? '';
  console.log(`  ✓ StartScreen dropdown populated: "${optText}"`);
  if (!optText.includes('Prevast')) {
    throw new Error(`Expected option text to contain 'Prevast', got '${optText}'`);
  }

  const playBtn = document.querySelector<HTMLButtonElement>('.dv-play');
  if (!playBtn) throw new Error('Play button not found');
  if (playBtn.disabled) throw new Error('Play button remained disabled');

  const form = document.querySelector<HTMLFormElement>('.dv-form');
  form?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  if (!joinReq) {
    throw new Error('Form submission did not trigger onJoin');
  }
  const targetReq: JoinRequest = joinReq;
  if (!targetReq.server) {
    throw new Error('Expected targetReq.server to be set');
  }
  console.log(
    `  ✓ Play button triggered onJoin with server: "${targetReq.server.name}" (${targetReq.server.id})`,
  );
}

async function main(): Promise<void> {
  console.log('========================================');
  console.log('Prevast Live Smoke Test Suite');
  console.log('========================================');
  try {
    await testHttp();
    await testServerListStream();
    await testStatusWs();
    await testGameWs();
    await testRejectedAccountTicket();
    await testRefusedLoginGetsReason();
    await testLiveStartScreen();
    console.log('========================================');
    console.log('All Smoke Tests Passed Successfully! ✓');
    console.log('========================================');
    process.exit(0);
  } catch (err) {
    console.error('\nSmoke test failed:', err);
    process.exit(1);
  }
}

void main();
