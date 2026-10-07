// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { mountAccountRun } from '../ui/hud/hud-account-run';
import { AudioManager } from '../audio/audio-manager';
import { WorldSounds } from '../audio/world-sounds';
import { itemIconUrl, type AssetLoader } from '../assets/asset-loader';
import type { ContentStore } from '../content/store';
import { baseWorldScale, Camera, LOOK_MAX, scopeOffset } from '../core/camera';
import type { CanvasManager } from '../core/canvas';
import { KeyboardTracker } from '../core/keyboard';
import { frameLerp, lerp } from '../core/math2d';
import { MouseTracker } from '../core/mouse';
import { Profiler } from '../core/profiler';
import { readSetting, writeSetting } from '../core/storage';
import type { GameSocket } from '../net/socket';
import { CharacterAnimator } from '../render/character-animator';
import { ChatBubbles } from '../render/chat-bubbles';
import { ChatModel } from '../chat/chat-model';
import { chatNotification } from '../chat/chat-settings';
import { CHAT_SYSTEM_PID, ChatChannel, PrivateMessagePolicy, ServerLogKind, StatusKind } from '../net/opcodes';
import { DamageNumbers } from '../render/damage-numbers';
import { ExplosionAnimator } from '../render/explosions';
import { InteractPrompt } from '../render/interact-prompt';
import { PlayerAlerts } from '../render/player-alerts';
import { StatusVignette } from '../render/status-vignette';
import { PoisonEffect } from '../render/poison-effect';
import { BuildingAnimator } from '../render/building-animator';
import { ParticleSystem } from '../render/particles/particle-system';
import { GameRenderer } from '../render/renderer';
import { drawScopeMask, ShapeMask } from '../render/scope-view';
import { nightAt, SKY_FADE_MS } from '../render/sky';
import { HudManager } from '../ui/hud/hud-manager';
import { HudProfiler } from '../ui/hud/hud-profiler';
import { ContextMenu, itemLookText, type ContextMenuEntry } from '../ui/context-menu';
import { playerMenuEntries } from '../ui/player-menu';
import { HudStatusLine } from '../ui/hud/hud-status-line';
import { TradeCursor } from '../ui/trade-cursor';
import { badgesFor } from '../ui/badges';
import { WindowManager, type WindowType } from '../ui/windows/window-manager';
import { ClanStore } from '../world/clan-store';
import { craftRecipes } from '../world/craft-model';
import { InventoryStore, type InventoryItem } from '../world/inventory-store';
import { takesMods } from '../world/weapon-mods';
import { WorldState } from '../world/world-state';
import {
  aimedView,
  aimedZoom,
  aimOf,
  effectiveView,
  isStrong,
  scopeOutline,
  type ViewDef,
} from '../world/aim-view';
import { AimController } from './aim-controller';
import { InputManager } from './input-manager';
import { BRZone } from './modes/br-zone';
import { GhoulEffects } from './modes/ghoul-effects';
import { PlacementEngine } from './placement';
import { TradeTargeting, playerAt } from './trade-targeting';
import { worldTargetAt, worldTargetTitle } from './world-target';
import type { WorldEntity } from '../world/entity-types';
import type { HudAction, HudControlsState, UiScaleAction } from '../ui/hud/hud-controls';
import {
  DEFAULT_UI_SCALE,
  applyUiScale,
  effectiveUiScale,
  fitScale,
  parseUiScale,
  serializeUiScale,
  stepUiScale,
} from '../ui/ui-scale';
import { parseOptions, serializeOptions } from '../ui/options-settings';

/** localStorage key of the Options > Stats choice. */
const STATS_SETTING = 'prevast.stats';
/** localStorage key of the Options > Interface size choices (ui-scale.ts). */
const UI_SCALE_SETTING = 'prevast.ui-scale';
/** localStorage key of the other Options rows (options-settings.ts). */
const OPTIONS_SETTING = 'prevast.options';

/** How long before the day/night palette swap the other palette starts loading. */
const PALETTE_WARM_LEAD_MS = 20_000;

export interface GameLoopOptions {
  canvasManager: CanvasManager;
  content: ContentStore;
  assets: AssetLoader;
  socket: GameSocket;
  audio?: AudioManager;
  particles?: ParticleSystem;
  brZone?: BRZone;
  ghoulEffects?: GhoulEffects;
  /** DOM root for the HUD overlay (gauges, hotbar, alerts, etc). Defaults to a detached element for tests. */
  hudRoot?: HTMLElement;
  /** Name of the server joined: the leaderboard panel's title. */
  serverName?: string;
  /** DOM root for the shared modal window shell. Defaults to a detached element for tests. */
  modalRoot?: HTMLElement;
  /** Clan request card, above the windows. Defaults to a detached element for tests. */
  invitationRoot?: HTMLElement;
  /** Death window "Play again": reconnect with the same join request. */
  onPlayAgain?: () => void;
  /** Death window "Main menu": drop the session and show the start screen. */
  onMainMenu?: () => void;
  /** Open the profiler overlay as soon as the loop starts (`?profiler` in the URL). */
  profilerOnStart?: boolean;
}

export class GameLoop {
  readonly canvasManager: CanvasManager;
  readonly content: ContentStore;
  readonly assets: AssetLoader;
  readonly socket: GameSocket;

  readonly camera: Camera;
  readonly world: WorldState;
  readonly inventory: InventoryStore;
  readonly clans: ClanStore;
  readonly keyboard: KeyboardTracker;
  readonly mouse: MouseTracker;
  readonly renderer: GameRenderer;
  readonly animator: CharacterAnimator;
  readonly prompt = new InteractPrompt();
  readonly playerAlerts = new PlayerAlerts();
  readonly statusVignette = new StatusVignette();
  readonly chatBubbles = new ChatBubbles();
  readonly damageNumbers = new DamageNumbers();
  readonly poison = new PoisonEffect();
  readonly explosions = new ExplosionAnimator();
  readonly hud: HudManager;
  readonly profiler = new Profiler();
  readonly profilerHud = new HudProfiler();
  readonly windows: WindowManager;
  readonly placement: PlacementEngine;
  readonly input: InputManager;
  readonly audio: AudioManager;
  /** Weapon, eat and structure hit/break sounds, off the same pulses the animators read. */
  readonly worldSounds: WorldSounds;
  readonly particles: ParticleSystem;
  readonly buildingAnimator: BuildingAnimator;
  readonly brZone: BRZone;
  readonly ghoulEffects: GhoulEffects;
  readonly hudRoot: HTMLElement;
  readonly modalRoot: HTMLElement;
  readonly invitationRoot: HTMLElement;
  /** Right-click menu: inventory and container items, and (Ctrl+right-click) things in the world. */
  readonly contextMenu = new ContextMenu();
  /** "You see …" and other short lines over the hotbar. */
  readonly statusLine = new HudStatusLine();
  /** The last Look sent, so a double click does not ask the server twice. */
  private lastLook = { key: '', at: 0 };
  /** "Trade with…": the item on the cursor waiting for a player to be clicked. */
  readonly tradeTargeting = new TradeTargeting();
  /** The right button held to aim: AIM to the server, and how far into the aimed view the camera is. */
  readonly aim: AimController;
  private readonly tradeCursor = new TradeCursor();

  private running = false;
  private animFrameId = 0;
  private lastTimestamp = 0;

