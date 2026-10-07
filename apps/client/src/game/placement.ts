// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/game/placement.ts
// Building placement, after the old client's placingobj: while the SERVER
// says we hold a building piece -- the entity's weapon (extra >> 8) is the
// place_object equipable and BLUEPRINT names the item, both of which only
// arrive once the equip countdown ends -- its ghost sits on the tile NEXT to
// the player in the aim direction (never under the cursor; the server only
// accepts the adjacent ring anyway), blue where the piece can go and red where
// it cannot, walls and floors never rotate, the `craft-grid` fades in under
// our tile (wmVNW), and a `hint-rotate` badge fades in over the head once a
// rotatable piece has been held for a moment. A click sends PLACE_BUILDING
// [rotation][row][column] only while the ghost is blue; the server keeps the
// real say (Game::playerPlaceObject).

import type { AssetLoader } from '../assets/asset-loader';
import type { ContentStore } from '../content/store';
import type { ObjectEntry } from '../../../../shared/typescript/content-schema';
import type { Camera } from '../core/camera';
import type { MouseTracker } from '../core/mouse';
import type { GameSocket } from '../net/socket';
import { EntityType } from '../world/entity-types';
import type { InventoryStore } from '../world/inventory-store';
import type { WorldState } from '../world/world-state';

interface PlacementOffset {
  rotation: number;
  /** Ghost / building centre shift from the tile centre (old xCenter / yCenter). */
  cx?: number;
  cy?: number;
  /** The second tile of a two-tile piece, relative to the target (old iTile / jTile). */
  tileI?: number;
  tileJ?: number;
}

interface PlaceableClient {
  render?: string;
  blueprint?: string;
  redprint?: string;
  offset?: PlacementOffset[];
}

export interface PlaceableDefinition {
  key: string;
  object: ObjectEntry;
  blueprint: string;
  redprint: string;
  category?: string;
  /** Old `wall: 1`: autotiled walls and floors always go down at rotation 0. */
  rotatable: boolean;
}

export interface GridCell {
  i: number;
  j: number;
  /** 0..1 opacity. */
  alpha: number;
}

export interface PlacementTarget {
  /** Tile row and column the piece lands on. */
  i: number;
  j: number;
  /** Where the ghost is drawn: tile centre plus the rotation's cx/cy. */
  x: number;
  y: number;
  rotation: number;
  canBuild: boolean;
}

const TILE = 100;
const HALF_TILE = 50;
/** Old hintRotate: counts up to 900 while holding a rotatable piece, visible past 600. */
const HINT_MAX_MS = 900;
const HINT_SHOW_MS = 600;
/** Old wmVNW: the grid under our tile fades over 500 ms; up to three left-behind tiles fade out. */
const GRID_FADE_MS = 500;
const GRID_PREV_CELLS = 3;
const GRID_SPRITE = 'craft-grid';
/** equipables.typeId of place_object: the old client's weapon `type === 6` = isBuilding. */
const BUILD_WEAPON_TYPE = 6;
/** Server isTileClear: a creature, player or pickup this close (per axis) to a tile centre blocks it. */
const BLOCKING_RADIUS = 60;

const STRUCTURE_TYPES = [
  EntityType.BUILD_TOP,
  EntityType.BUILD_DOWN,
  EntityType.BUILD_GROUND,
  EntityType.BUILD_GROUND2,
];
const RESOURCE_TYPES = [
  EntityType.RES_TOP,
  EntityType.RES_DOWN,
  EntityType.RES_MID,
  EntityType.RES_STOP,
];
const BLOCKER_TYPES = [EntityType.PLAYER, EntityType.AI, EntityType.LOOT];

function easeOutQuad(t: number): number {
  return t * (2 - t);
}

/** Old placingobj: `_j + floor((50 + cos(angle) * 100) / 100)` -- one of the 8 neighbours. */
export function neighbourStep(angle: number): { di: number; dj: number } {
  return {
    dj: Math.floor((HALF_TILE + Math.cos(angle) * TILE) / TILE),
    di: Math.floor((HALF_TILE + Math.sin(angle) * TILE) / TILE),
  };
}

function isFloorObject(object: ObjectEntry): boolean {
  return object.category === 'floor' || object.category === 'road';
}

export class PlacementEngine {
  readonly world: WorldState;
  readonly inventory: InventoryStore;
  readonly content: ContentStore;
  readonly socket: GameSocket;
  readonly mouse: MouseTracker;
  readonly camera: Camera;

  rotationIndex = 0; // 0..3
  private hintMs = 0;
  /** The grid under our current tile: ms of fade (0..500) and which tile. */
  private grid = { ms: 0, i: -1, j: -1 };
  /** Tiles we walked off while building, each fading out. */
  private readonly gridPrev: { ms: number; i: number; j: number }[] = [];

