// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Main client entry point.
// Boot sequence: load presentation content -> start screen -> connect -> game loop.
import { CONTENT_TABLES, type ContentTable } from '../../../shared/typescript/content-format';
import { AssetLoader, type SpriteManifest } from './assets/asset-loader';
import { IndexedDbCache } from './content/cache';
import { ContentStore } from './content/store';
import { CanvasManager } from './core/canvas';
import { onceUnlessFailed } from './core/once';
import { readSetting, writeSetting } from './core/storage';
import { WorldEditor } from './editor/world-editor';
import { GameLoop } from './game/game-loop';
import { PlaySession, type PlayConnection } from './game/play-session';
import { NetEventBus } from './net/events';
import { GameSocket } from './net/socket';
import { createAccountApi } from './ui/home/account-api';
import { StartScreen, type JoinRequest, type PreloadProgress } from './ui/home/start-screen';
import { DisconnectWindow } from './ui/windows/disconnect-window';

const contentStore = new ContentStore();
const contentCache = new IndexedDbCache();
const assetLoader = new AssetLoader();

/** Start-screen visual preparation progress; set once the screen exists. */
let reportPreload: (progress: PreloadProgress | null) => void = () => {};

async function fetchSpriteManifest(): Promise<void> {
  try {
    const res = await fetch('/sprite-manifest.json');
    if (res.ok) assetLoader.setManifest((await res.json()) as SpriteManifest);
  } catch {
    // Without the manifest URLs are unversioned and unknown names 404 once each; still playable.
  }
}

async function fetchContentTables(): Promise<void> {
  reportPreload({ done: 0, total: 0 });
  const promises = CONTENT_TABLES.map(async (name) => {
    const res = await fetch(`/content/${name}.json`);
    if (!res.ok) throw new Error(`Failed to fetch /content/${name}.json: ${res.statusText}`);
    const table = (await res.json()) as ContentTable;
    contentStore.load(table);
  });
  try {
    await Promise.all([...promises, fetchSpriteManifest()]);
  } catch (error) {
    reportPreload(null);
    throw error;
  }
  void preloadSprites();
}

/**
 * Sprites in three tiers (see AssetLoader): the core set now, pinned, with
 * progress on the start screen; then, only once that is done and only on an
 * unmetered connection, a low-priority trickle through everything else so a
 * later on-demand load is a cache hit. Day palette first, night second.
 */
async function preloadSprites(): Promise<void> {
  const core = AssetLoader.collectCoreSpriteNames(contentStore);
  reportPreload(core.size ? { done: 0, total: core.size } : null);
  await assetLoader.preloadCore(core, (done, total) => {
    reportPreload({ done, total });
  });
  const saveData =
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
    true;
  if (saveData) return;
  const all = [...AssetLoader.collectSpriteNames(contentStore)].filter((name) => !core.has(name));
  assetLoader.warmCache(all);
  assetLoader.warmCache(
    all.map((name) => (name.startsWith('day-') ? `night-${name.slice(4)}` : '')),
  );
}

// Loaded once and shared; a failed load is forgotten so "Retry" really retries.
const ensureContent = onceUnlessFailed(fetchContentTables);

// Kick off content prefetch immediately
void ensureContent().catch((err) => {
  console.warn('[main] Content prefetch error:', err);
});

// Canvas manager setup
const canvasEl = document.getElementById('can') as HTMLCanvasElement;
if (!canvasEl) {
  throw new Error('Canvas element #can not found in DOM');
}
const canvasManager = new CanvasManager(canvasEl);

const hudRoot = document.getElementById('dv-hud') as HTMLElement;
if (!hudRoot) {
  throw new Error('HUD root #dv-hud not found in DOM');
}
const modalRoot = document.getElementById('dv-modal') as HTMLElement;
if (!modalRoot) {
  throw new Error('Modal root #dv-modal not found in DOM');
}
const invitationRoot = document.getElementById('hud-invitation') as HTMLElement;
if (!invitationRoot) {
  throw new Error('Invitation root #hud-invitation not found in DOM');
}
const disconnectRoot = document.getElementById('dv-disconnect') as HTMLElement;
if (!disconnectRoot) {
  throw new Error('Disconnect root #dv-disconnect not found in DOM');
}
const disconnectWindow = new DisconnectWindow(disconnectRoot);

interface GameConnection extends PlayConnection {
  readonly game: GameLoop;
}

/** The server the player is on (or joining); null before the first Play. */
let session: PlaySession<GameConnection> | null = null;
let activeEditor: WorldEditor | null = null;

function stopEditor(): void {
  if (activeEditor) {
    activeEditor.stop();
    activeEditor = null;
  }
}