  /** The console's state; the HUD draws it, the socket feeds it. */
  readonly chat: ChatModel;

  readonly hudControlsState: HudControlsState = {
    ...parseOptions(readSetting(OPTIONS_SETTING)),
    profilerVisible: false,
    statsVisible: readSetting(STATS_SETTING) === '1',
    skillPoints: 0,
    uiScale: parseUiScale(readSetting(UI_SCALE_SETTING)),
  };

  /** The window fit the HUD zoom starts from (ui-scale.ts); the Options sizes multiply it. */
  private uiFit = 1;

  /** Mouse wheel / options zoom: one notch, clamped to the old client's range. */
  static readonly ZOOM_STEP = 0.1;
  static readonly ZOOM_MIN = 0.5;
  static readonly ZOOM_MAX = 2.0;
  /**
   * The zoom the camera is actually at: `zoomLevel` is the target and this
   * eases toward it (old client: the scale offset lerps toward Render.scale
   * every frame), so a wheel notch glides instead of snapping.
   */
  private zoomShown = 1.0;
  /** The held gun's scope view and AimController's blend, as last applied to the zoom (applyZoom). */
  private scopeView: ViewDef | null = null;
  private scopeBlend = 0;
  /** The strong scope's darkening, on a canvas of its own made on first use. */
  private readonly shapeMask = new ShapeMask();
  private static readonly ZOOM_EASE_PER_FRAME = 0.18;

  private readonly cleanups: (() => void)[] = [];
  private lastChatSound = -Infinity;

