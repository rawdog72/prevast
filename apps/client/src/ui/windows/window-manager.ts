// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/windows/window-manager.ts
// Mounts and updates the single shared DOM modal shell (backdrop + panel),
// swapping in whichever window's content is currently active.

import type { AssetLoader } from '../../assets/asset-loader';
import type { ContentStore } from '../../content/store';
import type { StationInReach } from '../../game/input-manager';
import type { BRZone } from '../../game/modes/br-zone';
import { ClientOpcode } from '../../net/opcodes';
import type { GameSocket } from '../../net/socket';
import type { ClanStore } from '../../world/clan-store';
import type { InventoryStore } from '../../world/inventory-store';
import type { WorldState } from '../../world/world-state';
import { icon } from '../dom/icons';
import type { HudAction, HudControlsState } from '../hud/hud-controls';
import { hoverCard } from '../hud/weapon-card';
import { ChestWindow } from './chest-window';
import { ClanWindow, type ClanRules, type ClanWindowCallbacks } from './clan-window';
import { CraftingWindow, type CraftingWindowCallbacks } from './crafting-window';
import { DeathWindow } from './death-window';
import { MapWindow } from './map-window';
import { ModsWindow } from './mods-window';
import { OptionsWindow } from './options-window';
import { NpcStore } from '../../world/npc-store';
import { NpcWindow } from './npc-window';
import { QuestWindow } from './quest-window';
import { QuestStore } from '../../world/quest-store';
import { ProgressStore } from '../../world/progress-store';
import { TradeStore } from '../../world/trade-store';
import { TradeWindow } from './trade-window';
import { DEFAULT_UI_SCALE } from '../ui-scale';

export type WindowType =
  | 'none'
  | 'npc'
  | 'trade'
  | 'craft'
  | 'chest'
  | 'station'
  | 'team'
  | 'skills'
  | 'death'
  | 'map'
  | 'quests'
  | 'options'
  | 'mods';

interface WindowChrome {
  title: string;
  subtitle?: string;
  /** Extra class on the panel so each window can size itself (GameUI windowLayout widths). */
  size: string;
  closable: boolean;
  /** No title bar: the panel hugs its content, the close button floats on its corner. */
  bare?: boolean;
}

/**
 * craft / station / skills are one window (the crafting window, which draws
 * the station tabs and the skill tabs itself): switching among them refreshes
 * the mounted window rather than rebuilding it.
 */
const CRAFT_FAMILY: ReadonlySet<WindowType> = new Set(['craft', 'station', 'skills']);
function mountKey(type: WindowType): WindowType {
  return CRAFT_FAMILY.has(type) ? 'craft' : type;
}

const CHROME: Record<Exclude<WindowType, 'none'>, WindowChrome> = {
  npc: { title: 'NPC', size: 'dv-modal-npc', closable: true },
  trade: { title: 'Trade', size: 'dv-modal-trade', closable: true },
  craft: { title: 'Crafting', size: 'dv-modal-craft', closable: true },
  chest: { title: 'Container', size: 'dv-modal-chest', closable: true, bare: true },
  // A station is the craft window forced onto that station's area (old client _Craft with isInBuilding).
  station: { title: 'Station', size: 'dv-modal-craft', closable: true },
  team: { title: 'Teams & clan', size: 'dv-modal-clan', closable: true },
  // Skills are the craft window's skill tabs (old client skill box); the craft window titles itself.
  skills: { title: 'Crafting', size: 'dv-modal-craft', closable: true },
  death: { title: 'You died', size: 'dv-modal-death', closable: false },
  // M: the old _BigMinimap as GameUI.mapGrid.
  map: { title: 'Map', size: 'dv-modal-map', closable: true },
  // J: the quest journal (quest-window.ts).
  quests: { title: 'Quests', size: 'dv-modal-quests', closable: true },
  // GameUI.settings rows.
  options: { title: 'Options', size: 'dv-modal-options', closable: true },
  // A gun's right-click menu > Mods (mods-window.ts); the window titles itself after the gun.
  mods: { title: 'Mods', size: 'dv-modal-mods', closable: true },
};

export interface WindowManagerOptions {
  inventory: InventoryStore;
  world: WorldState;
  clans: ClanStore;
  content: ContentStore;
  assets: AssetLoader;
  socket: GameSocket;
  onPlayAgain?: () => void;
  onMainMenu?: () => void;
  /** Live toolbar state and its handler, for the Options window (same actions as the HUD strip). */
  controlsState?: () => HudControlsState;
  onControlAction?: (action: HudAction) => void;
  brZone?: BRZone;
  /** The usable stations in reach (InputManager), for the craft window's station tabs. */
  stationsInReach?: () => StationInReach[];
  /** Right-click on a container slot: the item's menu. */
  onChestMenu?: (chestSlotIndex: number, clientX: number, clientY: number) => void;
}

