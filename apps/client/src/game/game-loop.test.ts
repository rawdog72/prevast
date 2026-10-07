// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentTable } from '../../../../shared/typescript/content-format';
import { AssetLoader } from '../assets/asset-loader';
import { ContentStore } from '../content/store';
import type { CanvasManager } from '../core/canvas';
import { NetEventBus } from '../net/events';
import { GameSocket } from '../net/socket';
import { GameLoop } from './game-loop';
import { newPlayerInfo } from '../world/world-state';
import { ChatChannel } from '../net/opcodes';
import { MODS_IID, modsContent } from '../world/weapon-mods.fixtures';

function createMockCanvasManager(): CanvasManager {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;

  const mockCtx = {
    canvas,
    getTransform: () => ({}),
    setTransform: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    roundRect: () => {},
    fill: () => {},
    stroke: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    drawImage: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    fillText: () => {},
    strokeText: () => {},
    measureText: () => ({ width: 50 }),
    rect: () => {},
    closePath: () => {},
    setLineDash: () => {},
    arc: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    bezierCurveTo: () => {},
    createRadialGradient: () =>
      ({
        addColorStop: () => {},
      }) as unknown as CanvasGradient,
    createLinearGradient: () =>
      ({
        addColorStop: () => {},
      }) as unknown as CanvasGradient,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
  } as unknown as CanvasRenderingContext2D;

  return {
    canvas,
    ctx: mockCtx,
    width: 800,
    height: 600,
    dpr: 1,
    resize: () => {},
    /** The test fires a resize through `fireResize`. */
    onResize(
      this: { fireResize?: (d: { width: number; height: number }) => void },
      cb: (d: { width: number; height: number }) => void,
    ) {
      this.fireResize = cb;
      return () => {};
    },
    destroy: () => {},
    resolutionDivisor: 1,
    setResolutionDivisor(this: { resolutionDivisor: number }, d: number) {
      this.resolutionDivisor = d;
    },
  } as unknown as CanvasManager;
}