  constructor(options: {
    world: WorldState;
    inventory: InventoryStore;
    content: ContentStore;
    socket: GameSocket;
    mouse: MouseTracker;
    camera: Camera;
  }) {
    this.world = options.world;
    this.inventory = options.inventory;
    this.content = options.content;
    this.socket = options.socket;
    this.mouse = options.mouse;
    this.camera = options.camera;
  }

  rotate(): void {
    this.rotationIndex = (this.rotationIndex + 1) % 4;
  }

  /**
   * Old isBuilding: the weapon the server shows in our hand (entity extra >> 8)
   * is the place_object equipable. Set only once the equip countdown ends, and
   * gone again when the server unequips it -- including the re-click that
   * toggles the piece off, which the local active slot never learns about.
   */
  isBuilding(): boolean {
    const local = this.world.getLocalEntity();
    if (!local || !this.content.has('equipables')) return false;
    const equipable = this.content.byId('equipables', (local.extra >> 8) & 255);
    return equipable?.typeId === BUILD_WEAPON_TYPE;
  }

  /** The piece the server says we are holding (BLUEPRINT), while it also shows it in our hand. */
  getActivePlaceable(): PlaceableDefinition | null {
    const iid = this.inventory.blueprintIid;
    if (
      iid <= 0 ||
      !this.isBuilding() ||
      !this.content.has('items') ||
      !this.content.has('objects')
    )
      return null;
    const itemEntry = this.content.byId('items', iid);
    if (!itemEntry) return null;
    const object = this.content.byKey('objects', itemEntry.key);
    const client = object?.client as PlaceableClient | undefined;
    if (!object || !client?.blueprint) return null;
    return {
      key: itemEntry.key,
      object,
      blueprint: client.blueprint,
      redprint: client.redprint ?? client.blueprint,
      category: object.category,
      rotatable: client.render !== 'wall' && client.render !== 'groundFloor',
    };
  }

  /** Whether a click places instead of attacking (old NnnNW: `isBuilding`). */
  isPlacing(): boolean {
    return this.isBuilding();
  }

  /** The tile the held piece would go on, or null when nothing placeable is held. */
  target(): PlacementTarget | null {
    const placeable = this.getActivePlaceable();
    const local = this.world.getLocalEntity();
    if (!placeable || !local) return null;

    const step = neighbourStep(this.world.localPlayerAngle);
    const i = Math.floor(local.y / TILE) + step.di;
    const j = Math.floor(local.x / TILE) + step.dj;
    const rotation = placeable.rotatable ? this.rotationIndex : 0;
    const client = placeable.object.client as PlaceableClient | undefined;
    const offset = client?.offset?.find((o) => o.rotation === rotation);

    return {
      i,
      j,
      x: j * TILE + HALF_TILE + (offset?.cx ?? 0),
      y: i * TILE + HALF_TILE + (offset?.cy ?? 0),
      rotation,
      canBuild: this.canBuild(placeable, i, j, offset),
    };
  }

  /**
   * The client-side read of the server's isTileClear, over every tile of the
   * piece's footprint: nothing that is not a floor may already be there (a
   * building, a tree, a rock), a floor or a plant may not go onto a floor, and
   * no player, creature or pickup may stand within 60 units of the tile centre
   * -- ourselves included: the server does not exempt the builder, so standing
   * on the edge of your own tile blocks the next one.
   */
  private canBuild(
    placeable: PlaceableDefinition,
    i: number,
    j: number,
    offset: PlacementOffset | undefined,
  ): boolean {
    const tiles: [number, number][] = [[i, j]];
    if (offset?.tileI || offset?.tileJ)
      tiles.push([i + (offset.tileI ?? 0), j + (offset.tileJ ?? 0)]);
    const placingFloor = isFloorObject(placeable.object);
    const placingPlant = placeable.category === 'plant';

    for (const [ti, tj] of tiles) {
      if (ti < 0 || tj < 0 || ti >= this.world.tilesY || tj >= this.world.tilesX) return false;
      const cx = tj * TILE + HALF_TILE;
      const cy = ti * TILE + HALF_TILE;

      for (const type of STRUCTURE_TYPES) {
        for (const ent of this.world.entities.getByType(type)) {
          if (
            ent.removed ||
            ent.retracted ||
            Math.floor(ent.y / TILE) !== ti ||
            Math.floor(ent.x / TILE) !== tj
          )
            continue;
          const object =
            this.content.objectForItem(ent.extra >> 7, (ent.state >> 5) & 63) ??
            this.content.objectForItem(ent.extra >> 7, 0);
          if (!object) return false;
          if (isFloorObject(object)) {
            if (placingFloor || placingPlant || object.category === 'road') return false;
          } else {
            return false;
          }
        }
      }
      for (const type of RESOURCE_TYPES) {
        for (const ent of this.world.entities.getByType(type)) {
          if (
            !ent.removed &&
            !ent.retracted &&
            Math.floor(ent.y / TILE) === ti &&
            Math.floor(ent.x / TILE) === tj
          )
            return false;
        }
      }
      for (const type of BLOCKER_TYPES) {
        for (const ent of this.world.entities.getByType(type)) {
          if (ent.removed || ent.retracted) continue;
          if (Math.abs(ent.x - cx) < BLOCKING_RADIUS && Math.abs(ent.y - cy) < BLOCKING_RADIUS)
            return false;
        }
      }
    }
    return true;
  }

