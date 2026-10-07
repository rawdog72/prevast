// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ContentTable } from '../../../../shared/typescript/content-format';
import { ContentStore } from '../content/store';
import { Camera } from '../core/camera';
import { KeyboardTracker } from '../core/keyboard';
import { MouseTracker } from '../core/mouse';
import { NetEventBus } from '../net/events';
import { MouseDirection, MoveMask } from '../net/opcodes';
import { GameSocket } from '../net/socket';
import { EntityType } from '../world/entity-types';
import { InventoryStore } from '../world/inventory-store';
import { WorldState } from '../world/world-state';
import { InputManager } from './input-manager';

describe('InputManager', () => {
  function setup() {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const keyboard = new KeyboardTracker({ target: window });
    const mouse = new MouseTracker({ target: el });
    const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });
    const world = new WorldState();
    const inventory = new InventoryStore();
    const bus = new NetEventBus();

    const socket = new GameSocket({
      url: 'ws://127.0.0.1:7172',
      login: { nickname: 'Tester', password: '' },
      bus,
    });

    vi.spyOn(socket, 'move').mockImplementation(() => {});
    vi.spyOn(socket, 'rotation').mockImplementation(() => {});
    vi.spyOn(socket, 'mouseDirection').mockImplementation(() => {});
    vi.spyOn(socket, 'mouseDown').mockImplementation(() => {});
    vi.spyOn(socket, 'mouseUp').mockImplementation(() => {});
    vi.spyOn(socket, 'shift').mockImplementation(() => {});
    vi.spyOn(socket, 'equipItem').mockImplementation(() => {});
    vi.spyOn(socket, 'takeLoot').mockImplementation(() => {});
    vi.spyOn(socket, 'interact').mockImplementation(() => {});
    vi.spyOn(socket, 'reload').mockImplementation(() => {});

    // Create a local player entity in world
    world.ownGuid = 1;
    world.entities.processUnits([
      {
        pid: 1,
        id: 0,
        type: EntityType.PLAYER,
        rotation: 0,
        state: 1,
        startX: 500,
        startY: 500,
        endX: 500,
        endY: 500,
        extra: 0,
      },
    ]);

    return { keyboard, mouse, camera, world, inventory, socket, el };
  }

  it('samples movement and sends move packet when mask changes', () => {
    const ctx = setup();
    const manager = new InputManager(ctx);

    // Initial update - no keys pressed
    manager.update(16);
    expect(ctx.socket.move).toHaveBeenCalledWith(MoveMask.NONE);

    // Press W (Up)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    manager.update(16);
    expect(ctx.socket.move).toHaveBeenCalledWith(MoveMask.UP);

    // Press Shift
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
    manager.update(16);
    expect(ctx.socket.shift).toHaveBeenCalledWith(true);

    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('lets a trade consume inventory selection while keeping the explicit drop action', () => {
    const ctx = setup();
    const onSelectSlot = vi.fn(() => true);
    const manager = new InputManager({ ...ctx, delegates: { onSelectSlot } });
    ctx.inventory.slots[0] = { iid: 2, uid: 7, count: 10, ammo: 0 };
    const drop = vi.spyOn(ctx.socket, 'throwItem').mockImplementation(() => {});
    manager.selectSlot(0);
    expect(onSelectSlot).toHaveBeenCalledWith(0);
    expect(ctx.socket.equipItem).not.toHaveBeenCalled();
    manager.selectSlot(0, { alt: true });
    expect(drop).toHaveBeenCalledWith(2, 7, 10, 0);
    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('computes rotation angle and mouse direction relative to local player', () => {
    const ctx = setup();
    const manager = new InputManager(ctx);

    // Move cursor to (600, 500) -> 100 units right of player (500, 500)
    ctx.el.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 400 })); // Camera at (0,0), half-viewport is (400,300), so world pos is (500, 500) + (100, 0) = (600, 500)
    ctx.camera.x = 500;
    ctx.camera.y = 500;

    manager.update(16);
    expect(ctx.socket.rotation).toHaveBeenCalled();
    expect(ctx.socket.mouseDirection).toHaveBeenCalledWith(MouseDirection.RIGHT);

    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('ignores atan2 jitter and holds the last angle when the cursor is on top of the player', () => {
    const ctx = setup();
    const manager = new InputManager(ctx);
    ctx.camera.x = 500;
    ctx.camera.y = 500;

    // Cursor 100 units right of the player (500,500) -> facing angle 0 (well outside the deadzone).
    ctx.el.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 300 }));
    manager.update(16);
    expect(ctx.world.localPlayerAngle).toBeCloseTo(0, 5);

    // Cursor only 5 units above the player -> inside the deadzone. A raw atan2 here
    // would swing the angle to -PI/2; it should instead hold the previous angle.
    ctx.el.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 295 }));
    manager.update(16);
    expect(ctx.world.localPlayerAngle).toBeCloseTo(0, 5);

    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('holds the facing angle until the mouse has actually moved over the canvas', () => {
    const ctx = setup();
    const manager = new InputManager(ctx);
    ctx.camera.x = 500;
    ctx.camera.y = 500;
    ctx.world.localPlayerAngle = 1;

    // No mousemove yet: the tracker's (0,0) default is not a real cursor
    // position, so the sprite must not swing toward the top-left corner.
    manager.update(16);
    expect(ctx.world.localPlayerAngle).toBe(1);
    expect(ctx.socket.rotation).not.toHaveBeenCalled();

    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('keeps the aim deadzone a constant screen size across zoom levels', () => {
    const ctx = setup();
    const manager = new InputManager(ctx);
    ctx.camera.x = 500;
    ctx.camera.y = 500;
    ctx.camera.zoom = 4;

    // 10 world units right of the player is 40 screen px at 4x zoom -> outside the deadzone.
    ctx.el.dispatchEvent(new MouseEvent('mousemove', { clientX: 440, clientY: 300 }));
    manager.update(16);
    expect(ctx.world.localPlayerAngle).toBeCloseTo(0, 5);

    // Only 1 world unit above the player is 4 screen px at 4x zoom -> inside the deadzone.
    // A world-unit-only deadzone (the old, zoom-blind version) would have let this through
    // and swung the angle to -PI/2.
    ctx.el.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 296 }));
    manager.update(16);
    expect(ctx.world.localPlayerAngle).toBeCloseTo(0, 5);

    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('keeps moving, sprinting, aiming and using hotkeys with a window open; only clicks are swallowed', () => {
    // Old client: menuHandled only gated World.PLAYER.click. Keyboard.keydown ran
    // regardless, and processKeyboard handled E / R / 1-9 / C with a box open.
    const ctx = setup();
    const toggled: string[] = [];
    let outsideClicks = 0;
    const manager = new InputManager({
      ...ctx,
      delegates: {
        isModalOpen: () => true,
        onToggleWindow: (name) => toggled.push(name),
        onOutsideClick: () => outsideClicks++,
      },
    });
    ctx.inventory.setSlot(0, { iid: 7, count: 1, ammo: 0 });
    ctx.camera.x = 500;
    ctx.camera.y = 500;

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
    ctx.el.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 400 }));
    manager.update(16);
    expect(ctx.socket.move).toHaveBeenCalledWith(MoveMask.UP);
    expect(ctx.socket.shift).toHaveBeenCalledWith(true);
    expect(ctx.socket.rotation).toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
    expect(ctx.socket.equipItem).toHaveBeenCalledWith(7, 0, 1, 0);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC' }));
    expect(toggled).toEqual(['craft']);

    // A click on the game with a window up is the "click outside" that closes it.
    ctx.el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 500, clientY: 400 }));
    manager.update(16);
    expect(ctx.socket.mouseDown).not.toHaveBeenCalled();
    expect(outsideClicks).toBe(1);
    manager.update(16);
    expect(outsideClicks).toBe(1); // once per press, not per frame

    // A click over and done with between two frames still counts.
    ctx.el.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 500, clientY: 400 }));
    manager.update(16);
    ctx.el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 500, clientY: 400 }));
    ctx.el.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 500, clientY: 400 }));
    manager.update(16);
    expect(outsideClicks).toBe(2);
    expect(ctx.socket.mouseDown).not.toHaveBeenCalled();

    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('gives a press taken to pick a trade partner neither an attack nor a release', () => {
    const ctx = setup();
    let picking = true;
    const manager = new InputManager({
      ...ctx,
      delegates: { onPickTarget: () => (picking ? ((picking = false), true) : false) },
    });
    ctx.el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 500, clientY: 400 }));
    manager.update(16);
    ctx.el.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: 500, clientY: 400 }));
    manager.update(16);
    expect(ctx.socket.mouseDown).not.toHaveBeenCalled();
    expect(ctx.socket.mouseUp).not.toHaveBeenCalled();

    // The next press is the game's again.
    ctx.el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 500, clientY: 400 }));
    manager.update(16);
    expect(ctx.socket.mouseDown).toHaveBeenCalledOnce();

    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('keeps aiming while the pointer is over the HUD or dragging an item (mousemove is window-wide)', () => {
    // Old client: Mouse listened on window. With the canvas as the only
    // source, dragging a hotbar item (pointer over the HUD, captured by the
    // slot) froze the facing angle -- and you throw where you face.
    const ctx = setup();
    const manager = new InputManager(ctx);
    ctx.camera.x = 500;
    ctx.camera.y = 500;
    ctx.el.dispatchEvent(new MouseEvent('mousemove', { clientX: 600, clientY: 300 }));
    manager.update(16);
    const first = (ctx.socket.rotation as unknown as { mock: { calls: number[][] } }).mock.calls
      .length;
    // The next move never touches the canvas: it happens over a HUD element.
    const hud = document.createElement('div');
    document.body.appendChild(hud);
    hud.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 300 }));
    manager.update(16);
    expect(ctx.mouse.screenX).toBe(200);
    const calls = (ctx.socket.rotation as unknown as { mock: { calls: number[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(first);
    expect(calls[calls.length - 1]![0]).toBe(180); // cursor left of the player
    hud.remove();
    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('still stops the player while typing in chat', () => {
    const ctx = setup();
    const manager = new InputManager(ctx);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    manager.update(16);
    expect(ctx.socket.move).toHaveBeenLastCalledWith(MoveMask.UP);
    ctx.keyboard.setTextInputMode(true);
    manager.update(16);
    expect(ctx.socket.move).toHaveBeenLastCalledWith(MoveMask.NONE);
    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('selects hotbar item and emits equipItem', () => {
    const ctx = setup();
    const manager = new InputManager(ctx);

    ctx.inventory.setSlot(0, { iid: 7, count: 1, ammo: 0 });

    // Press '1'
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));

    expect(ctx.inventory.activeSlot).toBe(0);
    expect(ctx.socket.equipItem).toHaveBeenCalledWith(7, 0, 1, 0);

    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  function contentWithObjects(): ContentStore {
    const content = new ContentStore();
    for (const name of ['items', 'objects', 'furnitures']) {
      content.load(
        JSON.parse(readFileSync(`tests/fixtures/content/${name}.json`, 'utf8')) as ContentTable,
      );
    }
    return content;
  }

  function building(
    content: ContentStore,
    key: string,
    id: number,
    x: number,
    y: number,
    state = 1,
  ) {
    const item = content.byKey('items', key) as { id: number };
    return {
      pid: 0,
      id,
      type: EntityType.BUILD_DOWN,
      rotation: 0,
      state,
      startX: x,
      startY: y,
      endX: x,
      endY: y,
      extra: item.id << 7,
    };
  }

  it('lists the usable stations in reach, nearest per area, for the craft window tabs', () => {
    const ctx = setup();
    const content = contentWithObjects();
    const manager = new InputManager({ ...ctx, content });
    ctx.world.entities.processUnits([
      building(content, 'workbench', 20, 590, 500), // 90 away
      building(content, 'workbench', 21, 500, 580), // 80 away: the nearer workbench
      building(content, 'campfire', 22, 560, 560), // ~85 away, another area
      building(content, 'campfire', 23, 500, 500, 1 | 16), // in use by someone: not offered
      building(content, 'wood_chest', 24, 500, 420), // a chest is not a station
      building(content, 'workbench', 25, 500, 620), // out of reach
    ]);
    manager.update(16);
    expect(manager.stationsInReach.map((s) => `${s.areaId}:${s.entity.id}`)).toEqual([
      '1:22',
      '2:21',
    ]);
    manager.destroy();
    ctx.keyboard.destroy();
  });

  it('targets only interactable buildings within reach, with their content interact icon', () => {
    const ctx = setup();
    const content = contentWithObjects();
    const manager = new InputManager({ ...ctx, content });

    ctx.world.entities.processUnits([
      building(content, 'wood_wall', 10, 560, 500), // not interactable
      building(content, 'wood_chest', 11, 600, 500), // 100 away: in reach
      building(content, 'workbench', 12, 500, 620), // 120 away: out of the old ~110 reach
    ]);
    manager.update(16);

    expect(manager.currentTarget?.kind).toBe('object');
    expect(manager.currentTarget?.entity.id).toBe(11);
    expect(manager.currentTarget?.icon).toBe('e-chest');

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' }));
    expect(ctx.socket.interact).toHaveBeenCalledWith(expect.any(Number), 11, 0);

    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('shows the close icon for an open door', () => {
    const ctx = setup();
    const content = contentWithObjects();
    const manager = new InputManager({ ...ctx, content });
    ctx.world.entities.processUnits([building(content, 'wood_door', 20, 600, 500, 1 | 16)]);
    manager.update(16);
    expect(manager.currentTarget?.icon).toBe('e-closedoor');
    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('puts loot on the F key when an interactable building is also in reach', () => {
    const ctx = setup();
    const content = contentWithObjects();
    const manager = new InputManager({ ...ctx, content });
    ctx.world.entities.processUnits([
      building(content, 'wood_chest', 11, 600, 500),
      {
        pid: 0,
        id: 99,
        type: EntityType.LOOT,
        rotation: 0,
        state: 1,
        startX: 520,
        startY: 500,
        endX: 520,
        endY: 500,
        extra: 0,
      },
    ]);
    manager.update(16);

    expect(manager.currentTarget?.kind).toBe('object');
    expect(manager.lootTarget?.entity.id).toBe(99);

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF' }));
    expect(ctx.socket.takeLoot).toHaveBeenCalledWith(99);

    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('ignores loot beyond the old client reach (~110 units), well inside the server 200 per axis', () => {
    const ctx = setup();
    const manager = new InputManager(ctx);
    ctx.world.entities.processUnits([
      {
        pid: 0,
        id: 98,
        type: EntityType.LOOT,
        rotation: 0,
        state: 1,
        startX: 620,
        startY: 500,
        endX: 620,
        endY: 500,
        extra: 0,
      },
    ]);
    manager.update(16);
    expect(manager.currentTarget).toBeNull();
    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('detects nearby loot and interacts on E key', () => {
    const ctx = setup();
    const manager = new InputManager(ctx);

    // Spawn loot at (520, 500) -> 20 units away from player (500, 500)
    ctx.world.entities.processUnits([
      {
        pid: 0,
        id: 99,
        type: EntityType.LOOT,
        rotation: 0,
        state: 1,
        startX: 520,
        startY: 500,
        endX: 520,
        endY: 500,
        extra: 0,
      },
    ]);

    manager.update(16);
    expect(manager.currentTarget?.kind).toBe('loot');
    expect(manager.currentTarget?.entity.id).toBe(99);

    // Press E to interact
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' }));
    expect(ctx.socket.takeLoot).toHaveBeenCalledWith(99);

    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('offers E on lootable furniture (storage, no interaction rule) with the old furniture badge', () => {
    const ctx = setup();
    const content = contentWithObjects();
    const manager = new InputManager({ ...ctx, content });
    // furniture0 is item "furniture" subtype 12: a cupboard with contents.
    const furniture = content.byKey('items', 'furniture') as { id: number };
    ctx.world.entities.processUnits([
      {
        pid: 0,
        id: 30,
        type: EntityType.BUILD_DOWN,
        rotation: 0,
        state: 1 | (12 << 5),
        startX: 600,
        startY: 500,
        endX: 600,
        endY: 500,
        extra: furniture.id << 7,
      },
    ]);
    manager.update(16);
    expect(manager.currentTarget?.kind).toBe('object');
    expect(manager.currentTarget?.icon).toBe('e-furniture');

    // A decorative piece (no storage) is not usable.
    const decor = Object.entries(content.table('furnitures')).find(
      ([, f]) => !(f as { storage?: unknown }).storage,
    )!;
    const subtype = (decor[1] as { subtype: number }).subtype;
    ctx.world.entities.processUnits([
      {
        pid: 0,
        id: 30,
        type: EntityType.BUILD_DOWN,
        rotation: 0,
        state: 1 | (subtype << 5),
        startX: 600,
        startY: 500,
        endX: 600,
        endY: 500,
        extra: furniture.id << 7,
      },
    ]);
    manager.update(16);
    expect(manager.currentTarget).toBeNull();
    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('drops the badge on a chest or station someone has open (state bit 4), never on a door', () => {
    const ctx = setup();
    const content = contentWithObjects();
    const manager = new InputManager({ ...ctx, content });
    ctx.world.entities.processUnits([building(content, 'wood_chest', 11, 600, 500, 1 | 16)]);
    manager.update(16);
    expect(manager.currentTarget).toBeNull();
    ctx.world.entities.processUnits([building(content, 'workbench', 11, 600, 500, 1 | 16)]);
    manager.update(16);
    expect(manager.currentTarget).toBeNull();
    ctx.world.entities.processUnits([building(content, 'wood_door', 11, 600, 500, 1 | 16)]);
    manager.update(16);
    expect(manager.currentTarget?.icon).toBe('e-closedoor');
    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('never offers loot that is flying to a player or still gliding to where it lands', () => {
    const ctx = setup();
    const manager = new InputManager(ctx);
    const loot = (id: number, state: number, startX: number, endX: number) => ({
      pid: 0,
      id,
      type: EntityType.LOOT,
      rotation: 0,
      state,
      startX,
      startY: 500,
      endX,
      endY: 500,
      extra: 0,
    });
    // Harvested: the server names us (pid 1) as the taker in the high byte.
    ctx.world.entities.processUnits([loot(99, (1 << 8) | 1, 540, 540)]);
    manager.update(16);
    expect(manager.currentTarget).toBeNull();

    // Just dropped 80 units away from its landing spot: no badge until it lands.
    ctx.world.entities.processUnits([loot(99, 0, 540, 540), loot(98, 1, 460, 540)]);
    manager.update(16);
    expect(manager.currentTarget).toBeNull();
    for (let i = 0; i < 40; i++) {
      ctx.world.entities.update(16);
      manager.update(16);
    }
    expect(manager.currentTarget?.entity.id).toBe(98);
    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('releaseAll tells the server at once that movement, sprint and the button were let go', () => {
    const ctx = setup();
    const manager = new InputManager(ctx);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
    ctx.el.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    manager.update(16);
    expect(ctx.socket.move).toHaveBeenLastCalledWith(MoveMask.UP);
    expect(ctx.socket.shift).toHaveBeenLastCalledWith(true);
    expect(ctx.socket.mouseDown).toHaveBeenCalledTimes(1);

    manager.releaseAll();
    expect(ctx.socket.move).toHaveBeenLastCalledWith(MoveMask.NONE);
    expect(ctx.socket.shift).toHaveBeenLastCalledWith(false);
    expect(ctx.socket.mouseUp).toHaveBeenCalledTimes(1);
    expect(ctx.keyboard.getMoveMask()).toBe(MoveMask.NONE);
    expect(ctx.mouse.isLeftDown).toBe(false);

    // Back on the page with nothing held: no second press, no repeat release.
    manager.update(16);
    expect(ctx.socket.mouseDown).toHaveBeenCalledTimes(1);
    expect(ctx.socket.mouseUp).toHaveBeenCalledTimes(1);

    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });

  it('releaseAll sends nothing when nothing was held', () => {
    const ctx = setup();
    const manager = new InputManager(ctx);
    manager.releaseAll();
    expect(ctx.socket.move).not.toHaveBeenCalled();
    expect(ctx.socket.shift).not.toHaveBeenCalled();
    expect(ctx.socket.mouseUp).not.toHaveBeenCalled();
    manager.destroy();
    ctx.keyboard.destroy();
    ctx.mouse.destroy();
  });
});
