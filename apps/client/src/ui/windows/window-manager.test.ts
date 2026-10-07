// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { AssetLoader } from '../../assets/asset-loader';
import { ContentStore } from '../../content/store';
import { NetEventBus } from '../../net/events';
import { GameSocket } from '../../net/socket';
import { ClanStore } from '../../world/clan-store';
import { InventoryStore } from '../../world/inventory-store';
import { WorldState } from '../../world/world-state';
import { hoverCard } from '../hud/weapon-card';
import { DEFAULT_UI_SCALE } from '../ui-scale';
import { WindowManager } from './window-manager';

describe('WindowManager', () => {
  function setup() {
    const inventory = new InventoryStore();
    const content = new ContentStore();
    const assets = new AssetLoader();
    const bus = new NetEventBus();
    const socket = new GameSocket({
      url: 'ws://127.0.0.1:7172',
      login: { nickname: 'Tester', password: '' },
      bus,
    });

    vi.spyOn(socket, 'closeContainer').mockImplementation(() => {});
    vi.spyOn(socket, 'craftManual').mockImplementation(() => {});
    vi.spyOn(socket, 'takeItem').mockImplementation(() => {});
    vi.spyOn(socket, 'storeItem').mockImplementation(() => {});
    vi.spyOn(socket, 'addFuel').mockImplementation(() => {});
    vi.spyOn(socket, 'unlockSkill').mockImplementation(() => {});

    content.load({
      name: 'items',
      version: 1,
      hash: 'h1',
      attributes: {},
      entries: {
        bandage: {
          key: 'bandage',
          id: 20,
          clientItemId: 20,
          name: 'Bandage',
          properties: {},
          crafting: {
            recipe: {
              ingredient: [{ itemKey: 'cloth', amount: 2 }],
            },
          },
        },
        cloth: {
          key: 'cloth',
          id: 21,
          clientItemId: 21,
          name: 'Cloth',
          properties: {},
        },
        splint: {
          key: 'splint',
          id: 22,
          clientItemId: 22,
          name: 'Splint',
          properties: {},
          skill: { type: 'survival', requiredLevel: 2, skillCost: 1 },
          crafting: { recipe: { ingredient: [{ itemKey: 'cloth', amount: 4 }] } },
        },
      },
    });

    content.load({
      name: 'skills',
      version: 1,
      hash: 'h2',
      attributes: {},
      entries: { survival: { key: 'survival', name: 'Survival', icon: 'survival-button' } },
    });

    const world = new WorldState();
    const clans = new ClanStore(world);
    const controlsState = {
      audioMuted: false,
      volumeMaster: 1.0,
      volumeSfx: 0.8,
      volumeMusic: 0.5,
      particlesDisabled: false,
      zoomLevel: 1,
      keyboardLayout: 'qwerty' as const,
      leaderboardVisible: true,
      profilerVisible: false,
      statsVisible: false,
      skillPoints: 0,
      uiScale: { ...DEFAULT_UI_SCALE },
      noticeY: 80,
      privateMessages: 'everyone' as const,
    };
    const onControlAction = vi.fn();
    const manager = new WindowManager({
      inventory,
      world,
      clans,
      content,
      assets,
      socket,
      controlsState: () => controlsState,
      onControlAction,
    });
    const root = document.createElement('div');
    manager.mount(root);

    return { manager, inventory, socket, content, root, controlsState, onControlAction };
  }

  it('manages open/close and toggle lifecycle', () => {
    const { manager, socket, inventory } = setup();

    expect(manager.isModalOpen()).toBe(false);
    expect(manager.activeWindow).toBe('none');

    manager.open('craft');
    expect(manager.isModalOpen()).toBe(true);
    expect(manager.activeWindow).toBe('craft');

    manager.toggle('craft');
    expect(manager.isModalOpen()).toBe(false);

    manager.open('chest');
    manager.close();
    // Nothing is open on the server, so nothing to close there.
    expect(socket.closeContainer).not.toHaveBeenCalled();
    inventory.isChestOpen = true;
    manager.open('chest');
    manager.close();
    expect(socket.closeContainer).toHaveBeenCalled();
    expect(inventory.isChestOpen).toBe(false);
  });

  it('keeps a trade visible across outside clicks, cancels explicitly and closes on the server reply', () => {
    const { manager, socket, root } = setup();
    vi.spyOn(socket, 'tradeCancel').mockImplementation(() => {});
    const detach = manager.trade.attachBus(socket.bus);
    socket.bus.emit('tradeState', { id: 4, revision: 2, peer: 2, phase: 2, accepted: 0,
      rangeTiles: 2, own: [], theirs: [] });
    manager.update();
    expect(manager.activeWindow).toBe('trade');
    manager.closeFromOutside(); manager.toggle('craft'); manager.update();
    expect(manager.activeWindow).toBe('trade');
    expect(socket.tradeCancel).not.toHaveBeenCalled();
    manager.close(); manager.update();
    expect(socket.tradeCancel).toHaveBeenCalledWith(4);
    expect(root.hidden).toBe(true);
    socket.bus.emit('tradeClosed', { id: 4, reason: 'Trade cancelled.' });
    expect(manager.trade.state).toBeNull();
    detach();
  });

  it('craft, station and skills are one mounted window: switching refreshes, losing the station keeps it up', () => {
    const { manager, inventory, root } = setup();
    manager.open('craft');
    manager.update();
    const layout = root.querySelector('.dv-craft')!;
    expect(root.querySelector('.dv-window-title')!.textContent).toBe('Crafting');

    // OPEN_BUILDING: the same window, now on the station's area.
    inventory.isStationOpen = true;
    inventory.stationArea = 2;
    manager.update();
    expect(manager.activeWindow).toBe('craft'); // already the craft family: nothing to switch
    expect(root.querySelector('.dv-craft')).toBe(layout);

    // LOST_BUILDING: back to By hand, still open.
    inventory.closeContainers();
    manager.update();
    expect(manager.isModalOpen()).toBe(true);
    expect(root.querySelector('.dv-craft')).toBe(layout);
    expect(root.querySelector('.dv-window-title')!.textContent).toBe('Crafting');

    // C while it is up closes it (one family), and closes the station on the server if any.
    manager.toggle('craft');
    expect(manager.isModalOpen()).toBe(false);

    // E at a station with nothing open: the craft window comes up on it.
    inventory.isStationOpen = true;
    manager.update();
    expect(manager.activeWindow).toBe('station');
    expect(manager.isModalOpen()).toBe(true);
  });

  it('automatically syncs with state when dead or container opened', () => {
    const { manager, inventory } = setup();

    inventory.isChestOpen = true;
    manager.syncWithState();
    expect(manager.activeWindow).toBe('chest');

    inventory.isDead = true;
    manager.syncWithState();
    expect(manager.activeWindow).toBe('death');
  });

  it('renders GameUI chrome: a floating .dv-window with title and close, and nothing covering the HUD', () => {
    const { manager, root } = setup();
    manager.open('craft');
    manager.update();

    const panel = root.querySelector<HTMLElement>('.dv-modal.dv-window')!;
    expect(panel).not.toBeNull();
    expect(panel.querySelector('.dv-window-title')!.textContent).toBe('Crafting');
    expect(panel.querySelector('.dv-close')).not.toBeNull();
    // The old client's windows float over the live game: no darkening layer
    // and no click-catcher either -- one would sit over the hotbar and eat the
    // click that stores an item in an open chest. A click on the game canvas
    // is what closes a window (InputManager -> closeFromOutside).
    expect(root.querySelector('.dv-modal-catch')).toBeNull();
    expect(root.querySelector('.hud-modal-backdrop')).toBeNull();
    expect(panel.classList.contains('is-bare')).toBe(false);
  });

  it('closes on a canvas click but not on a click inside the panel', () => {
    const { manager, root } = setup();
    manager.open('craft');
    manager.update();

    root
      .querySelector<HTMLElement>('.dv-modal')!
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(manager.activeWindow).toBe('craft');

    manager.closeFromOutside();
    expect(manager.activeWindow).toBe('none');
  });

  it('the death window outside-click does not close (no respawn shortcut)', () => {
    const { manager } = setup();
    manager.open('death');
    manager.update();
    manager.closeFromOutside();
    expect(manager.activeWindow).toBe('death');
  });

  it('the container is a bare glass panel: no title, a floating close, the capacity under it', () => {
    const { manager, root, inventory } = setup();
    inventory.isChestOpen = true;
    inventory.chestCapacity = 4;
    inventory.chestItems = [{ iid: 20, count: 2, ammo: 0, mods: [] }];
    manager.update();
    expect(manager.activeWindow).toBe('chest');
    const panel = root.querySelector<HTMLElement>('.dv-modal')!;
    expect(panel.classList.contains('is-bare')).toBe(true);
    expect(panel.querySelector('.dv-chest-capacity')!.textContent).toBe('1 / 4');
    manager.close();
    manager.open('craft');
    manager.update();
    expect(panel.classList.contains('is-bare')).toBe(false);
  });

  it('mounts every window type into the DOM without error', () => {
    const { manager, root } = setup();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      new Proxy({}, { get: () => () => {}, set: () => true }) as unknown as RenderingContext,
    );
    const types = [
      'craft',
      'chest',
      'station',
      'team',
      'skills',
      'death',
      'map',
      'options',
    ] as const;

    for (const type of types) {
      manager.open(type);
      expect(() => manager.update()).not.toThrow();
      expect(root.querySelector('.dv-window-body')!.children.length).toBeGreaterThan(0);
    }
  });

  it('opens the map on M as a window that closes any other, and the options window routes toolbar actions', () => {
    const { manager, root, onControlAction } = setup();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      new Proxy({}, { get: () => () => {}, set: () => true }) as unknown as RenderingContext,
    );
    manager.open('craft');
    manager.update();
    manager.toggle('map');
    manager.update();
    expect(manager.activeWindow).toBe('map');
    expect(root.querySelector('.dv-window-title')!.textContent).toBe('Map');
    expect(root.querySelector('canvas.dv-map-canvas')).not.toBeNull();
    manager.toggle('map');
    expect(manager.activeWindow).toBe('none');

    manager.toggle('options');
    manager.update();
    expect(root.querySelector('.dv-window-title')!.textContent).toBe('Options');
    const sound = Array.from(root.querySelectorAll<HTMLElement>('.dv-settings-row')).find(
      (r) => r.querySelector('.dv-settings-label')!.textContent === 'Sound',
    )!;
    sound.querySelectorAll<HTMLButtonElement>('.dv-btn')[1].click();
    expect(onControlAction).toHaveBeenCalledWith('toggle_audio');
  });

  it('keeps the crafting title on the skills entry (skills are the craft window tabs)', () => {
    const { manager, root } = setup();
    manager.open('skills');
    manager.update();
    expect(root.querySelector('.is-skill.is-active')!.textContent).toContain('Survival');
    expect(root.querySelector('.dv-window-title')!.textContent).toBe('Crafting');
  });

  it('drops the size class of a closed window so the next one is not sized by it', () => {
    const { manager, root } = setup();
    const panel = root.querySelector('.dv-modal')!;
    manager.open('options');
    manager.update();
    expect(panel.classList.contains('dv-modal-options')).toBe(true);
    manager.close();
    manager.update();
    expect(panel.classList.contains('dv-modal-options')).toBe(false);
    manager.open('craft');
    manager.update();
    expect(Array.from(panel.classList).filter((c) => c.startsWith('dv-modal-'))).toEqual([
      'dv-modal-craft',
    ]);
  });

  it('hides a hover card over a chest slot when the window closes under the pointer', () => {
    const { manager, root, inventory } = setup();
    inventory.isChestOpen = true;
    inventory.chestCapacity = 4;
    inventory.chestItems = [{ iid: 20, count: 2, ammo: 0, mods: [] }];
    manager.update();
    const slot = root.querySelector<HTMLElement>('.dv-chest-grid .dv-item-slot')!;
    slot.dispatchEvent(new Event('pointerenter'));
    const card = document.querySelector<HTMLElement>('.dv-hover-card')!;
    expect(card.hidden).toBe(false);

    manager.close();
    manager.update();
    expect(manager.activeWindow).toBe('none');
    expect(card.hidden).toBe(true);
  });

  it('hides a hover card when another window replaces the one it was over', () => {
    const { manager, root, inventory } = setup();
    inventory.isChestOpen = true;
    inventory.chestCapacity = 4;
    inventory.chestItems = [{ iid: 20, count: 2, ammo: 0, mods: [] }];
    manager.update();
    root
      .querySelector<HTMLElement>('.dv-chest-grid .dv-item-slot')!
      .dispatchEvent(new Event('pointerenter'));
    expect(hoverCard().el.hidden).toBe(false);

    inventory.closeContainers();
    manager.open('options');
    manager.update();
    expect(manager.activeWindow).toBe('options');
    expect(hoverCard().el.hidden).toBe(true);
  });

  it('opens the Mods window on a carried gun and closes it when the gun is gone', () => {
    const { manager, inventory } = setup();
    inventory.setAllSlots([{ uid: 7, iid: 172, count: 1, ammo: 0 }]);
    manager.openMods(7);
    manager.update();
    expect(manager.activeWindow).toBe('mods');
    inventory.applySlot(7, 0, 0, 0);
    manager.update();
    expect(manager.activeWindow).toBe('none');
  });
});