function createHudRoot(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="hud-controls"></div>
    <div class="hud-alerts"></div>
    <div class="hud-invitation" hidden></div>
    <div class="hud-topright">
      <canvas class="hud-minimap" width="120" height="120"></canvas>
      <div class="hud-leaderboard"></div>
      <div class="hud-stats" hidden></div>
    </div>
    <div class="hud-chat"></div>
    <div class="hud-gauges"></div>
    <div class="hud-hotbar"></div>
  `;
  // Attached: the chat console's <input> only takes focus inside a document.
  document.body.append(root);
  return root;
}

describe('GameLoop', () => {
  // Options persist in localStorage now; keep one test's choices out of the next.
  afterEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
  });

  function setup(content = new ContentStore()) {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: () => {},
      clearRect: () => {},
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      rect: () => {},
      clip: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      fillText: () => {},
      drawImage: () => {},
      translate: () => {},
      rotate: () => {},
      scale: () => {},
      setLineDash: () => {},
      font: '',
      textAlign: '',
      textBaseline: '',
      strokeStyle: '',
      lineWidth: 1,
    } as unknown as RenderingContext);

    const canvasManager = createMockCanvasManager();
    const assets = new AssetLoader();
    const bus = new NetEventBus();
    const socket = new GameSocket({
      url: 'ws://127.0.0.1:7172',
      login: { nickname: 'Tester', password: '' },
      bus,
    });

    vi.spyOn(socket, 'move').mockImplementation(() => {});
    vi.spyOn(socket, 'rotation').mockImplementation(() => {});
    vi.spyOn(socket, 'mouseDirection').mockImplementation(() => {});
    vi.spyOn(socket, 'close').mockImplementation(() => {});
    vi.spyOn(socket, 'chat').mockImplementation(() => {});
    vi.spyOn(socket, 'chatChannel').mockReturnValue(true);

    const configFixture = JSON.parse(
      readFileSync('tests/fixtures/content/config.json', 'utf8'),
    ) as ContentTable;
    content.load(configFixture);

    const loop = new GameLoop({
      canvasManager,
      content,
      assets,
      socket,
      hudRoot: createHudRoot(),
      modalRoot: document.createElement('div'),
    });

    return { loop, canvasManager, content, assets, socket };
  }

  it('initializes subsystems and executes tick cleanly', () => {
    const { loop, socket } = setup();

    expect(loop.windows.isModalOpen()).toBe(false);
    expect(loop.chatActive).toBe(false);

    // Run tick without crashing
    expect(() => loop.tick(16)).not.toThrow();

    // Toggle chat
    loop.toggleChat();
    expect(loop.chatActive).toBe(true);
    expect(loop.keyboard.isTextInputMode()).toBe(true);

    loop.toggleChat();
    expect(loop.chatActive).toBe(false);
    expect(loop.keyboard.isTextInputMode()).toBe(false);

    loop.stop();
    expect(socket.close).toHaveBeenCalled();
  });

  it('sends typed text on the active channel and shows nothing until the server echoes it', () => {
    const { loop, socket } = setup();
    loop.world.ownGuid = 4;
    loop.world.players.set(4, newPlayerInfo(4, 'Me'));
    loop.socket.bus.emit('chatAccess', { mask: 0x17 });

    loop.submitChat('hi all');
    expect(socket.chatChannel).toHaveBeenCalledWith(ChatChannel.LOCAL, 0, 'hi all');
    expect(loop.chat.tab('local')!.lines).toHaveLength(0);

    // The echo is what draws the line and the bubble.
    loop.socket.bus.emit('chat', { channel: ChatChannel.LOCAL, pid: 4, peer: 0, flags: 0, text: 'hi all' });
    expect(loop.chat.tab('local')!.lines.map((l) => [l.pid, l.text, l.self])).toEqual([[4, 'hi all', true]]);
    loop.tick(16);
    expect(loop.chatBubbles.frames(4).map((f) => f.text)).toEqual(['hi all']);

    // A global line is logged but never spoken over a head.
    loop.socket.bus.emit('chat', { channel: ChatChannel.GLOBAL, pid: 4, peer: 0, flags: 0, text: 'to all' });
    loop.tick(16);
    expect(loop.chat.tab('global')!.lines).toHaveLength(1);
    expect(loop.chatBubbles.frames(4).map((f) => f.text)).toEqual(['hi all']);

    // Admin commands go out as typed on the active channel.
    loop.submitChat('!karma=4:5');
    expect(socket.chatChannel).toHaveBeenCalledWith(ChatChannel.LOCAL, 0, '!karma=4:5');
    vi.mocked(socket.chatChannel).mockReturnValue(false);
    expect(loop.submitChat('keep this if disconnected')).toBe(false);
    expect(loop.chat.tab('local')).toMatchObject({ draft: 'keep this if disconnected', pending: false });
    loop.stop();
  });

  it('routes a private message to the peer tab and opens one from !priv= or a double-click', () => {
    const { loop, socket } = setup();
    loop.world.ownGuid = 4;
    loop.world.players.set(4, newPlayerInfo(4, 'Me'));
    loop.world.players.set(7, newPlayerInfo(7, 'Bob'));
    loop.socket.bus.emit('chatAccess', { mask: 0x17 });

    loop.submitChat('!priv=Bob');
    expect(loop.chat.active.id).toBe('pm:7');
    expect(loop.chatActive).toBe(false); // the model opened it; focus is the HUD's job on a click

    loop.submitChat('psst');
    expect(socket.chatChannel).toHaveBeenCalledWith(ChatChannel.PRIVATE, 7, 'psst');
    loop.socket.bus.emit('chat', { channel: ChatChannel.PRIVATE, pid: 4, peer: 7, flags: 0, text: 'psst' });
    loop.socket.bus.emit('chat', { channel: ChatChannel.PRIVATE, pid: 7, peer: 7, flags: 0, text: 'yes?' });
    expect(loop.chat.tab('pm:7')!.lines.map((l) => l.text)).toEqual(['psst', 'yes?']);

    loop.chat.setActive('local');
    loop.openPrivateChat(7);
    expect(loop.chat.active.id).toBe('pm:7');
    expect(loop.chatActive).toBe(true);
    loop.stop();
  });

  it('Enter focuses the console input and a second Enter (empty) or Escape drops it', () => {
    const { loop } = setup();
    loop.submitOrOpenChat();
    expect(loop.chatActive).toBe(true);
    expect(loop.keyboard.isTextInputMode()).toBe(true);

    loop.submitOrOpenChat();
    expect(loop.chatActive).toBe(false);
    expect(loop.keyboard.isTextInputMode()).toBe(false);
    loop.stop();
  });

  it('ignores keys until it is started (the join is still running)', () => {
    const { loop } = setup();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }));
    expect(loop.windows.activeWindow).toBe('none');
    loop.start();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }));
    expect(loop.windows.activeWindow).toBe('map');
    loop.stop();
  });

  it('leaves no listener on the permanent leaderboard once stopped', () => {
    const { loop } = setup();
    const board = loop.hudRoot.querySelector<HTMLElement>('.hud-leaderboard')!;
    const open = vi.fn();
    loop.hud.leaderboard.onPlayerDoubleClick = open;
    loop.stop();
    board.innerHTML = '<div data-guid="3">x</div>';
    board.firstElementChild!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(open).not.toHaveBeenCalled();
  });

  it('lets go of all input when the window loses focus or the tab is hidden', () => {
    const { loop } = setup();
    loop.start();
    const release = vi.spyOn(loop.input, 'releaseAll');
    window.dispatchEvent(new Event('blur'));
    expect(release).toHaveBeenCalledTimes(1);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(release).toHaveBeenCalledTimes(2);
    hidden.mockRestore();
    loop.stop();
    window.dispatchEvent(new Event('blur'));
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('a real Enter keydown opens chat and stays open (both window listeners fire on one event)', () => {
    const { loop } = setup();
    loop.start();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true }),
    );
    expect(loop.chatActive).toBe(true);

    loop.stop();
  });

  it('zooms with the mouse wheel over the canvas, in steps, within the old limits', () => {
    const { loop, canvasManager } = setup();
    const wheel = (deltaY: number) =>
      canvasManager.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY, cancelable: true }));
    expect(loop.hudControlsState.zoomLevel).toBe(1);
    wheel(-100); // scroll up = zoom in
    expect(loop.hudControlsState.zoomLevel).toBeCloseTo(1.1, 6);
    wheel(100);
    wheel(100);
    expect(loop.hudControlsState.zoomLevel).toBeCloseTo(0.9, 6);
    for (let i = 0; i < 20; i++) wheel(100);
    expect(loop.hudControlsState.zoomLevel).toBeCloseTo(0.5, 6);
    for (let i = 0; i < 40; i++) wheel(-100);
    expect(loop.hudControlsState.zoomLevel).toBeCloseTo(2, 6);
    expect(loop.camera.zoom).toBeGreaterThan(0);
    loop.stop();
  });

  it('eases the camera toward a new zoom level over a few frames instead of snapping', () => {
    const { loop, canvasManager } = setup();
    loop.tick(16);
    const base = loop.camera.zoom;
    canvasManager.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
    expect(loop.hudControlsState.zoomLevel).toBeCloseTo(1.1, 6);
    // The target moved; the camera has not jumped there yet.
    expect(loop.camera.zoom).toBeLessThan(base * 1.1);
    loop.tick(16);
    const first = loop.camera.zoom;
    expect(first).toBeGreaterThan(base);
    expect(first).toBeLessThan(base * 1.1);
    for (let i = 0; i < 60; i++) loop.tick(16);
    expect(loop.camera.zoom).toBeCloseTo(base * 1.1, 6);
    loop.stop();
  });

  it('M opens the full map and closes it again; the profiler option mirrors F2', () => {
    const { loop } = setup();
    loop.start();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }));
    expect(loop.windows.activeWindow).toBe('map');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }));
    expect(loop.windows.activeWindow).toBe('none');

    expect(loop.hudControlsState.profilerVisible).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F2' }));
    expect(loop.hudControlsState.profilerVisible).toBe(true);
    expect(loop.profilerHud.isVisible).toBe(true);
    loop.stop();
  });

  it('the Stats option shows the fps / ping line and remembers the choice across sessions', () => {
    localStorage.removeItem('prevast.stats');
    const { loop } = setup();
    const stats = loop.hudRoot.querySelector<HTMLElement>('.hud-stats')!;
    expect(loop.hudControlsState.statsVisible).toBe(false);
    expect(stats.hidden).toBe(true);
    loop.handleHudAction('toggle_stats');
    expect(loop.hudControlsState.statsVisible).toBe(true);
    expect(localStorage.getItem('prevast.stats')).toBe('1');
    for (let t = 0; t <= 700; t += 16) loop.tick(16, t);
    expect(stats.hidden).toBe(false);
    expect(stats.textContent).toMatch(/^\d+ fps · – ms$/);
    loop.stop();

    const again = setup();
    expect(again.loop.hudControlsState.statsVisible).toBe(true);
    again.loop.stop();
    localStorage.removeItem('prevast.stats');
  });

  it('remembers sound, particles, keyboard, leaderboard and zoom across sessions (prevast.options)', () => {
    localStorage.removeItem('prevast.options');
    const { loop } = setup();
    loop.handleHudAction('toggle_audio');
    loop.handleHudAction('toggle_particles');
    loop.handleHudAction('toggle_keyboard');
    loop.handleHudAction('toggle_leaderboard');
    loop.handleHudAction('zoom_in');
    loop.handleHudAction('zoom_in');
    loop.handleHudAction({ type: 'volume_set', kind: 'master', value: 0.5 });
    expect(JSON.parse(localStorage.getItem('prevast.options')!)).toEqual({
      audioMuted: true,
      volumeMaster: 0.5,
      volumeSfx: 0.8,
      volumeMusic: 0.5,
      particlesDisabled: true,
      keyboardLayout: 'azerty',
      leaderboardVisible: false,
      zoomLevel: 1.2,
      noticeY: 80,
      privateMessages: 'everyone',
    });
    loop.stop();

    const again = setup();
    expect(again.loop.hudControlsState).toMatchObject({
      audioMuted: true,
      volumeMaster: 0.5,
      volumeSfx: 0.8,
      volumeMusic: 0.5,
      particlesDisabled: true,
      keyboardLayout: 'azerty',
      leaderboardVisible: false,
    });
    expect(again.loop.hudControlsState.zoomLevel).toBeCloseTo(1.2, 9);
    expect(again.loop.audio.isMuted()).toBe(true);
    expect(again.loop.audio.masterVolume).toBe(0.5);
    again.loop.stop();
    localStorage.removeItem('prevast.options');

    // Garbage in storage falls back to the defaults.
    localStorage.setItem('prevast.options', '{"zoomLevel":"big","keyboardLayout":"dvorak"');
    const fallback = setup();
    expect(fallback.loop.hudControlsState.zoomLevel).toBe(1);
    expect(fallback.loop.hudControlsState.keyboardLayout).toBe('qwerty');
    fallback.loop.stop();
    localStorage.removeItem('prevast.options');
  });

  it('Options > Interface size: fit x HUD x region lands on the roots as --hud-z-*, persists, resets', () => {
    localStorage.removeItem('prevast.ui-scale');
    const { loop, canvasManager } = setup();
    const z = (root: HTMLElement, region: string) =>
      root.style.getPropertyValue(`--hud-z-${region}`);
    // The mock canvas is 800x600: the fit is the 0.7 floor.
    expect(z(loop.hudRoot, 'hud')).toBe('0.7');
    expect(z(loop.hudRoot, 'inventory')).toBe('0.7');
    expect(z(loop.modalRoot, 'windows')).toBe('0.7');
    expect(z(loop.invitationRoot, 'hud')).toBe('0.7');
    const minimapCanvas = loop.hudRoot.querySelector<HTMLCanvasElement>('.hud-minimap')!;
    expect(minimapCanvas.width).toBe(Math.round(120 * 0.7));

    loop.handleHudAction({ type: 'ui_scale', region: 'inventory', direction: 1 });
    expect(loop.hudControlsState.uiScale.inventory).toBeCloseTo(1.1, 9);
    expect(z(loop.hudRoot, 'inventory')).toBe('0.77');
    expect(z(loop.hudRoot, 'vitals')).toBe('0.7');
    expect(JSON.parse(localStorage.getItem('prevast.ui-scale')!).inventory).toBeCloseTo(1.1, 9);

    // Everything multiplies the regions.
    loop.handleHudAction({ type: 'ui_scale', region: 'hud', direction: 1 });
    expect(z(loop.hudRoot, 'hud')).toBe('0.77');
    expect(z(loop.hudRoot, 'inventory')).toBe('0.847');

    // The minimap's backing store follows its region zoom (120 px canvas x 0.77).
    expect(minimapCanvas.width).toBe(Math.round(120 * 0.77));
    // The hotbar's drag ghost converts pointer px through the inventory zoom.
    const hotbarScale = vi.spyOn(loop.hud.hotbar, 'setScale');
    loop.handleHudAction({ type: 'ui_scale', region: 'inventory', direction: 1 });
    expect(hotbarScale).toHaveBeenLastCalledWith(0.924);
    loop.handleHudAction({ type: 'ui_scale', region: 'minimap', direction: 1 });
    expect(minimapCanvas.width).toBe(Math.round(120 * 0.847));

    // A bigger window: the fit follows (1920x1080 -> 1080/880).
    (
      canvasManager as unknown as { fireResize: (d: { width: number; height: number }) => void }
    ).fireResize({ width: 1920, height: 1080 });
    expect(Number(z(loop.hudRoot, 'hud'))).toBeCloseTo((1080 / 880) * 1.1, 3);
    loop.stop();

    const again = setup();
    expect(again.loop.hudControlsState.uiScale).toMatchObject({
      hud: 1.1,
      inventory: 1.2,
      minimap: 1.1,
    });
    again.loop.handleHudAction({ type: 'ui_scale_reset' });
    expect(again.loop.hudControlsState.uiScale).toEqual({
      hud: 1,
      inventory: 1,
      vitals: 1,
      minimap: 1,
      leaderboard: 1,
      windows: 1,
      chat: 1,
      notices: 1,
    });
    expect(z(again.loop.hudRoot, 'inventory')).toBe('0.7');
    again.loop.stop();
    localStorage.removeItem('prevast.ui-scale');
  });

  it('renders the combat feedback the server sends: damage numbers, explosion shake, poison', () => {
    const { loop, socket, canvasManager } = setup();
    const bus = socket.bus;
    loop.tick(16);
    const baseZoom = loop.camera.zoom;

    bus.emit('damageIndicator', { x: 500, y: 500, amount: -12, pct: 10 });
    expect(loop.damageNumbers.count).toBe(1);

    bus.emit('shakeExplosionState', { shake: 20 });
    expect(loop.camera.explosionFrames).toBe(20);

    bus.emit('drug', { kind: 'poisoned', a: 5, b: 0 });
    expect(loop.poison.isActive).toBe(true);
    for (let i = 0; i < 40; i++) loop.tick(16);
    // ~640 ms in: the throb is near its peak -- zoomed in, drawing at reduced resolution.
    expect(loop.camera.zoom).toBeGreaterThan(baseZoom * 1.5);
    expect(canvasManager.resolutionDivisor).toBeGreaterThan(4);

    // POISONED 0 stops it at the cycle boundary and everything returns to normal.
    bus.emit('drug', { kind: 'poisoned', a: 0, b: 0 });
    for (let i = 0; i < 120; i++) loop.tick(16);
    expect(loop.poison.isActive).toBe(false);
    expect(loop.camera.zoom).toBeCloseTo(baseZoom, 6);
    expect(canvasManager.resolutionDivisor).toBe(1);
    loop.stop();
  });

  it('offers Mods on a gun only when no trade, chest or station window is in the way', () => {
    const { loop } = setup(modsContent());
    loop.inventory.setSlot(0, { uid: 11, iid: MODS_IID.gun, count: 1 });
    const modsButton = () => {
      loop.openItemMenu(0, 10, 10);
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>('.dv-context-menu button'),
      ].find((b) => b.textContent?.startsWith('Mods'));
      return { label: button?.textContent, disabled: button?.disabled };
    };

    expect(modsButton()).toEqual({ label: 'Mods', disabled: false });

    loop.inventory.isChestOpen = true;
    expect(modsButton()).toEqual({ label: 'Mods — close the open window first', disabled: true });
    loop.inventory.isChestOpen = false;
    loop.inventory.isStationOpen = true;
    expect(modsButton()).toEqual({ label: 'Mods — close the open window first', disabled: true });
    loop.inventory.isStationOpen = false;

    loop.socket.bus.emit('tradeState', {
      id: 4,
      revision: 2,
      peer: 2,
      phase: 2,
      accepted: 0,
      rangeTiles: 2,
      own: [],
      theirs: [],
    });
    expect(modsButton()).toEqual({ label: 'Mods — finish the trade first', disabled: true });
    loop.stop();
  });

  it('previews and fits from the existing hotbar while the mod window is open', () => {
    const { loop, socket } = setup(modsContent());
    const fit = vi.spyOn(socket, 'weaponMod').mockImplementation(() => {});
    const select = vi.spyOn(loop.input, 'selectSlot');
    loop.inventory.setSlot(0, { uid: 11, iid: MODS_IID.gun, count: 1 });
    loop.inventory.setSlot(1, { uid: 12, iid: MODS_IID.scope, count: 1 });
    loop.windows.openMods(11);
    loop.tick(16);
    const carried = document.querySelector<HTMLElement>('.hud-slot[data-index="1"]')!;
    carried.dispatchEvent(new MouseEvent('pointerenter'));
    loop.tick(16);
    expect(loop.modalRoot.querySelector('.dv-mods-summary')?.textContent).toContain('Fit Tube scope');
    expect(fit).not.toHaveBeenCalled();
    carried.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
    carried.dispatchEvent(new MouseEvent('pointerup', { button: 0 }));
    carried.dispatchEvent(new MouseEvent('pointerleave'));
    loop.tick(16);
    loop.modalRoot.querySelector<HTMLButtonElement>('[data-mod-slot="optic"]')!.click();
    expect(fit).toHaveBeenCalledWith(11, 1, 12);
    expect(select).not.toHaveBeenCalled();
    expect(loop.inventory.modsOf(11)).toEqual([]);
    loop.stop();
  });

  it('right-click aims a gun that can aim; Ctrl+right-click opens the world menu; release and blur let go', () => {
    const { loop, canvasManager, socket } = setup(modsContent());
    const aim = vi.spyOn(socket, 'aim').mockImplementation(() => {});
    const menu = vi.spyOn(loop, 'openWorldMenu').mockImplementation(() => {});
    loop.start();
    loop.inventory.setSlot(0, { uid: 11, iid: MODS_IID.gun, count: 1 });
    loop.inventory.activeSlot = 0;
    loop.inventory.selectedIid = MODS_IID.gun;
    const down = (init: MouseEventInit = {}) =>
      canvasManager.canvas.dispatchEvent(new MouseEvent('mousedown', { button: 2, ...init }));
    const up = () => canvasManager.canvas.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));

    down();
    expect(aim).toHaveBeenLastCalledWith(true);
    expect(menu).not.toHaveBeenCalled();
    up();
    expect(aim).toHaveBeenLastCalledWith(false);
    expect(aim).toHaveBeenCalledTimes(2);

    down({ ctrlKey: true });
    expect(menu).toHaveBeenCalledTimes(1);
    expect(aim).toHaveBeenCalledTimes(2);
    up();

    down();
    window.dispatchEvent(new Event('blur'));
    expect(aim).toHaveBeenLastCalledWith(false);
    loop.stop();
  });

  it('right-click with nothing that aims does nothing; trade targeting still cancels first', () => {
    const { loop, canvasManager, socket } = setup(modsContent());
    const aim = vi.spyOn(socket, 'aim').mockImplementation(() => {});
    const menu = vi.spyOn(loop, 'openWorldMenu').mockImplementation(() => {});
    loop.start();
    loop.inventory.setSlot(0, { uid: 12, iid: MODS_IID.bandage, count: 1 });
    loop.inventory.selectedIid = MODS_IID.bandage;
    canvasManager.canvas.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
    expect(aim).not.toHaveBeenCalled();
    expect(menu).not.toHaveBeenCalled();
    canvasManager.canvas.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));

    loop.inventory.setSlot(1, { uid: 11, iid: MODS_IID.gun, count: 1 });
    loop.inventory.activeSlot = 1;
    loop.inventory.selectedIid = MODS_IID.gun;
    loop.tradeTargeting.begin(loop.inventory.getSlot(1)!);
    canvasManager.canvas.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
    expect(loop.tradeTargeting.active).toBe(false);
    expect(aim).not.toHaveBeenCalled();
    loop.stop();
  });

  it('aiming a weak scope zooms out by its factor, never past the furthest zoom', () => {
    const { loop, socket } = setup(modsContent());
    vi.spyOn(socket, 'aim').mockImplementation(() => {});
    loop.start();
    loop.inventory.setSlot(0, { uid: 11, iid: MODS_IID.gun, count: 1 });
    loop.inventory.activeSlot = 0;
    loop.inventory.selectedIid = MODS_IID.gun;
    loop.socket.bus.emit('itemMods', { uid: 11, mods: [{ slot: 1, iid: MODS_IID.scope }] });
    loop.tick(16);
    const base = loop.camera.zoom;

    loop.aim.press(false);
    loop.socket.bus.emit('aimState', { active: true, viewX: 1400, viewY: 900 });
    for (let i = 0; i < 20; i++) loop.tick(16);
    expect(loop.camera.zoom).toBeCloseTo(base * 0.85, 6); // the tube scope's zoom

    loop.hudControlsState.zoomLevel = 0.5;
    for (let i = 0; i < 200; i++) loop.tick(16);
    expect(loop.camera.zoom).toBeCloseTo(base * 0.5, 6); // 0.5 x 0.85 floors at 0.5

    loop.aim.release();
    loop.hudControlsState.zoomLevel = 1;
    for (let i = 0; i < 200; i++) loop.tick(16);
    expect(loop.camera.zoom).toBeCloseTo(base, 6);
    loop.stop();
  });

  it('aiming a strong scope sets its own zoom, whatever the player`s zoom', () => {
    const { loop, socket } = setup(modsContent());
    vi.spyOn(socket, 'aim').mockImplementation(() => {});
    loop.start();
    loop.inventory.setSlot(0, { uid: 12, iid: MODS_IID.sniper, count: 1 });
    loop.inventory.activeSlot = 0;
    loop.inventory.selectedIid = MODS_IID.sniper;
    loop.tick(16);
    const base = loop.camera.zoom; // zoom level 1

    loop.aim.press(false);
    loop.socket.bus.emit('aimState', { active: true, viewX: 1400, viewY: 900 });
    for (let i = 0; i < 20; i++) loop.tick(16);
    expect(loop.camera.zoom).toBeCloseTo(base * 0.55, 6); // the sniper's zoom

    loop.hudControlsState.zoomLevel = 2;
    for (let i = 0; i < 200; i++) loop.tick(16);
    expect(loop.camera.zoom).toBeCloseTo(base * 0.55, 6); // still its own

    loop.aim.release();
    for (let i = 0; i < 200; i++) loop.tick(16);
    expect(loop.camera.zoom).toBeCloseTo(base * 2, 6); // back to the player's
    loop.stop();
  });
});

// The server's weak-view reach rule mirrors how far out a player can zoom:
// aim_view::CLIENT_ZOOM_MIN in apps/server/src/gameplay/aim_view.h must equal
// this. Change both together.
describe('GameLoop zoom limit', () => {
  it('matches the constant the server reach rule mirrors', () => {
    expect(GameLoop.ZOOM_MIN).toBe(0.5);
  });
});