async function openEditor(screen: StartScreen): Promise<void> {
  stopEditor();
  screen.setBusy(true);

  try {
    await ensureContent();
  } catch (err) {
    console.error('[main] Content loading failed for editor:', err);
    screen.error('Failed to load content for the World Editor');
    screen.setBusy(false);
    return;
  }

  screen.setBusy(false);
  screen.hide();

  const editor = new WorldEditor({
    content: contentStore,
    assets: assetLoader,
    onExit: () => {
      activeEditor = null;
      screen.show();
    },
  });

  activeEditor = editor;
  editor.start();
}

/**
 * An account ticket for one join attempt, fetched right before connecting
 * (tickets live 60 s). Failed account joins stop before opening a game.
 */
async function fetchAccountTicket(request: JoinRequest): Promise<string> {
  if (!request.server) {
    throw new Error(
      'Accounts only work on listed servers. Choose a listed server or play as a guest.',
    );
  }
  return accountApi.ticket(request.server.id, request.address.host, request.address.port);
}

/** A socket plus a GameLoop that is built now (it must see HANDSHAKE) and started only once joined. */
function openGameConnection(request: JoinRequest, ticket: string): GameConnection {
  const proto = request.address.tls ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${request.address.host}:${request.address.port}`;
  const bus = new NetEventBus();

  // Session restore, as the old client did through localStorage: the server
  // mints a token per session (PLAYER_NAMES) and getPlayerByToken hands the same
  // character back to a client that presents it -- so a reload or a dropped
  // connection resumes the character instead of leaving it AFK in the world
  // next to a fresh copy. Keyed by server so a token never goes to a stranger.
  const sessionKey = `prevast.session.${request.address.host}:${request.address.port}`;
  bus.on('nicknames', (ev) => {
    if (ev.sessionToken) writeSetting(sessionKey, ev.sessionToken);
  });

  const socket = new GameSocket({
    url: wsUrl,
    login: {
      nickname: request.nickname,
      password: request.password,
      token: readSetting(sessionKey) ?? '',
      accountTicket: ticket,
    },
    bus,
    contentStore,
    cache: contentCache,
    onOpen: () => console.info(`[main] Logging in to ${wsUrl}`),
    onClose: (ev) =>
      console.warn(`[main] Game socket closed (${ev.code}${ev.opened ? '' : ', never opened'})`),
    onError: (err) => console.error('[main] Socket error:', err),
  });

  const game = new GameLoop({
    canvasManager,
    content: contentStore,
    assets: assetLoader,
    socket,
    hudRoot,
    modalRoot,
    invitationRoot,
    // The leaderboard is headed with where we are: the listed name, or the host for a custom address.
    serverName: request.server?.name ?? request.address.host,
    onPlayAgain: () => void session?.playAgain(),
    onMainMenu: () => session?.mainMenu(),
    // `?profiler` opens the F2 performance overlay as soon as the game starts.
    profilerOnStart: new URLSearchParams(location.search).has('profiler'),
  });

  return { bus, game, connect: () => socket.connect(), close: () => game.stop() };
}

/**
 * "Play": the start screen stays up with the join's progress until the server
 * confirms (HANDSHAKE); only then does the game appear. A refusal is explained
 * on the start screen, never after a flash of the game.
 */
function startJoin(request: JoinRequest): void {
  stopEditor();
  session = new PlaySession<GameConnection>({
    serverName: request.server?.name ?? request.address.host,
    maxPlayers: request.server?.max,
    screen,
    dialog: disconnectWindow,
    captureFrame: () => {
      try {
        return canvasEl.toDataURL('image/jpeg', 0.7);
      } catch {
        return '';
      }
    },
    ensureContent,
    fetchTicket: request.playAsAccount ? () => fetchAccountTicket(request) : undefined,
    openConnection: (ticket) => openGameConnection(request, ticket),
    onJoined: (connection) => {
      // Console debug handle (like the old client's window.__prevastPerf): lets a
      // dev inspect world/camera state live without a bundler hook.
      (window as unknown as { __prevastGame?: GameLoop }).__prevastGame = connection.game;
    },
    isOnline: () => navigator.onLine,
    waitForOnline: () =>
      new Promise<void>((resolve) =>
        window.addEventListener('online', () => resolve(), { once: true }),
      ),
  });
  void session.start();
}

// Start screen lifecycle
const accountApi = createAccountApi();
const screen = new StartScreen({
  document,
  onJoin: (request) => startJoin(request),
  onCancel: () => session?.cancel(),
  onEditor: () => {
    void openEditor(screen);
  },
  accountApi,
});

screen.show();
reportPreload = (progress) => screen.setPreload(progress);
reportPreload({ done: 0, total: 0 });