  constructor(options: GameLoopOptions) {
    this.canvasManager = options.canvasManager;
    this.content = options.content;
    this.assets = options.assets;
    this.socket = options.socket;

    this.camera = new Camera({
      viewportWidth: this.canvasManager.width,
      viewportHeight: this.canvasManager.height,
    });
    // The remembered zoom starts as the shown zoom: no glide on the first frame.
    this.zoomShown = this.hudControlsState.zoomLevel;
    this.applyZoom();

    this.world = new WorldState();
    this.inventory = new InventoryStore();
    this.clans = new ClanStore(this.world);

    this.keyboard = new KeyboardTracker({ target: window });
    this.mouse = new MouseTracker({ target: this.canvasManager.canvas });
    // The loop is built when the join starts and started on HANDSHAKE; until
    // then no key or click may reach the game.
    this.keyboard.setEnabled(false);
    this.mouse.setEnabled(false);

    this.renderer = new GameRenderer();
    this.animator = new CharacterAnimator();
    this.hud = new HudManager();
    this.chat = new ChatModel({
      nameOf: (pid) => this.world.players.get(pid)?.nickname,
      ownGuid: () => this.world.ownGuid,
      ownClan: () => this.world.players.get(this.world.ownGuid)?.team ?? -1,
      players: () => this.world.players.values(),
      badgesOf: (pid) => badgesFor(this.world.players.get(pid), this.world.groups),
      blocked: () => this.world.blocked,
    });
    this.hud.chat.attach(this.chat, {
      onSubmit: (text) => this.submitChat(text),
      onOpenPrivate: (pid) => this.openPrivateChat(pid),
      onPlayerMenu: (pid, x, y, text) => this.openPlayerMenu(pid, x, y, text),
      onFocusChange: (focused) => this.keyboard.setTextInputMode(focused),
      onNpcKeyword: (session, revision, text) => {
        if (this.windows.npc.state?.session === session)
          this.windows.npc.say(this.socket, text, revision);
      },
      onNpcClose: (session) => {
        if (this.windows.npc.state?.session === session) this.windows.npc.close(this.socket);
      },
    });
    this.hud.leaderboard.onPlayerDoubleClick = (guid) => this.openPrivateChat(guid);
    this.cleanups.push(() => this.hud.leaderboard.unmount());
    this.cleanups.push(() => this.hud.chat.destroy());

    this.audio = options.audio ?? new AudioManager();
    this.audio.setMuted(this.hudControlsState.audioMuted);
    this.audio.setMasterVolume(this.hudControlsState.volumeMaster);
    this.audio.setSfxVolume(this.hudControlsState.volumeSfx);
    this.audio.setMusicVolume(this.hudControlsState.volumeMusic);
    this.worldSounds = new WorldSounds(this.audio, this.animator);
    this.particles = options.particles ?? new ParticleSystem();
    this.buildingAnimator = new BuildingAnimator();
    this.brZone = options.brZone ?? new BRZone();
    this.ghoulEffects = options.ghoulEffects ?? new GhoulEffects();
    this.hudRoot = options.hudRoot ?? document.createElement('div');
    this.modalRoot = options.modalRoot ?? document.createElement('div');
    this.invitationRoot = options.invitationRoot ?? document.createElement('div');
    this.cleanups.push(mountAccountRun(this.hudRoot, this.socket.bus));

    this.windows = new WindowManager({
      inventory: this.inventory,
      world: this.world,
      clans: this.clans,
      content: this.content,
      assets: this.assets,
      socket: this.socket,
      onPlayAgain: () => options.onPlayAgain?.(),
      onMainMenu: () => options.onMainMenu?.(),
      controlsState: () => this.hudControlsState,
      onControlAction: (action) => this.handleHudAction(action),
      brZone: this.brZone,
      // Read lazily: the InputManager is built after the windows.
      stationsInReach: () => this.input?.stationsInReach ?? [],
      onChestMenu: (slot, x, y) => this.openChestMenu(slot, x, y),
    });
    this.windows.mount(this.modalRoot);
    this.cleanups.push(() => this.contextMenu.destroy());
    this.cleanups.push(() => this.statusLine.destroy());
    this.cleanups.push(() => this.tradeCursor.destroy());
    this.aim = new AimController(this.socket);
    this.cleanups.push(this.aim.attachBus(this.socket.bus));
    // Right-click on the world: put back an item waiting on the cursor for a
    // trade partner; Ctrl+right-click for the menu of whatever is under the
    // pointer; a plain right-click aims a gun that can aim (AimController).
    this.cleanups.push(
      this.mouse.onDown((button, pos, event) => {
        if (button !== 2) return;
        if (this.tradeTargeting.active) {
          this.tradeTargeting.cancel();
          return;
        }
        if (this.inventory.isDead || this.placement.isPlacing()) return;
        if (event.ctrlKey) {
          this.openWorldMenu(pos.x, pos.y, event.clientX, event.clientY);
          return;
        }
        const gun = this.heldGun();
        if (gun && aimOf(this.content, gun.iid, this.inventory.modsOf(gun.uid))) {
          this.aim.press(!this.prompt.busy);
        }
      }),
    );
    this.cleanups.push(
      this.mouse.onUp((button) => {
        if (button === 2) this.aim.release();
      }),
    );
    this.cleanups.push(
      this.keyboard.onAction((action) => {
        if (action !== 'cancel') return;
        this.contextMenu.close();
        this.tradeTargeting.cancel();
      }),
    );
    this.cleanups.push(this.windows.trade.attachBus(this.socket.bus));
    // After the trade store: an item picked with "Trade with…" is offered from
    // the store's own state once the session opens.
    this.cleanups.push(
      this.tradeTargeting.attachBus(
        this.socket.bus,
        this.windows.trade,
        this.inventory,
        this.socket,
      ),
    );
    this.cleanups.push(this.windows.npc.attachBus(this.socket.bus));
    this.cleanups.push(this.windows.quests.attachBus(this.socket.bus));
    this.cleanups.push(this.windows.progress.attachBus(this.socket.bus));
    this.cleanups.push(this.windows.modsWindow.attachBus(this.socket.bus));
    this.cleanups.push(
      this.socket.bus.on('achievementUnlocked', (a) => {
        const entry = this.content.has('achievements') ? this.content.byId('achievements', a.id) : undefined;
        this.hud.alerts.triggerAchievement(a.name, entry?.points ?? 0);
        this.audio.playUi('levelup');
      }),
    );
    this.hud.onQuestOpen = (key) => {
      this.windows.openQuest(key);
      this.audio.playUi('open');
    };
    this.cleanups.push(
      this.socket.bus.on('npcState', (state) => {
        if (this.windows.npc.state === state) this.chat.onNpc(state);
      }),
    );
    this.cleanups.push(
      this.socket.bus.on('npcClosed', (state) => this.chat.closeNpcs(state.session)),
    );
    this.cleanups.push(this.socket.bus.on('playerDie', () => this.chat.closeNpcs()));
    this.cleanups.push(this.socket.bus.on('handshake', () => this.chat.closeNpcs()));
    // The server starts every session at "everyone": restate our choice.
    this.cleanups.push(this.socket.bus.on('handshake', () => this.sendPrivateMessages()));
    this.profilerHud.mount(
      this.hudRoot.querySelector<HTMLElement>('.hud-profiler') ?? document.createElement('div'),
    );
    if (options.profilerOnStart) this.setProfilerVisible(true);

    // Hotbar interactions, as the old client's mouseUp sent them. The server
    // owns every item; only the slot ORDER (swap) is ours, and even a stack is
    // the server's decision.
    this.hud.mount(
      this.hudRoot,
      (action) => this.handleHudAction(action),
      {
        onSelect: (index) => {
          if (
            this.windows.activeWindow === 'mods' &&
            this.windows.modsWindow.inventoryClick(this.modsDeps(), index)
          ) return;
          this.input.selectSlot(index);
        },
        onStore: (index, containerSlot) => {
          const item = this.inventory.getSlot(index);
          if (item && item.iid > 0) {
            this.socket.storeItem(item.iid, item.uid, item.count, item.ammo, containerSlot);
            this.audio.playUi('drag');
          }
        },
        onSplit: (index) => {
          const item = this.inventory.getSlot(index);
          if (item && item.iid > 0) {
            this.socket.splitItem(item.iid, item.count, item.uid);
            this.audio.playUi('drag', 0.6);
          }
        },
        onThrow: (index) => this.throwSlot(index),
        onDropOnMods: (index, slot) => {
          if (this.windows.activeWindow === 'mods')
            this.windows.modsWindow.fitFromInventory(this.modsDeps(), index, slot);
        },
        onMenu: (index, x, y) => this.openItemMenu(index, x, y),
        onStack: (from, to) => {
          const a = this.inventory.getSlot(from);
          const b = this.inventory.getSlot(to);
          if (a && b && a.iid > 0) {
            this.socket.stackItem(a.iid, a.count, a.uid, b.count, b.uid);
            this.audio.playUi('drag');
          }
        },
        onSwap: (from, to) => {
          this.inventory.swapSlots(from, to);
          if (this.inventory.activeSlot === from) this.inventory.activeSlot = to;
          else if (this.inventory.activeSlot === to) this.inventory.activeSlot = from;
          this.audio.playUi('drag');
        },
        onBag: (open) => this.audio.playUi(open ? 'zipper_on' : 'zipper_off', 0.08),
      },
      {
        onAccept: (guid) => this.socket.acceptJoinTeam(guid),
        onAcceptInvite: (clanId) => this.socket.acceptTeamInvite(clanId),
      },
      this.invitationRoot,
    );
    this.statusLine.mount(this.hudRoot.querySelector<HTMLElement>('.hud-hotbar') ?? this.hudRoot);
    if (options.serverName) this.hud.leaderboard.setTitle(options.serverName);
    // After the HUD is mounted: the minimap's backing store follows the scale.
    this.uiFit = fitScale(this.canvasManager.width, this.canvasManager.height);
    this.applyUiScale();

    this.placement = new PlacementEngine({
      world: this.world,
      inventory: this.inventory,
      content: this.content,
      socket: this.socket,
      mouse: this.mouse,
      camera: this.camera,
    });

    this.input = new InputManager({
      keyboard: this.keyboard,
      mouse: this.mouse,
      camera: this.camera,
      world: this.world,
      inventory: this.inventory,
      socket: this.socket,
      content: this.content,
      delegates: {
        onSelectSlot: (index) => {
          if (this.windows.trade.state?.phase !== 2) return false;
          const item = this.inventory.getSlot(index);
          if (item && item.iid > 0) this.windows.trade.offer(this.socket, item);
          return true;
        },
        isModalOpen: () => this.windows.isModalOpen(),
        onPickTarget: () => {
          if (!this.tradeTargeting.active) return false;
          const pid = playerAt(this.world, this.camera, this.mouse.screenX, this.mouse.screenY);
          this.tradeTargeting.pick(pid, this.socket, performance.now());
          return true;
        },
        onOutsideClick: () => this.windows.closeFromOutside(),
        isPlacing: () => this.placement.isPlacing(),
        onRotatePlacement: () => {
          this.placement.rotate();
          this.audio.playUi('drag');
        },
        onPlaceObject: () => {
          this.placement.place();
          this.audio.playUi('wood_impact');
        },
        onToggleWindow: (name: string) => {
          this.windows.toggle(name as WindowType);
          this.audio.playUi('open');
        },
        onToggleBag: () => this.hud.hotbar.toggleBag(),
        onToggleChat: () => this.submitOrOpenChat(),
        onCloseModal: () => {
          this.audio.playUi('button');
          if (this.hud.chat.isFocused()) {
            this.hud.chat.blur();
          } else {
            this.windows.close();
          }
        },
        onInteract: () => {
          this.audio.playUi('throw_loot');
        },
      },
    });

    // A hidden tab gets no frames, so update() cannot tell the server that
    // keys and the button were let go; do it the moment the page is left.
    const releaseInput = () => {
      this.input.releaseAll();
      this.aim.release();
    };
    const onVisibility = () => {
      if (document.hidden) releaseInput();
    };
    window.addEventListener('blur', releaseInput);
    document.addEventListener('visibilitychange', onVisibility);
    this.cleanups.push(() => {
      window.removeEventListener('blur', releaseInput);
      document.removeEventListener('visibilitychange', onVisibility);
    });

    this.cleanups.push(
      this.keyboard.onAction((action) => {
        if (action === 'toggle_profiler') this.setProfilerVisible(!this.profilerHud.isVisible);
      }),
    );

    // Zoom on the wheel (the old client's Render.scale += wheelDelta): a notch
    // per event, scroll up to zoom in. Only over the game canvas -- a window
    // above it keeps its own scrolling.
    const onWheel = (ev: WheelEvent) => {
      if (ev.deltaY === 0) return;
      ev.preventDefault();
      this.stepZoom(ev.deltaY < 0 ? 1 : -1);
    };
    this.canvasManager.canvas.addEventListener('wheel', onWheel, { passive: false });
    this.cleanups.push(() => this.canvasManager.canvas.removeEventListener('wheel', onWheel));

    // Wire resize
    this.cleanups.push(
      this.canvasManager.onResize((dims) => {
        this.camera.setViewport(dims.width, dims.height);
        this.applyZoom();
        const fit = fitScale(dims.width, dims.height);
        if (fit !== this.uiFit) {
          this.uiFit = fit;
          this.applyUiScale();
        }
      }),
    );

    // Wire socket bus
    this.cleanups.push(this.world.attachBus(this.socket.bus));
    this.cleanups.push(this.inventory.attachBus(this.socket.bus));
    // After the world: the clan store reads the roster WorldState just decoded.
    this.cleanups.push(this.clans.attachBus(this.socket.bus));

    // Audio & tactical event triggers
    this.cleanups.push(
      this.socket.bus.on('playerDie', () => {
        this.audio.playDeath();
      }),
    );
    this.cleanups.push(
      this.socket.bus.on('startCraft', () => {
        this.audio.playCraft();
      }),
    );
    this.cleanups.push(
      this.socket.bus.on('boughtSkill', () => {
        this.audio.playUi('skill');
      }),
    );
    this.cleanups.push(
      this.socket.bus.on('playerXpSkill', () => {
        this.audio.playLevelUp();
      }),
    );
    // Interaction feedback drawn on the canvas (old client _Interaction).
    this.cleanups.push(
      this.socket.bus.on('wrongTool', (ev) => {
        const item = this.content.has('items') ? this.content.byId('items', ev.toolIid) : undefined;
        const loot = (item?.client as { loot?: { sprite?: string }[] } | undefined)?.loot?.[0];
        this.prompt.wrongTool(loot?.sprite);
      }),
    );
    // Gauge threshold bubbles above players' heads (old client _playerNotification).
    this.cleanups.push(
      this.socket.bus.on('notification', (ev) => this.playerAlerts.push(ev.pid, ev.type, ev.level)),
    );
    this.cleanups.push(
      this.socket.bus.on('otherDie', (ev) => {
        this.playerAlerts.clear(ev.pid);
        this.chatBubbles.clear(ev.pid);
      }),
    );
    // Every line goes to the console; a LOCAL one is also the old client's
    // speech label over the speaker (_playerChatMessage). Our own words come
    // back as the server's echo, so the bubble waits for the round trip.
    this.cleanups.push(
      this.socket.bus.on('chat', (ev) => {
        this.hud.chat.syncReading();
        const arrival = this.chat.onChat(ev);
        if (this.hud.chat.settings.bubbles && ev.channel === ChatChannel.LOCAL && ev.pid !== CHAT_SYSTEM_PID) {
          this.chatBubbles.push(ev.pid, ev.text);
        }
        const notice = arrival && chatNotification(this.hud.chat.settings, arrival);
        if (arrival && notice?.show) {
          this.hud.chat.notice(arrival.line, arrival.tab);
          if (notice.sound && performance.now() - this.lastChatSound >= 2000) {
            this.lastChatSound = performance.now();
            this.audio.playUi('skill', 0.6);
          }
        }
      }),
    );
    this.cleanups.push(this.socket.bus.on('serverLog', (ev) => this.chat.onServerLog(ev)));
    this.cleanups.push(
      this.socket.bus.on('statusMessage', (ev) =>
        this.showStatus(ev.text, ev.kind === StatusKind.FAILURE),
      ),
    );
    this.cleanups.push(this.socket.bus.on('chatAccess', (ev) => this.chat.setAccess(ev)));
    this.cleanups.push(
      this.socket.bus.on('startInteraction', (ev) => this.prompt.startTimer(ev.delayMultiplier)),
    );
    this.cleanups.push(this.socket.bus.on('interruptInteraction', () => this.prompt.interrupt()));
    // Character feedback, as the old client keyed it: PLAYER_HIT -> red pulse
    // lurching away from the blow (+ a screen shake when it's us), PLAYER_HEALED
    // -> green pulse (never on ghouls), PLAYER_ATE -> hand-to-mouth pulse.
    this.cleanups.push(
      this.socket.bus.on('playerHit', (ev) => {
        const entity = this.world.entities.get(ev.pid, 0);
        if (entity) this.animator.hurt(entity, (ev.angle * Math.PI * 2) / 255);
        if (ev.pid === this.world.ownGuid) {
          this.camera.hitShake();
          this.statusVignette.hit();
        }
      }),
    );
    this.cleanups.push(
      this.socket.bus.on('playerHeal', (ev) => {
        const entity = this.world.entities.get(ev.pid, 0);
        const info = this.world.players.get(ev.pid);
        if (entity && (info?.ghoul ?? 0) === 0) this.animator.heal(entity);
      }),
    );
    this.cleanups.push(
      this.socket.bus.on('playerEat', (ev) => {
        const entity = this.world.entities.get(ev.pid, 0);
        if (entity) this.animator.eat(entity);
      }),
    );
    // Floating damage / heal numbers (DAMAGE_INDICATOR, world position).
    this.cleanups.push(
      this.socket.bus.on('damageIndicator', (ev) =>
        this.damageNumbers.push(ev.x, ev.y, ev.amount, ev.pct),
      ),
    );
    // Explosions jolt the camera (old Render.explosionShake).
    this.cleanups.push(
      this.socket.bus.on('shakeExplosionState', (ev) => this.camera.explosionShake(ev.shake)),
    );
    // POISONED [seconds]: the throbbing, pixelated screen; 0 stops it. The other
    // drug kinds are player state (WorldState) that the character renderer draws.
    this.cleanups.push(
      this.socket.bus.on('drug', (ev) => {
        if (ev.kind === 'poisoned') this.poison.start(ev.a * 1000);
      }),
    );
    this.cleanups.push(
      this.socket.bus.on('selectedItem', () => {
        this.audio.playEquip();
      }),
    );
    this.cleanups.push(
      this.socket.bus.on('fullChest', () => {
        this.audio.playUi('open');
      }),
    );
    this.cleanups.push(
      this.socket.bus.on('openBuilding', () => {
        this.audio.playUi('open');
      }),
    );

    // HUD/window hit-testing is native DOM now (real elements, real click
    // listeners); we just add the tactile click sound generically here.
    const playClickSound = (ev: Event) => {
      if (
        (ev.target as HTMLElement).closest(
          'button, .hud-slot, .dv-recipe, .dv-item-slot, .dv-team-row, .dv-tab',
        )
      ) {
        this.audio.playUi('button');
      }
    };
    this.hudRoot.addEventListener('click', playClickSound);
    this.modalRoot.addEventListener('click', playClickSound);
    this.cleanups.push(() => {
      this.hudRoot.removeEventListener('click', playClickSound);
      this.modalRoot.removeEventListener('click', playClickSound);
    });
  }