export class WindowManager {
  readonly inventory: InventoryStore;
  readonly world: WorldState;
  readonly clans: ClanStore;
  readonly content: ContentStore;
  readonly assets: AssetLoader;
  readonly socket: GameSocket;
  readonly onPlayAgain?: () => void;
  readonly onMainMenu?: () => void;
  readonly onChestMenu?: (chestSlotIndex: number, clientX: number, clientY: number) => void;
  readonly controlsState: () => HudControlsState;
  readonly onControlAction: (action: HudAction) => void;
  readonly brZone?: BRZone;
  readonly stationsInReach: () => StationInReach[];

  activeWindow: WindowType = 'none';
  private lastActive: WindowType = 'none';

  readonly npc = new NpcStore();
  readonly npcWindow = new NpcWindow();
  readonly quests = new QuestStore();
  readonly progress = new ProgressStore();
  readonly questWindow = new QuestWindow();
  readonly trade = new TradeStore();
  readonly tradeWindow = new TradeWindow();
  readonly craftingWindow = new CraftingWindow();
  readonly chestWindow = new ChestWindow();
  readonly clanWindow = new ClanWindow();
  readonly deathWindow = new DeathWindow();
  readonly mapWindow = new MapWindow();
  readonly optionsWindow = new OptionsWindow();
  readonly modsWindow = new ModsWindow();

  private root!: HTMLElement;
  private panel!: HTMLElement;
  private titleEl!: HTMLElement;
  private subEl!: HTMLElement;
  private closeBtn!: HTMLButtonElement;
  private body!: HTMLElement;
  private mountedWindow: WindowType = 'none';

  constructor(options: WindowManagerOptions) {
    this.inventory = options.inventory;
    this.world = options.world;
    this.clans = options.clans;
    this.content = options.content;
    this.assets = options.assets;
    this.socket = options.socket;
    this.onPlayAgain = options.onPlayAgain;
    this.onMainMenu = options.onMainMenu;
    this.onChestMenu = options.onChestMenu;
    this.controlsState =
      options.controlsState ??
      (() => ({
        audioMuted: false,
        volumeMaster: 1.0,
        volumeSfx: 0.8,
        volumeMusic: 0.5,
        particlesDisabled: false,
        zoomLevel: 1,
        keyboardLayout: 'qwerty',
        leaderboardVisible: true,
        profilerVisible: false,
        statsVisible: false,
        skillPoints: 0,
        uiScale: { ...DEFAULT_UI_SCALE },
        noticeY: 80,
        privateMessages: 'everyone',
      }));
    this.onControlAction = options.onControlAction ?? (() => {});
    this.brZone = options.brZone;
    this.stationsInReach = options.stationsInReach ?? (() => []);
  }

  mount(root: HTMLElement): void {
    this.root = root;
    // GameUI windowLayout: one floating panel over the live game (no dimming
    // and nothing else covering the screen -- the HUD under it stays usable,
    // so a hotbar click can store into an open chest), title top-left, a 36px
    // close square top-right, content below. A click on the game canvas is
    // what closes the window (InputManager -> closeFromOutside).
    root.innerHTML =
      `<section class="dv-modal dv-window" role="dialog">` +
      `<header class="dv-window-head">` +
      `<div class="dv-window-titles"><h2 class="dv-window-title"></h2><div class="dv-window-sub"></div></div>` +
      `<button type="button" class="dv-close" aria-label="Close">${icon('close')}</button>` +
      `</header>` +
      `<div class="dv-window-body"></div>` +
      `</section>`;

    this.panel = root.querySelector('.dv-modal')!;
    this.titleEl = root.querySelector('.dv-window-title')!;
    this.subEl = root.querySelector('.dv-window-sub')!;
    this.closeBtn = root.querySelector('.dv-close')!;
    this.body = root.querySelector('.dv-window-body')!;

    this.closeBtn.addEventListener('click', () => this.close());
  }

  open(type: WindowType): void {
    if (this.trade.state && type !== 'trade' && type !== 'death') return;
    this.activeWindow = type;
  }

  /** A click on the game outside the panel: closes anything but the death window. */
  closeFromOutside(): void {
    if (
      this.activeWindow === 'none' ||
      this.activeWindow === 'death' ||
      this.activeWindow === 'trade' ||
      this.activeWindow === 'npc'
    )
      return;
    this.close();
  }

  close(): void {
    if (this.activeWindow === 'npc') this.npc.close(this.socket);
    if (this.trade.state) this.trade.cancel(this.socket);
    // Whatever the server has open for us goes with the window (old releaseBuilding).
    if (this.inventory.isChestOpen || this.inventory.isStationOpen) {
      this.socket.closeContainer();
      this.inventory.closeContainers();
    }
    this.activeWindow = 'none';
  }

