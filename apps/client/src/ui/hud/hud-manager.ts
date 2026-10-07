// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-manager.ts
// Mounts and updates the DOM in-game HUD: tactical gauges, hotbar, chat,
// minimap, controls toolbar and alerts. The interaction badge is drawn on the
// canvas (render/interact-prompt.ts), like the old client.

import type { AssetLoader } from '../../assets/asset-loader';
import type { ContentStore } from '../../content/store';
import type { Profiler } from '../../core/profiler';
import type { BRZone } from '../../game/modes/br-zone';
import type { ClanStore } from '../../world/clan-store';
import type { InventoryStore } from '../../world/inventory-store';
import type { WorldState } from '../../world/world-state';
import type { QuestStore } from '../../world/quest-store';
import { HudAlerts } from './hud-alerts';
import { HudChat } from './hud-chat';
import { HudControls, type HudControlAction, type HudControlsState } from './hud-controls';
import { HudGauges } from './hud-gauges';
import { HudHotbar, type HotbarCallbacks } from './hud-hotbar';
import { HudInvitation, type HudInvitationCallbacks } from './hud-invitation';
import { HudLeaderboard } from './hud-leaderboard';
import { HudMinimap } from './hud-minimap';
import { HudStats } from './hud-stats';
import { HudQuestTracker } from './hud-quest-tracker';
import { DEFAULT_UI_SCALE } from '../ui-scale';

export interface HudUpdateOptions {
  world: WorldState;
  inventory: InventoryStore;
  clans: ClanStore;
  content: ContentStore;
  assets: AssetLoader;
  brZone?: BRZone;
  controlsState?: HudControlsState;
  timeMs?: number;
  deltaMs?: number;
  profiler?: Profiler;
  /** Last keepalive round trip (socket.stats.rttMs); -1 until one answered. */
  pingMs?: number;
  /** The journal the tracker under the minimap follows. */
  quests?: QuestStore;
  /** Carried count of an item, for give objectives. */
  questBag?: (itemKey: string) => number;
}

export class HudManager {
  readonly gauges = new HudGauges();
  readonly hotbar = new HudHotbar();
  readonly minimap = new HudMinimap();
  readonly leaderboard = new HudLeaderboard();
  readonly chat = new HudChat();
  readonly controls = new HudControls();
  readonly alerts = new HudAlerts();
  readonly invitation = new HudInvitation();
  readonly stats = new HudStats();
  readonly questTracker = new HudQuestTracker();
  /** A tracked quest's name was clicked: open the journal on it. */
  onQuestOpen?: (questKey: string) => void;

  private defaultControlsState: HudControlsState = {
    audioMuted: false,
    volumeMaster: 1.0,
    volumeSfx: 0.8,
    volumeMusic: 0.5,
    particlesDisabled: false,
    zoomLevel: 1.0,
    keyboardLayout: 'qwerty',
    leaderboardVisible: true,
    profilerVisible: false,
    statsVisible: false,
    skillPoints: 0,
    uiScale: { ...DEFAULT_UI_SCALE },
    noticeY: 80,
    privateMessages: 'everyone',
  };

  mount(
    root: HTMLElement,
    onControlAction: (action: HudControlAction) => void,
    hotbar: HotbarCallbacks | ((index: number) => void),
    invitation: HudInvitationCallbacks = { onAccept: () => {} },
    /** Lives outside `root`, above the windows layer, so it stays clickable with a window open. */
    invitationRoot: HTMLElement = root.querySelector<HTMLElement>('.hud-invitation') ??
      document.createElement('div'),
  ): void {
    this.controls.mount(query(root, '.hud-controls'), this.defaultControlsState, onControlAction);
    this.alerts.mount(query(root, '.hud-alerts'));
    this.invitation.mount(invitationRoot, invitation);
    this.gauges.mount(query(root, '.hud-gauges'));
    this.chat.mount(
      query(root, '.hud-chat'),
      root.querySelector<HTMLElement>('.hud-chat-notices') ?? undefined,
    );
    const hotbarCallbacks: HotbarCallbacks =
      typeof hotbar === 'function'
        ? {
            onSelect: hotbar,
            onStore: () => {},
            onSplit: () => {},
            onThrow: () => {},
            onMenu: () => {},
            onStack: () => {},
            onSwap: () => {},
            onBag: () => {},
          }
        : hotbar;
    this.hotbar.mount(
      query(root, '.hud-hotbar'),
      hotbarCallbacks,
      root.querySelector<HTMLElement>('.hud-bag-corner') ?? undefined,
    );
    this.minimap.mount(
      query<HTMLCanvasElement>(root, '.hud-minimap'),
      root.querySelector<HTMLElement>('.hud-sector'),
    );
    this.leaderboard.mount(query(root, '.hud-leaderboard'));
    this.stats.mount(
      root.querySelector<HTMLElement>('.hud-stats') ?? document.createElement('div'),
    );
    this.questTracker.mount(root.querySelector<HTMLElement>('.hud-quests') ?? document.createElement('div'), {
      onOpen: (key) => this.onQuestOpen?.(key),
    });
  }

  update(options: HudUpdateOptions): void {
    const {
      world,
      inventory,
      clans,
      content,
      brZone,
      timeMs = performance.now(),
      deltaMs = 16.67,
    } = options;

    const state = options.controlsState ?? this.defaultControlsState;
    const prof = options.profiler;

    prof?.begin('hud.alerts');
    this.controls.update(state);
    this.alerts.update(deltaMs);
    this.alerts.render();
    prof?.end('hud.alerts');
    prof?.begin('hud.gauges');
    this.gauges.update(world.gauges, inventory, world.clock);
    prof?.end('hud.gauges');
    prof?.begin('hud.chat');
    this.chat.update();
    prof?.end('hud.chat');
    prof?.begin('hud.hotbar');
    this.hotbar.update(inventory, content);
    prof?.end('hud.hotbar');
    prof?.begin('hud.minimap');
    this.minimap.render(world, clans, brZone, options.assets, content);
    prof?.end('hud.minimap');
    prof?.begin('hud.leaderboard');
    this.leaderboard.update(world, state.leaderboardVisible);
    this.invitation.update(clans);
    if (this.stats.isVisible !== state.statsVisible) this.stats.setVisible(state.statsVisible);
    this.stats.update(timeMs, options.pingMs ?? -1);
    if (options.quests) this.questTracker.update(options.quests, timeMs, options.questBag);
    prof?.end('hud.leaderboard');
  }
}

function query<T extends HTMLElement = HTMLElement>(root: HTMLElement, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`HUD element not found for selector "${selector}"`);
  return el;
}