  /** Enter / the Chat button: focus the console input, or drop focus if it has it. */
  toggleChat(): void {
    if (this.hud.chat.isFocused()) this.hud.chat.blur();
    else this.hud.chat.focus();
  }

  /** Enter in the console with text: the model says what it means, the socket carries it. */
  private throwSlot(index: number): void {
    const item = this.inventory.getSlot(index);
    if (item && item.iid > 0) {
      this.socket.throwItem(item.iid, item.uid, item.count, item.ammo);
      this.audio.playUi('throw_loot');
    }
  }

  /** Right-click on a hotbar item: look at it, trade it to someone, or drop it. */
  openItemMenu(index: number, x: number, y: number): void {
    const item = this.inventory.getSlot(index);
    if (!item || item.iid <= 0 || this.inventory.isDead) return;
    const trade = this.windows.trade.state;
    const ghoul = !!this.world.players.get(this.world.ownGuid)?.ghoul;
    // With a trade already open the item simply joins it, as a click on the slot does.
    const tradeEntry =
      trade?.phase === 2
        ? { label: 'Add to trade', action: () => this.windows.trade.offer(this.socket, item) }
        : {
            label: trade
              ? 'Trade with… — already trading'
              : ghoul
                ? 'Trade with… — unavailable'
                : 'Trade with…',
            action: () => this.tradeTargeting.begin(item),
            disabled: !!trade || ghoul,
          };
    const entries: ContextMenuEntry[] = [
      {
        label: 'Look',
        action: () =>
          this.showStatus(itemLookText(item, this.content, this.inventory.modsOf(item.uid))),
      },
    ];
    if (takesMods(this.content, item.iid)) {
      // The Mods window cannot open over a trade, and a chest or station window takes the
      // screen back, so the entry says why it is off instead of silently doing nothing.
      const container = this.inventory.isChestOpen || this.inventory.isStationOpen;
      entries.push({
        label: trade
          ? 'Mods — finish the trade first'
          : container
            ? 'Mods — close the open window first'
            : 'Mods',
        action: () => this.windows.openMods(item.uid),
        disabled: !!trade || container,
      });
    }
    entries.push(tradeEntry, { label: 'Drop', action: () => this.throwSlot(index) });
    this.contextMenu.open(this.itemName(item.iid), entries, x, y);
  }

