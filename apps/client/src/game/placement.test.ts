// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { AssetLoader } from '../assets/asset-loader';
import { ContentStore } from '../content/store';
import { Camera } from '../core/camera';
import { MouseTracker } from '../core/mouse';
import { NetEventBus } from '../net/events';
import { GameSocket } from '../net/socket';
import { EntityType } from '../world/entity-types';
import { InventoryStore } from '../world/inventory-store';
import { WorldState } from '../world/world-state';
import { PlacementEngine } from './placement';

const WALL = 50;
const FLOOR = 51;
const CHEST = 52;
const SMELTER = 53;
const SEED = 54;
const DOOR = 55;

function item(key: string, id: number, name: string) {
  return {
    key,
    id,
    clientItemId: id,
    name,
    properties: { stack: 255 },
    equipable: { key: 'place_object', equipTimeMs: 1000 },
  };
}

function loadContent(): ContentStore {
  const content = new ContentStore();
  content.load({
    name: 'items',
    version: 1,
    hash: 'h1',
    attributes: {},
    entries: {
      wood_wall: item('wood_wall', WALL, 'Wood Wall'),
      wood_floor: item('wood_floor', FLOOR, 'Wood Floor'),
      wood_chest: item('wood_chest', CHEST, 'Chest'),
      smelter: item('smelter', SMELTER, 'Smelter'),
      tomato_seed: item('tomato_seed', SEED, 'Tomato Seed'),
      wood_door: item('wood_door', DOOR, 'Wood Door'),
    },
  });
  content.load({
    name: 'equipables',
    version: 1,
    hash: 'h3',
    attributes: {},
    entries: {
      place_object: { key: 'place_object', id: 21, idWeapon: 21, typeId: 6 },
      hatchet: { key: 'hatchet', id: 3, idWeapon: 3, typeId: 1 },
    },
  });
  content.load({
    name: 'objects',
    version: 1,
    hash: 'h2',
    attributes: {},
    entries: {
      wood_wall: {
        key: 'wood_wall',
        category: 'wall',
        healthMax: 500,
        layer: 'mid',
        client: {
          render: 'wall',
          blueprint: 'day-clear-blue-wood-wall',
          redprint: 'day-redprint-wood-wall',
        },
      },
      wood_floor: {
        key: 'wood_floor',
        category: 'floor',
        healthMax: 100,
        layer: 'ground',
        client: {
          render: 'groundFloor',
          blueprint: 'day-clear-blue-wood-floor',
          redprint: 'day-redprint-wood-floor',
        },
      },
      wood_chest: {
        key: 'wood_chest',
        category: 'container',
        healthMax: 300,
        layer: 'mid',
        client: {
          render: 'workbench',
          blueprint: 'day-clear-blue-chest',
          redprint: 'day-redprint-chest',
        },
      },
      smelter: {
        key: 'smelter',
        category: 'station',
        healthMax: 800,
        layer: 'mid',
        client: {
          render: 'smelter',
          blueprint: 'day-clear-blue-smelter',
          redprint: 'day-redprint-smelter',
          offset: [
            { rotation: 0, y: -80, tileI: -1 },
            { rotation: 1, x: -80, tileJ: -1 },
            { rotation: 2, y: -80, tileI: -1 },
            { rotation: 3, x: -80, tileJ: -1 },
          ],
        },
      },
      tomato_seed: {
        key: 'tomato_seed',
        category: 'plant',
        healthMax: 50,
        layer: 'mid',
        client: {
          render: 'orangeSeed',
          blueprint: 'day-clear-blue-tomato',
          redprint: 'day-redprint-tomato',
        },
      },
      wood_door: {
        key: 'wood_door',
        category: 'wall',
        healthMax: 400,
        layer: 'mid',
        client: {
          render: 'door',
          blueprint: 'day-clear-blue-wood-door',
          redprint: 'day-redprint-wood-door',
          offset: [
            { rotation: 0, cy: 30, y: 65 },
            { rotation: 1, cx: -30 },
            { rotation: 2, cy: -30 },
            { rotation: 3, cx: 30, x: 65 },
          ],
        },
      },
    },
  });
  return content;
}

function unit(pid: number, id: number, type: number, x: number, y: number, extra = 0, state = 1) {
  return { pid, id, type, rotation: 0, state, startX: x, startY: y, endX: x, endY: y, extra };
}