  toggle(type: WindowType): void {
    if (this.trade.state) return;
    if (mountKey(this.activeWindow) === mountKey(type)) this.close();
    else this.activeWindow = type;
  }

  isModalOpen(): boolean {
    return this.activeWindow !== 'none';
  }

  syncWithState(): void {
    if (this.inventory.isDead) {
      this.activeWindow = 'death';
    } else if (this.trade.state && !this.trade.closing) {
      this.activeWindow = 'trade';
    } else if (this.activeWindow === 'trade') {
      this.activeWindow = 'none';
    } else if (this.npc.panel && !this.inventory.isDead) {
      this.activeWindow = 'npc';
    } else if (this.activeWindow === 'npc') {
      this.activeWindow = 'none';
    } else if (this.activeWindow === 'mods' && !this.modsWindow.weapon(this.inventory)) {
      // The gun left the inventory (dropped, stored, traded, died).
      this.activeWindow = 'none';
    } else if (this.inventory.isChestOpen && this.activeWindow !== 'chest') {
      this.activeWindow = 'chest';
    } else if (this.inventory.isStationOpen && !CRAFT_FAMILY.has(this.activeWindow)) {
      // OPEN_BUILDING: the craft window on that station's area. Losing the
      // station later (LOST_BUILDING) only drops the window back to By hand.
      this.activeWindow = 'station';
    } else if (!this.inventory.isChestOpen && this.activeWindow === 'chest') {
      this.activeWindow = 'none';
    }
  }

  /** How many of an item (by key) the player carries. */
  readonly bagCount = (itemKey: string): number => {
    const item = this.content.has('items') ? this.content.byKey('items', itemKey) : undefined;
    if (!item) return 0;
    let count = 0;
    for (const slot of this.inventory.slots) if (slot.iid === item.id) count += slot.count;
    return count;
  };

  /** Opens the journal on one quest (the tracker's quest names). */
  openQuest(key: string): void {
    this.questWindow.select(key, this.quests);
    if (mountKey(this.activeWindow) === 'quests') this.questWindow.refresh(this.questDeps());
    else this.open('quests');
  }

  /** The Mods window on the gun with this wire uid (its right-click menu). */
  openMods(uid: number): void {
    this.modsWindow.open(uid);
    this.open('mods');
  }

  private modsDeps() {
    return { inventory: this.inventory, content: this.content, socket: this.socket };
  }

  private questDeps() {
    return { quests: this.quests, socket: this.socket, progress: this.progress, content: this.content, bag: this.bagCount };
  }

  update(): void {
    this.npc.update(this.socket);
    this.quests.update(this.socket);
    this.syncWithState();
    this.root.hidden = this.activeWindow === 'none';
    if (this.activeWindow === 'none') {
      // Drop the closed window's size class too, or the next window inherits
      // whichever width rule comes later in the stylesheet.
      if (this.mountedWindow !== 'none') {
        if (this.mountedWindow === 'mods') this.modsWindow.unmount();
        this.panel.classList.remove(CHROME[this.mountedWindow].size);
        // A chest or trade slot card was over the window that just closed; no pointerleave follows.
        hoverCard().hide();
      }
      this.mountedWindow = 'none';
      return;
    }

    const chrome = CHROME[this.activeWindow];
    this.closeBtn.hidden = !chrome.closable;
    this.panel.classList.toggle('is-bare', !!chrome.bare);

    const key = mountKey(this.activeWindow);
    if (key !== this.mountedWindow) {
      if (this.mountedWindow !== 'none') {
        if (this.mountedWindow === 'mods') this.modsWindow.unmount();
        this.panel.classList.remove(CHROME[this.mountedWindow].size);
        // The slot a card was over is gone with the old window.
        hoverCard().hide();
      }
      this.panel.classList.add(chrome.size);
      this.mountedWindow = key;
      this.lastActive = this.activeWindow;
      this.titleEl.textContent = chrome.title;
      this.subEl.textContent = chrome.subtitle ?? '';
      this.mountActiveWindow();
      return;
    }

    // K while the crafting window is already up: jump to the skill tabs.
    if (this.activeWindow === 'skills' && this.lastActive !== 'skills')
      this.craftingWindow.showSkills();
    this.lastActive = this.activeWindow;
    this.refreshActiveWindow();
  }