  private modsDeps() {
    return {
      inventory: this.inventory,
      content: this.content,
      socket: this.socket,
      onStatus: (text: string) => this.showStatus(text, true),
    };
  }

  /** Right-click on a container slot: look at the item or take it. */
  openChestMenu(slot: number, x: number, y: number): void {
    const item = this.inventory.chestItems[slot];
    if (!item || item.iid <= 0) return;
    this.contextMenu.open(
      this.itemName(item.iid),
      [
        {
          label: 'Look',
          action: () =>
            this.showStatus(itemLookText({ uid: 0, ...item }, this.content, item.mods)),
        },
        { label: 'Take', action: () => this.socket.takeItem(slot) },
      ],
      x,
      y,
    );
  }

  /** The gun in hand: the equipped item (SELECTED_ITEM), preferring the active hotbar slot when two match. */
  heldGun(): InventoryItem | null {
    const iid = this.inventory.selectedIid;
    if (!iid) return null;
    const active = this.inventory.getActiveItem();
    if (active?.iid === iid) return active;
    return this.inventory.slots.find((s) => s.iid === iid) ?? null;
  }

  /** The view the held gun shows when aimed, or null. */
  private heldView(): ViewDef | null {
    const gun = this.heldGun();
    return gun ? effectiveView(this.content, gun.iid, this.inventory.modsOf(gun.uid)) : null;
  }

  /** Ctrl+right-click on the world: Look at what is under the pointer, plus what E would do with it. */
  openWorldMenu(screenX: number, screenY: number, clientX: number, clientY: number): void {
    const target = worldTargetAt(this.world, this.camera, screenX, screenY, {
      isUsable: (e) => this.input.useAction(e) !== null,
      halfSize: (e) => this.input.objectHalfSize(e),
    });
    if (!target) {
      this.contextMenu.close();
      return;
    }
    const e = target.entity;
    const entries: ContextMenuEntry[] = [{ label: 'Look', action: () => this.lookAt(e) }];
    // Reach is re-read every frame while the menu is open (ContextMenu.update),
    // so walking up to the thing enables its action without reopening the menu.
    if (target.kind === 'object') {
      const first = this.input.useAction(e);
      if (first) {
        const state = () => {
          const use = this.input.useAction(e) ?? { label: first.label, inReach: false };
          return {
            label: use.inReach ? use.label : `${use.label} — move closer`,
            disabled: !use.inReach,
          };
        };
        entries.push({ ...state(), refresh: state, action: () => this.input.use(e) });
      }
    } else if (target.kind === 'npc') {
      const state = () => {
        const near = !e.removed && this.input.npcInReach(e);
        return { label: near ? 'Talk' : 'Talk — move closer', disabled: !near };
      };
      entries.push({
        ...state(),
        refresh: state,
        action: () => this.windows.npc.open(this.socket, e.id),
      });
    } else if (target.kind === 'player') {
      entries.push(...this.playerEntries(e.pid));
    }
    this.contextMenu.open(
      worldTargetTitle(target, this.world, this.content),
      entries,
      clientX,
      clientY,
    );
  }

  /** Right-click on a name in chat: the player's menu, wherever on the map they are. */
  openPlayerMenu(pid: number, clientX: number, clientY: number, text?: string): void {
    const entries = this.playerEntries(pid);
    if (text !== undefined) entries.push({ label: 'Copy text', action: () => {
      const copy = navigator.clipboard?.writeText(text);
      if (copy) void copy.catch(() => this.showStatus('Copy unavailable. Select the message text and press Ctrl+C.'));
      else this.showStatus('Select the message text and press Ctrl+C to copy.');
    } });
    if (entries.length === 0) return;
    const name = this.world.players.get(pid)?.nickname || 'Player';
    this.contextMenu.open(name, entries, clientX, clientY);
  }

  /** Private message, the clan step that fits, Block / Unblock (player-menu.ts). */
  private playerEntries(pid: number): ContextMenuEntry[] {
    const config = this.content.has('config') ? this.content.config : undefined;
    return playerMenuEntries(
      pid,
      this.world,
      this.clans,
      {
        message: (guid) => this.openPrivateChat(guid),
        invite: (guid) => this.socket.inviteTeam(guid),
        askToJoin: (clanId) => {
          this.socket.requestJoinTeam(clanId);
          this.showStatus(`Asked to join ${this.clans.clan(clanId)?.name ?? 'the clan'}.`);
        },
        // The server confirms (or refuses) on the status line.
        block: (guid, blocked) => this.socket.blockPlayer(guid, blocked),
      },
      { now: Date.now(), clanDelayMs: config?.clanActionDelayMs ?? 2000 },
    );
  }

  /** Ask the server what this is; the answer arrives as a status line. */
  lookAt(e: WorldEntity): void {
    const key = `${e.pid}:${e.id}`;
    const now = performance.now();
    if (key === this.lastLook.key && now - this.lastLook.at < 500) return;
    this.lastLook = { key, at: now };
    this.socket.lookAt(e.id, e.pid);
  }

  /** A line over the hotbar, kept in the Server tab too so it can be read back. */
  showStatus(text: string, failure = false): void {
    this.statusLine.show(text, failure);
    this.chat.onServerLog({ kind: ServerLogKind.SYSTEM, a: 0, b: 0, text });
  }

  private itemName(iid: number): string {
    return (
      (this.content.has('items') ? this.content.byId('items', iid)?.name : undefined) ?? 'Item'
    );
  }