  /** Sends the piece to its tile when the ghost is blue; false when nothing went out. */
  place(): boolean {
    const target = this.target();
    if (!target || !target.canBuild) return false;
    this.socket.placeObject(target.rotation, target.i, target.j);
    return true;
  }

  /**
   * Runs the clocks: the rotate hint fills while a rotatable piece is held and
   * nothing else needs the spot over the head (`badgeShown`: an E/F badge),
   * and drains otherwise; the craft grid fades in under our tile while
   * building, hands the tile we step off to the fading-out list, and drains
   * once we stop.
   */
  update(deltaMs: number, badgeShown: boolean): void {
    const placeable = this.getActivePlaceable();
    const fill = !!placeable && placeable.rotatable && !badgeShown;
    this.hintMs = fill
      ? Math.min(HINT_MAX_MS, this.hintMs + deltaMs)
      : Math.max(0, this.hintMs - deltaMs);

    const local = this.world.getLocalEntity();
    const grid = this.grid;
    if (this.isBuilding() && local) {
      const i = Math.floor(local.y / TILE);
      const j = Math.floor(local.x / TILE);
      if (grid.i !== i || grid.j !== j) {
        if (grid.ms > 0 && this.gridPrev.length < GRID_PREV_CELLS)
          this.gridPrev.push({ ms: grid.ms, i: grid.i, j: grid.j });
        grid.ms = 0;
        grid.i = i;
        grid.j = j;
      }
      grid.ms = Math.min(GRID_FADE_MS, grid.ms + deltaMs);
    } else {
      grid.ms = Math.max(0, grid.ms - deltaMs);
      if (grid.ms === 0) grid.i = grid.j = -1;
    }
    for (const prev of this.gridPrev) prev.ms = Math.max(0, prev.ms - deltaMs);
    for (let k = this.gridPrev.length - 1; k >= 0; k--)
      if (this.gridPrev[k]!.ms <= 0) this.gridPrev.splice(k, 1);
  }

  /** Every grid cell being shown, current tile first, with its opacity. */
  gridCells(): GridCell[] {
    const cells: GridCell[] = [];
    if (this.grid.ms > 0)
      cells.push({ i: this.grid.i, j: this.grid.j, alpha: this.grid.ms / GRID_FADE_MS });
    for (const p of this.gridPrev) cells.push({ i: p.i, j: p.j, alpha: p.ms / GRID_FADE_MS });
    return cells;
  }

  /** Old wmVNW: the craft grid on the ground, under everything else (world space, camera applied). */
  renderGrid(ctx: CanvasRenderingContext2D, assets: AssetLoader): void {
    const cells = this.gridCells();
    if (cells.length === 0) return;
    const img = assets.get(GRID_SPRITE);
    if (!img) return;
    const w = img.naturalWidth / 2;
    const h = img.naturalHeight / 2;
    const prev = ctx.globalAlpha;
    for (const cell of cells) {
      ctx.globalAlpha = prev * cell.alpha;
      ctx.drawImage(
        img.image,
        cell.j * TILE + HALF_TILE - w / 2,
        cell.i * TILE + HALF_TILE - h / 2,
        w,
        h,
      );
    }
    ctx.globalAlpha = prev;
  }

  /** Opacity of the hint-rotate badge over the player's head (old hintRotate ramp). */
  rotateHintAlpha(): number {
    return easeOutQuad(Math.max(0, this.hintMs - HINT_SHOW_MS) / (HINT_MAX_MS - HINT_SHOW_MS));
  }

  render(ctx: CanvasRenderingContext2D, assets: AssetLoader, isNight = false): void {
    const placeable = this.getActivePlaceable();
    const target = placeable ? this.target() : null;
    if (!placeable || !target) return;

    const spriteName = target.canBuild ? placeable.blueprint : placeable.redprint;
    const img = assets.get(spriteName, isNight);

    ctx.save();
    this.camera.applyTransform(ctx);
    ctx.translate(target.x, target.y);
    ctx.rotate((target.rotation * Math.PI) / 2);

    if (img) {
      // HiDPI assets are 2x resolution, like every other sprite (world scale is naturalWidth / 2).
      const w = img.naturalWidth / 2;
      const h = img.naturalHeight / 2;
      ctx.drawImage(img.image, -w / 2, -h / 2, w, h);
    } else {
      // The tinted sprite is not decoded yet: a flat tile in its colour meanwhile.
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = target.canBuild ? 'rgba(90, 160, 255, 0.5)' : 'rgba(255, 80, 80, 0.5)';
      const s = TILE * 0.9;
      ctx.fillRect(-s / 2, -s / 2, s, s);
    }

    ctx.restore();
  }
}