describe('PlacementEngine (old client placingobj)', () => {
  function setup() {
    const el = document.createElement('div');
    const mouse = new MouseTracker({ target: el });
    const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });
    const world = new WorldState();
    world.tilesX = 20;
    world.tilesY = 20;
    const inventory = new InventoryStore();
    const content = loadContent();
    const bus = new NetEventBus();
    const socket = new GameSocket({
      url: 'ws://127.0.0.1:7172',
      login: { nickname: 'Tester', password: '' },
      bus,
    });
    vi.spyOn(socket, 'placeObject').mockImplementation(() => {});

    // Our player in the middle of tile (row 5, column 5).
    world.ownGuid = 1;
    world.entities.processUnits([unit(1, 0, EntityType.PLAYER, 550, 550)]);
    const engine = new PlacementEngine({ world, inventory, content, socket, mouse, camera });
    // "Holding" a piece the way the server states it once the equip countdown
    // ends: the entity's weapon (extra >> 8) is place_object and BLUEPRINT names the item.
    const hold = (iid: number) => {
      inventory.setSlot(0, { iid, count: 5 });
      world.getLocalEntity()!.extra = 21 << 8;
      inventory.blueprintIid = iid;
    };
    const aim = (rad: number) => {
      world.localPlayerAngle = rad;
    };
    return { engine, inventory, socket, mouse, camera, world, content, hold, aim };
  }

  it('is placing only once the server confirms the blueprint, not on the click that starts the equip', () => {
    const t = setup();
    expect(t.engine.isPlacing()).toBe(false);
    // The click: the slot is active locally, the server is still counting down.
    t.inventory.setSlot(0, { iid: WALL, count: 5 });
    expect(t.engine.isPlacing()).toBe(false);
    expect(t.engine.getActivePlaceable()).toBeNull();
    // The countdown ends: BLUEPRINT + the weapon on the entity.
    t.inventory.blueprintIid = WALL;
    t.world.getLocalEntity()!.extra = 21 << 8;
    expect(t.engine.isPlacing()).toBe(true);
    expect(t.engine.getActivePlaceable()?.blueprint).toBe('day-clear-blue-wood-wall');
  });

  it('drops the ghost when the server toggles the blueprint off, whatever the local slot says', () => {
    const t = setup();
    t.hold(WALL);
    expect(t.engine.isPlacing()).toBe(true);
    // Re-clicking the equipped slot: the server unequips (BLUEPRINT 0, hand on the entity).
    t.inventory.blueprintIid = 0;
    t.world.getLocalEntity()!.extra = 0;
    expect(t.engine.isPlacing()).toBe(false);
    expect(t.engine.target()).toBeNull();
    // A hatchet equipped over it is not building either.
    t.inventory.blueprintIid = WALL;
    t.world.getLocalEntity()!.extra = 3 << 8;
    expect(t.engine.isPlacing()).toBe(false);
  });

  it('fades the craft grid in under our tile while building, moves it with us, and out afterwards', () => {
    const t = setup();
    t.engine.update(100, false);
    expect(t.engine.gridCells()).toEqual([]);
    t.hold(WALL);
    t.engine.update(250, false);
    expect(t.engine.gridCells()).toEqual([{ i: 5, j: 5, alpha: 0.5 }]);
    t.engine.update(1000, false);
    expect(t.engine.gridCells()).toEqual([{ i: 5, j: 5, alpha: 1 }]);
    // Step onto the next tile: the old cell fades out while the new one fades in.
    t.world.getLocalEntity()!.x = 650;
    t.engine.update(250, false);
    expect(t.engine.gridCells()).toEqual([
      { i: 5, j: 6, alpha: 0.5 },
      { i: 5, j: 5, alpha: 0.5 },
    ]);
    // Blueprint off: everything drains.
    t.inventory.blueprintIid = 0;
    t.world.getLocalEntity()!.extra = 0;
    t.engine.update(125, false);
    expect(t.engine.gridCells()).toEqual([
      { i: 5, j: 6, alpha: 0.25 },
      { i: 5, j: 5, alpha: 0.25 },
    ]);
    t.engine.update(1000, false);
    expect(t.engine.gridCells()).toEqual([]);
  });

  it('draws the craft grid centred on each cell at its alpha', () => {
    const t = setup();
    t.hold(WALL);
    t.engine.update(500, false);
    const drawn: { name: string; x: number; y: number; w: number; h: number; alpha: number }[] = [];
    let alpha = 1;
    const ctx = {
      drawImage: (img: { name: string }, x: number, y: number, w: number, h: number) =>
        drawn.push({ name: img.name, x, y, w, h, alpha }),
      set globalAlpha(v: number) {
        alpha = v;
      },
      get globalAlpha() {
        return alpha;
      },
    } as unknown as CanvasRenderingContext2D;
    const assets = {
      get: (name: string) => ({ name, naturalWidth: 802, naturalHeight: 900, image: { name } }),
    } as unknown as AssetLoader;
    t.engine.renderGrid(ctx, assets);
    expect(drawn).toEqual([
      { name: 'craft-grid', x: 550 - 200.5, y: 550 - 225, w: 401, h: 450, alpha: 1 },
    ]);
    expect(alpha).toBe(1);
  });

  it('targets the neighbouring tile in the aim direction, never the tile under the cursor', () => {
    const t = setup();
    t.hold(WALL);
    // The cursor is far away: it only sets the angle (old jBuild = _j + floor((50 + cos*100) / 100)).
    t.mouse.screenX = 800;
    t.mouse.screenY = 600;
    const at = (rad: number) => {
      t.aim(rad);
      const g = t.engine.target()!;
      return [g.i, g.j];
    };
    expect(at(0)).toEqual([5, 6]);
    expect(at(Math.PI / 2)).toEqual([6, 5]);
    expect(at(Math.PI)).toEqual([5, 4]);
    expect(at(-Math.PI / 2)).toEqual([4, 5]);
    expect(at(Math.PI / 4)).toEqual([6, 6]);
    expect(at((-3 * Math.PI) / 4)).toEqual([4, 4]);
  });

  it('never rotates walls or floors; other pieces follow R', () => {
    const t = setup();
    t.hold(WALL);
    t.engine.rotate();
    expect(t.engine.target()!.rotation).toBe(0);
    expect(t.engine.getActivePlaceable()!.rotatable).toBe(false);
    t.hold(FLOOR);
    expect(t.engine.target()!.rotation).toBe(0);
    t.hold(CHEST);
    expect(t.engine.getActivePlaceable()!.rotatable).toBe(true);
    expect(t.engine.target()!.rotation).toBe(1);
  });

  it('draws the ghost at the tile centre plus the piece cx/cy offset for its rotation', () => {
    const t = setup();
    t.hold(DOOR);
    t.aim(0); // tile (5, 6): centre (650, 550)
    expect(t.engine.target()).toMatchObject({ x: 650, y: 580, rotation: 0 });
    t.engine.rotate();
    expect(t.engine.target()).toMatchObject({ x: 620, y: 550, rotation: 1 });
  });

  it('place() sends [rotation][row][column] for the target tile, only while it is buildable', () => {
    const t = setup();
    t.hold(CHEST);
    t.aim(Math.PI / 2); // row 6, column 5
    t.engine.rotate();
    expect(t.engine.place()).toBe(true);
    expect(t.socket.placeObject).toHaveBeenCalledWith(1, 6, 5);
    // Something already there: nothing goes out.
    t.world.entities.processUnits([unit(0, 9, EntityType.BUILD_TOP, 550, 650, WALL << 7)]);
    expect(t.engine.place()).toBe(false);
    expect(t.socket.placeObject).toHaveBeenCalledTimes(1);
  });

  it('is red on a tile holding a non-floor building or a resource, blue on a bare floor', () => {
    const t = setup();
    t.hold(WALL);
    t.aim(0); // tile (5, 6) at (650, 550)
    expect(t.engine.target()!.canBuild).toBe(true);
    t.world.entities.processUnits([unit(0, 9, EntityType.BUILD_GROUND, 650, 550, FLOOR << 7)]);
    expect(t.engine.target()!.canBuild).toBe(true);
    t.world.entities.processUnits([unit(0, 10, EntityType.BUILD_TOP, 650, 550, CHEST << 7)]);
    expect(t.engine.target()!.canBuild).toBe(false);
    t.world.entities.processUnits([unit(0, 10, EntityType.BUILD_TOP, 650, 550, 0, 0)]);
    expect(t.engine.target()!.canBuild).toBe(true);
    t.world.entities.processUnits([unit(0, 11, EntityType.RES_TOP, 650, 550, 3)]);
    expect(t.engine.target()!.canBuild).toBe(false);
  });

  it('is red for a floor or a plant going onto a floor', () => {
    const t = setup();
    t.aim(0);
    t.world.entities.processUnits([unit(0, 9, EntityType.BUILD_GROUND, 650, 550, FLOOR << 7)]);
    t.hold(FLOOR);
    expect(t.engine.target()!.canBuild).toBe(false);
    t.hold(SEED);
    expect(t.engine.target()!.canBuild).toBe(false);
    t.hold(CHEST);
    expect(t.engine.target()!.canBuild).toBe(true);
  });

  it('is red when a player (us included, as the server counts it), a creature or a pickup is within 60 units of the tile centre', () => {
    const t = setup();
    t.hold(WALL);
    t.aim(0);
    t.world.entities.processUnits([unit(2, 0, EntityType.PLAYER, 640, 560)]);
    expect(t.engine.target()!.canBuild).toBe(false);
    t.world.entities.processUnits([unit(2, 0, EntityType.PLAYER, 1500, 1500)]);
    expect(t.engine.target()!.canBuild).toBe(true);
    // Standing on the edge of our tile, 55 units from the next tile's centre.
    t.world.getLocalEntity()!.x = 595;
    expect(t.engine.target()!.canBuild).toBe(false);
    t.world.getLocalEntity()!.x = 550;
    expect(t.engine.target()!.canBuild).toBe(true);
    t.world.entities.processUnits([unit(0, 20, EntityType.AI, 660, 540)]);
    expect(t.engine.target()!.canBuild).toBe(false);
    t.world.entities.processUnits([unit(0, 20, EntityType.AI, 660, 540, 0, 0)]);
    t.world.entities.processUnits([unit(0, 21, EntityType.LOOT, 650, 550)]);
    expect(t.engine.target()!.canBuild).toBe(false);
  });

  it('checks every tile of a two-tile footprint, including the map edge', () => {
    const t = setup();
    t.hold(SMELTER);
    t.aim(0); // (5, 6); rotation 0 also covers tileI -1 -> (4, 6)
    expect(t.engine.target()!.canBuild).toBe(true);
    t.world.entities.processUnits([unit(0, 9, EntityType.BUILD_TOP, 650, 450, WALL << 7)]);
    expect(t.engine.target()!.canBuild).toBe(false);
    // Rotated, the second tile is (5, 5) -- where we stand.
    t.engine.rotate();
    expect(t.engine.target()!.canBuild).toBe(false);
    // Against the top edge the far tile hangs off the map.
    t.world.entities.processUnits([unit(1, 0, EntityType.PLAYER, 550, 50, 21 << 8)]);
    t.engine.rotate();
    t.engine.rotate();
    expect(t.engine.target()!.canBuild).toBe(false);
  });

  it('fades the rotate hint in after 600ms holding a rotatable piece, never for a wall', () => {
    const t = setup();
    t.hold(CHEST);
    t.engine.update(500, false);
    expect(t.engine.rotateHintAlpha()).toBe(0);
    t.engine.update(400, false);
    expect(t.engine.rotateHintAlpha()).toBeCloseTo(1);
    // An E badge over our head takes the spot: the hint backs off.
    t.engine.update(300, true);
    expect(t.engine.rotateHintAlpha()).toBe(0);
    t.hold(WALL);
    t.engine.update(2000, false);
    expect(t.engine.rotateHintAlpha()).toBe(0);
  });

  it('renders the ghost with balanced canvas state', () => {
    const t = setup();
    t.hold(WALL);
    const calls = { saves: 0, restores: 0 };
    const mockCtx = {
      save: () => {
        calls.saves++;
      },
      restore: () => {
        calls.restores++;
      },
      translate: () => {},
      rotate: () => {},
      scale: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      drawImage: () => {},
      globalAlpha: 1,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
    } as unknown as CanvasRenderingContext2D;
    const assets = new AssetLoader();
    expect(() => t.engine.render(mockCtx, assets)).not.toThrow();
    expect(calls.saves).toBe(calls.restores);
    expect(calls.saves).toBeGreaterThan(0);
  });
});