  /** The picked item follows the pointer, naming the player it would go to. */
  private updateTradeCursor(): void {
    const picked = this.tradeTargeting.item;
    const live = picked && this.findInventoryItem(picked.uid, picked.iid);
    if (!picked || !live || this.inventory.isDead) {
      // Traded, dropped or eaten while it was on the cursor: nothing left to offer.
      if (picked) this.tradeTargeting.cancel();
      this.canvasManager.canvas.style.cursor = '';
      this.tradeCursor.hide();
      return;
    }
    const data = this.content.has('items') ? this.content.byId('items', live.iid) : undefined;
    const icon = data?.client?.icon ? itemIconUrl(data.client.icon) : '';
    const pid = this.mouse.hasPosition
      ? playerAt(this.world, this.camera, this.mouse.screenX, this.mouse.screenY)
      : null;
    const peer = pid === null ? undefined : this.world.players.get(pid)?.nickname;
    this.canvasManager.canvas.style.cursor = 'crosshair';
    this.tradeCursor.show(
      this.mouse.clientX,
      this.mouse.clientY,
      icon,
      peer !== undefined ? `Trade with ${peer}` : 'Click a player to trade · Esc to cancel',
    );
  }

  private findInventoryItem(uid: number, iid: number): InventoryItem | undefined {
    return this.inventory.slots.find(
      (slot) => slot.uid === uid && slot.iid === iid && slot.count > 0,
    );
  }

  submitChat(text: string): boolean {
    const source = this.chat.active.id;
    this.chat.setDraft(source, text);
    const action = this.chat.submit(text);
    switch (action.type) {
      case 'npc': {
        if (this.windows.npc.state?.session !== action.session || !this.chat.beginSend(action, source, text)) return false;
        if (this.windows.npc.say(this.socket, action.text, action.revision)) return true;
        this.chat.cancelSend(source); this.chat.noteInActive('The NPC is busy. Your draft was kept.'); return false;
      }
      case 'send': {
        const command = action.text.startsWith('!');
        if (!command && !this.chat.beginSend(action, source, text)) {
          this.chat.noteInActive('A message is still awaiting confirmation. Your draft was kept.'); return false;
        }
        if (this.socket.chatChannel(action.channel, action.target, action.text) === false) {
          this.chat.cancelSend(source); this.chat.noteInActive('Not connected. Your draft was kept.'); return false;
        }
        if (command) this.chat.setDraft(source, '');
        return true;
      }
      case 'open_private':
        this.chat.openPrivate(action.pid);
        this.chat.setDraft(source, ''); return true;
      case 'block':
        // The server confirms (or refuses) on the status line.
        this.socket.blockPlayer(action.pid, action.blocked);
        this.chat.setDraft(source, ''); return true;
      case 'note':
        this.chat.noteInActive(action.text); this.chat.setDraft(source, ''); return true;
      case 'error':
        this.chat.noteInActive(action.text);
        return false;
      default:
        return false;
    }
  }

  openPrivateChat(pid: number): void {
    if (this.chat.openPrivate(pid)) this.hud.chat.focus();
  }

  /** Kept for the input manager and tests: is the console input taking keys? */
  get chatActive(): boolean {
    return this.hud.chat.isFocused();
  }

  submitOrOpenChat(): void {
    this.toggleChat();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.keyboard.setEnabled(true);
    this.mouse.setEnabled(true);
    this.lastTimestamp = performance.now();
    this.audio.startAmbiance();
    this.hudRoot.hidden = false;

    const loop = (now: number) => {
      if (!this.running) return;
      this.animFrameId = requestAnimationFrame(loop);

      const delta = Math.min(100, Math.max(1, now - this.lastTimestamp));
      this.lastTimestamp = now;

      this.tick(delta, now);
    };

    this.animFrameId = requestAnimationFrame(loop);
  }

  private paletteWarmedFor = -1;

  /**
   * Shortly before dusk / dawn, queue the other palette's variant of every
   * sprite in use so the switch does not pop sprites in one by one.
   */
  private warmPaletteBeforeSwitch(): void {
    const clock = this.world.clock;
    const half = Math.floor(clock.cycleMs / 2);
    const toSwitch = clock.isNight ? clock.cycleMs - clock.phaseMs : half - clock.phaseMs;
    // Dusk starts fading the night palette in SKY_FADE_MS before the boundary.
    if (toSwitch > PALETTE_WARM_LEAD_MS + SKY_FADE_MS) return;
    // Once per upcoming switch: key by which palette we are warming.
    const key = clock.isNight ? 0 : 1;
    if (this.paletteWarmedFor === key) return;
    this.paletteWarmedFor = key;
    this.assets.warmVariants(!clock.isNight);
  }

  /**
   * Camera scale = the old client's fixed view area for this window x the
   * player's zoom level as an aimed scope changes it (aimedZoom: a weak one
   * multiplies it, never past ZOOM_MIN; a strong one replaces it) x the
   * poison throb.
   */
  private applyZoom(): void {
    this.camera.setZoom(
      baseWorldScale(this.camera.viewportWidth, this.camera.viewportHeight) *
        aimedZoom(this.zoomShown, this.scopeView, this.scopeBlend, GameLoop.ZOOM_MIN) *
        this.poison.zoomMultiplier,
    );
  }

  /** Per frame: glide the shown zoom toward the chosen level, settling exactly on it. */
  private easeZoom(delta: number): void {
    const target = this.hudControlsState.zoomLevel;
    if (this.zoomShown === target) return;
    const next = lerp(this.zoomShown, target, frameLerp(GameLoop.ZOOM_EASE_PER_FRAME, delta));
    this.zoomShown = Math.abs(next - target) < 0.0005 ? target : next;
    this.applyZoom();
  }

  private skillCosts?: { version: number | undefined; costOf: (iid: number) => number };

  /** Skill cost per item from the content tables, rebuilt when the items table changes. */
  private skillCostOf(): (iid: number) => number {
    const version = this.content.version('items');
    if (!this.skillCosts || this.skillCosts.version !== version) {
      const costs = new Map<number, number>();
      if (this.content.has('items')) {
        for (const r of craftRecipes(this.content)) costs.set(r.iid, r.skillCost);
      }
      this.skillCosts = { version, costOf: (iid) => costs.get(iid) ?? 1 };
    }
    return this.skillCosts.costOf;
  }

  /** Zooms `direction` notches (+ in, - out), snapped to the step so notches land on round values. */
  private stepZoom(direction: number): void {
    const steps = Math.round(this.hudControlsState.zoomLevel / GameLoop.ZOOM_STEP) + direction;
    // Rounded so 12 x 0.1 lands as 1.2, not 1.2000000000000002, in the store.
    this.hudControlsState.zoomLevel = Math.min(
      GameLoop.ZOOM_MAX,
      Math.max(GameLoop.ZOOM_MIN, Math.round(steps * GameLoop.ZOOM_STEP * 100) / 100),
    );
    this.saveOptions();
    this.applyZoom();
  }

  /**
   * Shows or hides the profiler overlay. Measuring only happens while it is
   * visible (or after `profiler.enable()` from the console), so an idle
   * profiler costs one boolean test per section.
   */
  setProfilerVisible(visible: boolean): void {
    this.hudControlsState.profilerVisible = visible;
    this.profilerHud.setVisible(visible);
    if (visible) {
      this.profiler.enable();
      this.profiler.observeBrowser();
    } else {
      this.profiler.disable();
    }
  }