  private mountActiveWindow(): void {
    switch (this.activeWindow) {
      case 'npc':
        this.npcWindow.mount(this.body, this);
        break;
      case 'trade':
        this.tradeWindow.mount(this.body, this, { title: this.titleEl, sub: this.subEl });
        break;
      case 'craft':
      case 'station':
      case 'skills':
        this.craftingWindow.tab = 'craft';
        this.craftingWindow.mount(
          this.body,
          { title: this.titleEl, sub: this.subEl },
          this.content,
          this.inventory,
          this.craftCallbacks(),
        );
        // K: straight onto the first skill tab. After mount, which is what
        // builds the recipe list the tabs come from.
        if (this.activeWindow === 'skills') {
          this.craftingWindow.showSkills();
          this.craftingWindow.refresh(this.content, this.inventory, this.craftCallbacks());
        }
        break;
      case 'map':
        this.mapWindow.mount(this.body, this.mapDeps());
        break;
      case 'quests':
        this.questWindow.mount(this.body, this.questDeps());
        break;
      case 'options':
        this.optionsWindow.mount(this.body, this.controlsState(), this.onControlAction);
        break;
      case 'mods':
        this.modsWindow.mount(this.body, this.modsDeps(), { title: this.titleEl });
        break;
      case 'chest':
        this.chestWindow.mount(this.body, this.inventory, this.content, {
          onTake: (slot, inventorySlot) => {
            const item = this.inventory.chestItems[slot];
            if (item && inventorySlot !== undefined)
              this.inventory.preferArrival(item.iid, inventorySlot);
            this.socket.takeItem(slot);
          },
          onMove: (from, to) => this.socket.moveContainerItem(from, to),
          onMenu: (slot, x, y) => this.onChestMenu?.(slot, x, y),
        });
        break;
      case 'team':
        this.clanWindow.mount(
          this.body,
          { title: this.titleEl, sub: this.subEl },
          this.clans,
          this.clanRules(),
          this.clanCallbacks(),
        );
        break;
      case 'death':
        this.deathWindow.mount(this.body, this.inventory, this.world, this.content, {
          onPlayAgain: () => this.onPlayAgain?.(),
          onMainMenu: () => this.onMainMenu?.(),
        });
        break;
    }
  }

  private craftCallbacks(): CraftingWindowCallbacks {
    return {
      onCraft: (iid, areaId) =>
        areaId === 0 ? this.socket.craftManual(iid) : this.socket.craftStation(iid),
      onCancel: () => this.socket.cancelCraft(),
      onUnlock: (iid) => this.socket.unlockSkill(iid),
      onAddFuel: (amount) => this.socket.addFuel(amount),
      // A station tab sends what E sends for that building (old client 11488).
      onOpenStation: (station) =>
        this.socket.interact(ClientOpcode.OPEN_STATION_15, station.entity.id, station.entity.pid),
      onLeaveStation: () => {
        this.socket.closeContainer();
        this.inventory.closeContainers();
      },
      onTakeFromStation: (slot) => this.socket.takeFromStation(slot),
      stationsInReach: () => this.stationsInReach(),
    };
  }

  /** Clan limits come from the config table the server exports; defaults match config.lua. */
  private clanRules(): ClanRules {
    const config = this.content.has('config') ? this.content.config : undefined;
    return {
      nameMaxLength: config?.clanNameMaxLength ?? 5,
      actionDelayMs: config?.clanActionDelayMs ?? 2000,
      now: () => Date.now(),
    };
  }

  private clanCallbacks(): ClanWindowCallbacks {
    return {
      onCreate: (name) => this.socket.createTeam(name),
      onRequest: (clanId) => this.socket.requestJoinTeam(clanId),
      onKick: (guid) => this.socket.kickTeam(guid),
      onLock: () => this.socket.lockTeam(),
      onUnlock: () => this.socket.unlockTeam(),
      onDelete: () => this.socket.deleteTeam(),
      onLeave: () => this.socket.leaveTeam(),
    };
  }

  private refreshActiveWindow(): void {
    switch (this.activeWindow) {
      case 'npc':
        this.npcWindow.refresh(this);
        break;
      case 'trade':
        this.tradeWindow.refresh(this);
        break;
      case 'craft':
      case 'station':
      case 'skills':
        this.craftingWindow.refresh(this.content, this.inventory, this.craftCallbacks());
        break;
      case 'chest':
        this.chestWindow.refresh(this.inventory, this.content);
        break;
      case 'team':
        this.clanWindow.refresh(this.clans, this.clanRules(), this.clanCallbacks());
        break;
      case 'map':
        this.mapWindow.refresh(this.mapDeps());
        break;
      case 'quests':
        this.questWindow.refresh(this.questDeps());
        break;
      case 'options':
        this.optionsWindow.refresh(this.controlsState());
        break;
      case 'mods':
        this.modsWindow.refresh(this.modsDeps());
        break;
      case 'death':
        break;
    }
  }

  private mapDeps() {
    return {
      world: this.world,
      clans: this.clans,
      assets: this.assets,
      content: this.content,
      brZone: this.brZone,
    };
  }
}