  /** Saves the profiler's full report as a JSON file (console helper). */
  profilerDownload(): void {
    const blob = new Blob([JSON.stringify(this.profiler.report(), null, 1)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `prevast-profile-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  tick(delta: number, now: number = performance.now()): void {
    const width = this.canvasManager.width;
    const height = this.canvasManager.height;
    const ctx = this.canvasManager.ctx;
    const prof = this.profiler;
    prof.frameBegin(now);

    // 1. Input update
    prof.begin('input');
    this.input.update(delta);
    prof.end('input');
    this.easeZoom(delta);

    // 2. World & entity interpolation update + particle & mode updates
    prof.begin('world');
    this.world.update(delta);
    prof.end('world');
    this.assets.tick(now);
    this.warmPaletteBeforeSwitch();
    prof.begin('anim');
    this.particles.update(delta);
    this.brZone.update(delta);
    this.ghoulEffects.update(delta);
    // Sounds first: the animators clear the one-tick pulses they play on.
    const listener = this.world.getLocalEntity();
    this.worldSounds.update(
      this.world,
      this.content,
      listener?.x ?? this.camera.centerX,
      listener?.y ?? this.camera.centerY,
      now,
    );
    this.animator.update(this.world, this.content, delta);
    this.buildingAnimator.update(this.world, delta);
    // Blasts: first frame shakes the screen and plays the bang by distance,
    // as the old _Explosions did (EXPLOSION_SHAKE restarts the same jolt).
    this.explosions.update(this.world.entities, delta, (blast) => {
      this.camera.explosionShake(20);
      const local = this.world.getLocalEntity();
      if (local) {
        this.audio.playPositional('explosion', blast.x, blast.y, local.x, local.y, 2400, 0.7);
      }
    });
    this.prompt.update(delta);
    this.tradeTargeting.update(now);
    this.contextMenu.update();
    this.updateTradeCursor();
    // The rotate hint waits its turn: an E/F badge in reach takes the spot over the head.
    this.placement.update(delta, this.input.currentTarget !== null);
    this.playerAlerts.update(delta);
    this.chatBubbles.update(delta);
    this.damageNumbers.update(delta);
    if (this.poison.isActive) {
      this.poison.update(delta);
      this.applyZoom();
      this.canvasManager.setResolutionDivisor(this.poison.resolutionDivisor);
    }
    prof.end('anim');

    // Geiger counter scales with radiation absorbed; the gauge itself is cleanliness.
    this.audio.updateRadiation(255 - this.world.gauges.gauge('radiation').current);
    const gauges = this.world.gauges;
    this.statusVignette.update(
      delta,
      this.world.getLocalEntity()
        ? {
            life: gauges.fraction('life'),
            warmth: gauges.fraction('warmth'),
            irradiation: 1 - gauges.fraction('radiation'),
          }
        : null,
    );

    // Sync ghoul status if local player is infected / ghoul
    const playerInfo = this.world.players.get(this.world.ownGuid);
    if (playerInfo) {
      this.ghoulEffects.setGhoul(playerInfo.ghoul !== 0);
    }

    // 2b. Aiming: the held gun's scope view eases the zoom in, and the
    //     look-ahead (weak) or the scope offset (strong).
    this.aim.update(delta);
    const scopeView = this.heldView();
    if (scopeView !== this.scopeView || this.aim.blend !== this.scopeBlend) {
      this.scopeView = scopeView;
      this.scopeBlend = this.aim.blend;
      this.applyZoom();
    }
    const weakView = scopeView && !isStrong(scopeView) ? scopeView : null;
    const lookMax = weakView ? LOOK_MAX + (weakView.ahead - LOOK_MAX) * this.aim.blend : LOOK_MAX;
    const strongView = isStrong(scopeView) && this.aim.blend > 0 ? scopeView : null;

    // 3. Camera follow
    const local = this.world.getLocalEntity();
    if (local) {
      const mouseDx = this.mouse.screenX - width / 2;
      const mouseDy = this.mouse.screenY - height / 2;
      // A strong scope sets the view centre 0.85 of the way to the screen
      // edge along the aim, measured at its own zoom.
      const scope = strongView
        ? {
            ...scopeOffset(
              this.world.localPlayerAngle,
              this.camera.viewportWidth,
              this.camera.viewportHeight,
              baseWorldScale(this.camera.viewportWidth, this.camera.viewportHeight) * strongView.zoom,
            ),
            blend: this.aim.blend,
          }
        : undefined;
      this.camera.update(local.x, local.y, mouseDx, mouseDy, delta, lookMax, scope);
      // The maps remember what has been on screen.
      const tl = this.camera.screenToWorld(0, 0);
      const br = this.camera.screenToWorld(this.camera.viewportWidth, this.camera.viewportHeight);
      this.world.mapMemory.resize(this.world.tilesX, this.world.tilesY);
      this.world.mapMemory.observe(
        { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y },
        () => this.world.entities.all(),
        now,
      );
    }

    // 4. World renderer
    prof.begin('render');
    const night = nightAt(this.world.clock.phaseMs, this.world.clock.cycleMs);
    this.renderer.render({
      ctx,
      camera: this.camera,
      world: this.world,
      content: this.content,
      assets: this.assets,
      particles: this.hudControlsState.particlesDisabled ? undefined : this.particles,
      buildingAnimator: this.buildingAnimator,
      brZone: this.brZone,
      ghoulEffects: this.ghoulEffects,
      statusVignette: this.statusVignette,
      animator: this.animator,
      explosions: this.explosions,
      clans: this.clans,
      questMarkers: this.windows.quests.markers,
      timeMs: performance.now(),
      profiler: prof,
      groundOverlay: (c) => this.placement.renderGrid(c, this.assets),
      night,
    });
    prof.end('render');

    // 4b. Scope mask: darken what the server does not send while aimed.
    if (local && scopeView && this.aim.blend > 0) {
      if (isStrong(scopeView)) {
        this.shapeMask.draw(
          ctx,
          this.camera,
          local.x,
          local.y,
          scopeOutline(scopeView, this.world.localPlayerAngle),
          scopeView.rearRadius,
          this.aim.blend,
        );
      } else if (this.aim.viewport) {
        const { viewX, viewY } = this.aim.viewport;
        const box = aimedView(scopeView, viewX, viewY, this.world.localPlayerAngle).box;
        drawScopeMask(ctx, this.camera, local.x, local.y, box, this.aim.blend);
      }
    }

    prof.begin('overlay');
    // 5. Placement ghost preview
    this.placement.render(ctx, this.assets, night >= 0.5);

    // 5a. Gauge alert bubbles over players (screen space, never under a wall)
    this.playerAlerts.render(ctx, this.camera, this.assets, this.world);
    if (this.hud.chat.settings.bubbles) this.chatBubbles.render(ctx, this.camera, this.world);
    this.damageNumbers.render(ctx, this.camera);

    // 5b. Interaction badge above our head (E / F), use timer, wrong-tool flash
    this.prompt.render(
      ctx,
      this.camera,
      this.assets,
      local,
      this.input.currentTarget,
      this.input.lootTarget,
      this.placement.rotateHintAlpha(),
    );
    prof.end('overlay');

    // 6. In-game HUD (DOM overlay)
    prof.begin('hud');
    this.hudControlsState.skillPoints = this.inventory.skillPointsLeft(this.skillCostOf());
    this.hud.update({
      world: this.world,
      inventory: this.inventory,
      clans: this.clans,
      content: this.content,
      assets: this.assets,
      brZone: this.brZone,
      controlsState: this.hudControlsState,
      pingMs: this.socket.stats.rttMs,
      quests: this.windows.quests,
      questBag: this.windows.bagCount,
      timeMs: now,
      deltaMs: delta,
      profiler: prof,
    });
    prof.end('hud');

    // 7. Modal windows (DOM overlay)
    prof.begin('windows');
    if (this.windows.activeWindow === 'mods')
      this.windows.modsWindow.previewInventory(this.inventory, this.hud.hotbar.previewIndex);
    this.windows.update();
    prof.end('windows');

    if (prof.isEnabled) {
      const sprites = this.assets.stats;
      const net = this.socket.stats;
      prof.gauge('entities.total', this.world.entities.count);
      prof.delta('sprites.draw', sprites.hits);
      prof.delta('sprites.firstDraw', sprites.firstDraws);
      prof.delta('sprites.miss', sprites.misses);
      prof.delta('net.msgs', net.messages);
      prof.delta('net.bytes', net.bytes);
      prof.frameEnd();
      this.profilerHud.update(prof, now, {
        pingMs: net.rttMs,
        lines: [
          [
            'sprites',
            `${sprites.resident} resident (${(sprites.residentBytes / 1048576).toFixed(0)} MB decoded), ` +
              `${sprites.inflight} loading, ${sprites.queued} queued, ${sprites.failed} failed`,
          ],
          [
            'decode',
            `${sprites.decoded} bitmaps, ${sprites.decodeMs.toFixed(0)} ms off-thread total`,
          ],
          [
            'net',
            `${net.messages} msgs, ${(net.bytes / 1024).toFixed(0)} KB, decode ${net.decodeMs.toFixed(0)} ms`,
          ],
        ],
      });
    }
  }

  /** Writes fit x Options sizes onto every DOM root as --hud-z-* (hud.css zooms the regions). */
  private applyUiScale(): void {
    const effective = effectiveUiScale(this.hudControlsState.uiScale, this.uiFit);
    applyUiScale(
      [this.hudRoot, this.modalRoot, this.invitationRoot, this.hud.chat.noticesEl],
      effective,
    );
    this.hud.chat.noticesEl.style.setProperty(
      '--hud-notice-y',
      `${this.hudControlsState.noticeY}px`,
    );
    // The minimap is a canvas: its backing store has to follow the zoom to stay sharp.
    this.hud.minimap.setScale(effective.minimap);
    this.hud.hotbar.setScale(effective.inventory);
  }

  private handleUiScaleAction(action: UiScaleAction): void {
    const state = this.hudControlsState;
    state.uiScale =
      action.type === 'ui_scale_reset'
        ? { ...DEFAULT_UI_SCALE }
        : stepUiScale(state.uiScale, action.region, action.direction);
    writeSetting(UI_SCALE_SETTING, serializeUiScale(state.uiScale));
    this.applyUiScale();
  }

  private sendPrivateMessages(): void {
    const policy = {
      everyone: PrivateMessagePolicy.EVERYONE,
      clan: PrivateMessagePolicy.CLAN,
      nobody: PrivateMessagePolicy.NOBODY,
    }[this.hudControlsState.privateMessages];
    this.socket.setPrivateMessages(policy);
  }

  /** Writes the persisted Options rows (options-settings.ts) after a change. */
  private saveOptions(): void {
    writeSetting(OPTIONS_SETTING, serializeOptions(this.hudControlsState));
  }

  handleHudAction(action: HudAction): void {
    if (typeof action === 'object') {
      if ('type' in action && action.type === 'notice_y_set') {
        this.hudControlsState.noticeY = Math.max(0, Math.min(1000, action.value));
        this.applyUiScale();
        this.saveOptions();
      } else if ('type' in action && action.type === 'private_messages_set') {
        this.hudControlsState.privateMessages = action.value;
        this.saveOptions();
        this.sendPrivateMessages();
      } else if ('type' in action && action.type === 'volume_set') {
        const val = Math.max(0, Math.min(1, action.value));
        if (action.kind === 'master') {
          this.hudControlsState.volumeMaster = val;
          this.audio.setMasterVolume(val);
        } else if (action.kind === 'sfx') {
          this.hudControlsState.volumeSfx = val;
          this.audio.setSfxVolume(val);
        } else if (action.kind === 'music') {
          this.hudControlsState.volumeMusic = val;
          this.audio.setMusicVolume(val);
        }
        this.saveOptions();
      } else {
        this.handleUiScaleAction(action);
      }
      return;
    }
    switch (action) {
      case 'toggle_audio': {
        this.hudControlsState.audioMuted = !this.hudControlsState.audioMuted;
        this.audio.setMuted(this.hudControlsState.audioMuted);
        this.saveOptions();
        break;
      }
      case 'toggle_particles': {
        this.hudControlsState.particlesDisabled = !this.hudControlsState.particlesDisabled;
        this.saveOptions();
        break;
      }
      case 'zoom_in': {
        this.stepZoom(1);
        break;
      }
      case 'zoom_out': {
        this.stepZoom(-1);
        break;
      }
      case 'toggle_profiler': {
        this.setProfilerVisible(!this.profilerHud.isVisible);
        break;
      }
      case 'toggle_stats': {
        this.hudControlsState.statsVisible = !this.hudControlsState.statsVisible;
        writeSetting(STATS_SETTING, this.hudControlsState.statsVisible ? '1' : '0');
        break;
      }
      case 'toggle_map': {
        this.windows.toggle('map');
        this.audio.playUi('open');
        break;
      }
      case 'toggle_options': {
        this.windows.toggle('options');
        this.audio.playUi('open');
        break;
      }
      case 'toggle_keyboard': {
        this.hudControlsState.keyboardLayout =
          this.hudControlsState.keyboardLayout === 'qwerty' ? 'azerty' : 'qwerty';
        this.saveOptions();
        break;
      }
      case 'toggle_chat': {
        this.toggleChat();
        break;
      }
      case 'toggle_leaderboard': {
        this.hudControlsState.leaderboardVisible = !this.hudControlsState.leaderboardVisible;
        this.saveOptions();
        break;
      }
      case 'toggle_craft': {
        this.windows.toggle('craft');
        this.audio.playUi('open');
        break;
      }
      case 'toggle_skills': {
        this.windows.toggle('skills');
        this.audio.playUi('open');
        break;
      }
      case 'toggle_team': {
        this.windows.toggle('team');
        this.audio.playUi('open');
        break;
      }
      case 'toggle_quests': {
        this.windows.toggle('quests');
        this.audio.playUi('open');
        break;
      }
    }
  }

  stop(): void {
    this.running = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
    this.audio.stopAmbiance();
    this.audio.stopGeiger();
    this.hudRoot.hidden = true;
    this.modalRoot.hidden = true;
    this.invitationRoot.hidden = true;
    this.canvasManager.setResolutionDivisor(1);
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.keyboard.destroy();
    this.mouse.destroy();
    this.profiler.destroy();
    this.socket.close();
    // Leaving the world: the core set stays pinned for the next session,
    // everything else is released so the start screen does not sit on 200 MB.
    this.assets.releaseUnpinned();
  }
}
