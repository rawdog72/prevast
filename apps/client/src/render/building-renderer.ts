// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/building-renderer.ts
// Draws buildings (objects + furniture) the way the old client's _Buildings
// dispatcher and its per-kind renderers (_Wall, _Door, _Workbench, ...) did:
// one routine per `client.render` kind, fed by the content tables and the
// BuildingAnimator's clocks. Walls, low walls and floors autotile against
// their neighbours using the old 47-frame bitmask tables. Pure reader.

import type { AssetLoader } from '../assets/asset-loader';
import type { ContentStore } from '../content/store';
import type { ObjectEntry } from '../../../../shared/typescript/content-schema';
import type { Camera } from '../core/camera';
import { EntityType, type WorldEntity } from '../world/entity-types';
import type { WorldState } from '../world/world-state';
import {
  hurtKnock,
  STRUCTURE_HURT_MS,
  type BuildingAnimState,
  type BuildingAnimator,
} from './building-animator';
import { easeInOutQuad, triangleWave } from './character-animator';

export interface BuildingRenderContext {
  ctx: CanvasRenderingContext2D;
  assets: AssetLoader;
  content: ContentStore;
  world: WorldState;
  animator: BuildingAnimator;
  isNight: boolean;
}

interface Frame {
  index: number;
  sprite: string;
  /** Second key on tables like the automatic door's (closed 0 / open 1). */
  state?: number;
}

interface Offset {
  rotation: number;
  cx?: number;
  cy?: number;
  spineX?: number;
  spineY?: number;
}

interface ObjectClient {
  render?: string;
  renderTop?: string;
  frame?: Frame[];
  broken?: Frame[];
  hidden?: Frame[];
  deployed?: Frame[];
  on?: Frame[];
  top?: Frame[];
  light?: Frame[];
  variant?: { id: number; sprite: string }[];
  offset?: Offset[];
  angle?: number;
  pivotX?: number;
  pivotY?: number;
  autotile?: boolean;
  autotileGroup?: string;
  builder?: string;
}

const TILE = 100;
const HALF_TILE = 50;
const PI_2 = Math.PI / 2;
const DESTROY_FADE_MS = 300;
const UNUSABLE_SPRITE = 'day-unusable';
const CONCEALED_RENDERS = new Set(['landmine', 'hiddenBuilding', 'spike']);

// Old client autotile tables. Floors and full walls: 4 edge bits plus 4 corner
// bits (a corner only counts when both of its edges connect), mapped onto the
// 47 blob frames. Low walls: 4 direction bits per placement rotation.
const LEFT = 1;
const RIGHT = 2;
const TOP = 4;
const DOWN = 8;
const BIT_16 = 16; // down-right corner
const BIT_32 = 32; // down-left corner
const BIT_64 = 64; // top-right corner
const BIT_128 = 128; // top-left corner

const TILE_BITMASK: number[] = [];
{
  const m = TILE_BITMASK;
  const A = LEFT | TOP | RIGHT | DOWN;
  m[0] = 0;
  m[LEFT] = 3;
  m[RIGHT] = 4;
  m[TOP] = 2;
  m[DOWN] = 1;
  m[LEFT | TOP] = 17;
  m[LEFT | RIGHT] = 5;
  m[LEFT | DOWN] = 18;
  m[RIGHT | TOP] = 16;
  m[RIGHT | DOWN] = 19;
  m[TOP | DOWN] = 6;
  m[LEFT | TOP | DOWN] = 10;
  m[LEFT | TOP | RIGHT] = 9;
  m[DOWN | TOP | RIGHT] = 11;
  m[LEFT | DOWN | RIGHT] = 8;
  m[A] = 7;
  m[DOWN | RIGHT | BIT_16] = 12;
  m[DOWN | LEFT | BIT_32] = 13;
  m[TOP | LEFT | BIT_128] = 14;
  m[TOP | RIGHT | BIT_64] = 15;
  m[TOP | DOWN | RIGHT | BIT_16] = 20;
  m[A | BIT_16] = 21;
  m[LEFT | DOWN | RIGHT | BIT_16] = 22;
  m[A | BIT_64] = 23;
  m[LEFT | TOP | RIGHT | BIT_64] = 24;
  m[TOP | DOWN | RIGHT | BIT_64] = 25;
  m[TOP | DOWN | LEFT | BIT_128] = 26;
  m[A | BIT_128] = 27;
  m[TOP | RIGHT | LEFT | BIT_128] = 28;
  m[DOWN | RIGHT | LEFT | BIT_32] = 29;
  m[A | BIT_32] = 30;
  m[TOP | DOWN | LEFT | BIT_32] = 31;
  m[A | BIT_32 | BIT_16 | BIT_128 | BIT_64] = 32;
  m[A | BIT_32 | BIT_128] = 33;
  m[A | BIT_32 | BIT_16] = 34;
  m[A | BIT_32 | BIT_64] = 35;
  m[A | BIT_16 | BIT_128] = 36;
  m[A | BIT_64 | BIT_16] = 37;
  m[A | BIT_64 | BIT_128] = 38;
  m[TOP | DOWN | RIGHT | BIT_64 | BIT_16] = 39;
  m[TOP | DOWN | LEFT | BIT_128 | BIT_32] = 40;
  m[RIGHT | DOWN | LEFT | BIT_16 | BIT_32] = 41;
  m[RIGHT | TOP | LEFT | BIT_64 | BIT_128] = 42;
  m[A | BIT_32 | BIT_128 | BIT_64] = 43;
  m[A | BIT_16 | BIT_128 | BIT_64] = 44;
  m[A | BIT_32 | BIT_16 | BIT_64] = 45;
  m[A | BIT_32 | BIT_16 | BIT_128] = 46;
}

const DIR_TOP = 1;
const DIR_RIGHT = 2;
const DIR_BOTTOM = 4;
const DIR_LEFT = 8;

// Low wall frame per placement rotation and connection bits.
const LOW_WALL_LOOKUP: number[][] = [[], [], [], []];
{
  const fill = (rot: number, pairs: [number, number][]) => {
    for (const [bits, frame] of pairs) LOW_WALL_LOOKUP[rot]![bits] = frame;
  };
  const even: [number, number][] = [
    [0, 0],
    [DIR_TOP, 3],
    [DIR_RIGHT, 6],
    [DIR_BOTTOM | DIR_LEFT, 9],
    [DIR_BOTTOM, 4],
    [DIR_LEFT, 5],
    [DIR_TOP | DIR_BOTTOM, 27],
    [DIR_TOP | DIR_LEFT, 20],
    [DIR_RIGHT | DIR_BOTTOM, 7],
    [DIR_RIGHT | DIR_LEFT, 28],
    [DIR_TOP | DIR_BOTTOM | DIR_LEFT, 24],
    [DIR_RIGHT | DIR_BOTTOM | DIR_LEFT, 29],
  ];
  fill(0, even);
  fill(2, even);
  fill(1, [
    [0, 11],
    [DIR_TOP, 12],
    [DIR_RIGHT, 17],
    [DIR_BOTTOM | DIR_LEFT, 10],
    [DIR_BOTTOM, 19],
    [DIR_LEFT, 18],
    [DIR_TOP | DIR_BOTTOM, 34],
    [DIR_TOP | DIR_LEFT, 22],
    [DIR_RIGHT | DIR_BOTTOM, 23],
    [DIR_RIGHT | DIR_LEFT, 33],
    [DIR_TOP | DIR_BOTTOM | DIR_LEFT, 35],
    [DIR_RIGHT | DIR_BOTTOM | DIR_LEFT, 32],
  ]);
  fill(3, [
    [0, 11],
    [DIR_TOP, 15],
    [DIR_RIGHT, 14],
    [DIR_BOTTOM | DIR_LEFT, 10],
    [DIR_BOTTOM, 19],
    [DIR_LEFT, 18],
    [DIR_TOP | DIR_BOTTOM, 37],
    [DIR_TOP | DIR_LEFT, 16],
    [DIR_RIGHT | DIR_BOTTOM, 23],
    [DIR_RIGHT | DIR_LEFT, 38],
    [DIR_TOP | DIR_BOTTOM | DIR_LEFT, 36],
    [DIR_RIGHT | DIR_BOTTOM | DIR_LEFT, 39],
  ]);
}

// Campfire flame sprites and where they sit around the fire.
const FIRE_LIGHTS = ['day-campfire-light-1', 'day-campfire-light-2', 'day-campfire-light-3'];
const FIRE_LIGHT_X = [-26, 25, -7];
const FIRE_LIGHT_Y = [-28, -15, 25];
const FIRE_GLOW = 'day-campfire-light-down';

function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

function easeOutQuad(t: number): number {
  return t * (2 - t);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function tileKey(i: number, j: number): number {
  return i * 65536 + j;
}

function frameSprite(frames: Frame[] | undefined, index: number): string | undefined {
  if (!frames) return undefined;
  return frames[index]?.index === index
    ? frames[index]!.sprite
    : frames.find((f) => f.index === index)?.sprite;
}

/**
 * A frame from a table keyed on (state, index) -- the automatic door lists
 * its closed frames as state 0 and its open frames as state 1, each with the
 * break stage as the index.
 */
function stateFrameSprite(
  frames: Frame[] | undefined,
  state: number,
  index: number,
): string | undefined {
  return frames?.find((f) => (f.state ?? 0) === state && f.index === index)?.sprite;
}

/** A resolved building: its content entry, placement and this frame's animation clocks. */
interface Placed {
  entity: WorldEntity;
  object: ObjectEntry;
  client: ObjectClient;
  itemId: number;
  rotation: number;
  broke: number;
  /** Tile row/col. */
  i: number;
  j: number;
  /** Draw centre (tile centre + rotation offset). */
  x: number;
  y: number;
  anim: BuildingAnimState;
  /** Off-screen buildings are placed on warm-up frames only, to prefetch their sprites. */
  visible: boolean;
}

interface LowWallCell {
  itemId: number;
  rotate: number;
}

export class BuildingRenderer {
  private ctx!: CanvasRenderingContext2D;
  private assets!: AssetLoader;
  private isNight = false;
  /** When set, the primitives only ask the loader to warm the sprite instead of drawing. */
  private warmOnly = false;

  private readonly wallCells = new Map<number, string>();
  private readonly floorCells = new Set<number>();
  private readonly lowWallCells = new Map<number, LowWallCell>();
  private readonly placed = new Map<number, Placed[]>();
  private readonly tops: Placed[] = [];
  /** Buildings resolved for this frame (profiler gauge). */
  visibleCount = 0;

  /**
   * Resolves every visible building for this frame and registers walls,
   * low walls and floors so the autotile lookups can see their neighbours.
   * On a warm-up frame (`warmAll`) every building the server sent is placed
   * so drawLayer can prefetch the exact frames of the off-screen ones.
   */
  beginFrame(rc: BuildingRenderContext, camera: Camera, warmAll = false): void {
    this.wallCells.clear();
    this.floorCells.clear();
    this.lowWallCells.clear();
    this.placed.clear();
    this.tops.length = 0;
    this.visibleCount = 0;

    for (const type of [
      EntityType.BUILD_GROUND2,
      EntityType.BUILD_GROUND,
      EntityType.BUILD_DOWN,
      EntityType.BUILD_TOP,
    ]) {
      const list: Placed[] = [];
      for (const entity of rc.world.entities.getByType(type)) {
        const visible = camera.isVisible(entity.x, entity.y, 300);
        if (!visible && !warmAll) continue;
        const p = this.place(rc, entity, visible);
        if (!p) continue;
        list.push(p);
        if (visible) this.visibleCount++;
        const connectable = !entity.removed && !entity.retracted && p.broke === 0;
        if (!connectable) continue;
        const key = tileKey(p.i, p.j);
        if (p.client.render === 'wall' && p.client.autotile) {
          this.wallCells.set(key, p.client.autotileGroup ?? p.object.key);
        } else if (p.client.render === 'groundFloor') {
          this.floorCells.add(key);
        } else if (p.client.render === 'lowWall') {
          this.lowWallCells.set(key, { itemId: p.itemId, rotate: p.rotation });
        }
      }
      this.placed.set(type, list);
    }
  }

  /** Draws every visible building of one protocol layer. */
  drawLayer(rc: BuildingRenderContext, type: number): void {
    const list = this.placed.get(type);
    if (!list) return;
    this.ctx = rc.ctx;
    this.assets = rc.assets;
    this.isNight = rc.isNight;
    for (const p of list) {
      if (p.visible) {
        this.drawOne(p);
      } else {
        this.warmOnly = true;
        try {
          this.drawOne(p);
        } finally {
          this.warmOnly = false;
        }
      }
    }
  }

  /** Lights that sit above the top layer: campfire flames, lamp glow. */
  drawTops(rc: BuildingRenderContext): void {
    this.ctx = rc.ctx;
    this.assets = rc.assets;
    this.isNight = rc.isNight;
    for (const p of this.tops) {
      if (p.client.renderTop === 'campfireLight') this.drawCampfireLight(p);
      else if (p.client.renderTop === 'lampLight') this.drawLampLight(p);
    }
  }

  private place(
    rc: BuildingRenderContext,
    entity: WorldEntity,
    visible: boolean,
  ): Placed | undefined {
    const itemId = entity.extra >> 7;
    const rotation = (entity.extra >> 5) & 3;
    const subtype = (entity.state >> 5) & 63;
    // Variant objects (furniture, roads) carry their subtype in bits 5-10;
    // everything else keeps those bits for flags, so fall back to subtype 0.
    const object = rc.content.objectForItem(itemId, subtype) ?? rc.content.objectForItem(itemId, 0);
    if (!object) return undefined;
    const client = object.client as ObjectClient | undefined;
    if (!client) return undefined;
    const i = Math.floor(entity.y / TILE);
    const j = Math.floor(entity.x / TILE);
    const offset = client.offset?.find((o) => o.rotation === rotation);
    return {
      entity,
      object,
      client,
      itemId,
      rotation,
      broke: entity.state >> 14,
      i,
      j,
      x: j * TILE + HALF_TILE + (offset?.cx ?? 0),
      y: i * TILE + HALF_TILE + (offset?.cy ?? 0),
      anim: rc.animator.stateFor(entity),
      visible,
    };
  }

  // ---- primitives ---------------------------------------------------------

  private sprite(
    name: string | undefined,
    x: number,
    y: number,
    angle: number,
    scale: number,
  ): void {
    if (!name) return;
    if (this.warmOnly) {
      this.assets.warm(name, this.isNight);
      return;
    }
    const img = this.assets.get(name, this.isNight);
    if (!img) return;
    const w = (img.naturalWidth / 2) * scale;
    const h = (img.naturalHeight / 2) * scale;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.drawImage(img.image, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  /** Old _Door/_LowWall: rotate into the tile, then swing about the hinge (pivotX, pivotY). */
  private hinged(
    name: string | undefined,
    p: Placed,
    x: number,
    y: number,
    swing: number,
    scale: number,
  ): void {
    if (!name) return;
    if (this.warmOnly) {
      this.assets.warm(name, this.isNight);
      return;
    }
    const img = this.assets.get(name, this.isNight);
    if (!img) return;
    const w = (img.naturalWidth / 2) * scale;
    const h = (img.naturalHeight / 2) * scale;
    const px = p.client.pivotX ?? 0;
    const py = p.client.pivotY ?? 0;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(p.rotation * PI_2);
    ctx.translate(px - w / 2, py - h / 2);
    ctx.rotate(swing);
    ctx.drawImage(img.image, -px, -py, w, h);
    ctx.restore();
  }

  private withAlpha(alpha: number, draw: () => void): void {
    const prev = this.ctx.globalAlpha;
    this.ctx.globalAlpha = prev * clamp01(alpha);
    draw();
    this.ctx.globalAlpha = prev;
  }

  // ---- dispatch -----------------------------------------------------------

  private drawOne(p: Placed): void {
    const { entity, anim } = p;
    const c = p.client;
    const ctx = this.ctx;
    let scale = 1;
    let alpha = 1;
    if (entity.removed) {
      const value = Math.max(0, easeOutQuart(1 - anim.death / DESTROY_FADE_MS));
      alpha = value;
      scale = Math.min(1 + 0.35 * (1 - value), 1.35);
    } else if (entity.retracted && (!c.render || !CONCEALED_RENDERS.has(c.render))) {
      alpha = Math.max(0, easeInOutQuad(anim.reveal / 300));
    }
    const knock = c.render === 'road' ? 0 : hurtKnock(anim.hurt);
    const x = p.x + Math.cos(anim.hurtAngle) * knock;
    const y = p.y + Math.sin(anim.hurtAngle) * knock;
    const rot = p.rotation * PI_2;

    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * alpha;

    switch (c.render) {
      case 'wall':
        this.sprite(
          p.broke > 0
            ? frameSprite(c.broken, p.broke - 1)
            : frameSprite(c.frame, this.wallFrame(p)),
          x,
          y,
          0,
          scale,
        );
        break;
      case 'groundFloor':
        this.sprite(
          p.broke > 0
            ? frameSprite(c.broken, p.broke - 1)
            : frameSprite(c.frame, this.floorFrame(p)),
          x,
          y,
          0,
          scale,
        );
        break;
      case 'road':
        this.sprite(
          c.variant?.find((v) => v.id === ((entity.state >> 5) & 63))?.sprite ??
            c.variant?.[0]?.sprite,
          x,
          y,
          0,
          scale,
        );
        break;
      case 'lowWall':
        this.hinged(
          p.broke > 0
            ? frameSprite(c.broken, p.broke - 1)
            : frameSprite(c.frame, this.lowWallFrame(p)),
          p,
          x,
          y,
          0,
          scale,
        );
        break;
      case 'door':
        this.drawDoor(p, x, y, scale);
        break;
      case 'breakable':
        this.sprite(frameSprite(c.frame, p.broke), x, y, rot, scale);
        break;
      case 'furniture':
      case 'workbench':
      case 'workbench2':
        this.sprite(frameSprite(c.frame, 0), x, y, rot, scale);
        this.drawInUse(p);
        break;
      case 'campfire':
        this.sprite(frameSprite(c.frame, 0), x, y, rot, scale);
        if (anim.lit > 0 && !this.warmOnly) this.tops.push(p);
        this.drawInUse(p);
        break;
      case 'lamp': {
        const color = (entity.state >> 4) & 7;
        if (anim.power > 0) {
          this.sprite(frameSprite(c.on, color), x, y, rot, scale);
          if (!this.warmOnly) this.tops.push(p);
        } else {
          this.sprite(frameSprite(c.frame, 0), x, y, rot, scale);
        }
        break;
      }
      case 'smelter':
        this.drawWobbling(p, x, y, rot, scale, frameSprite(c.frame, 1), frameSprite(c.frame, 0));
        break;
      case 'compost':
        this.drawWobbling(p, x, y, rot, scale, frameSprite(c.frame, 0), frameSprite(c.frame, 1));
        break;
      case 'extractor':
      case 'feeder':
        this.drawRotor(p, x, y, rot, scale);
        break;
      case 'agitator':
        this.drawAgitator(p, x, y, rot, scale);
        break;
      case 'teslaBench':
        this.drawTesla(p, x, y, rot, scale);
        break;
      case 'orangeSeed':
      case 'treeSeed': {
        const amp = c.render === 'treeSeed' ? 0.01 : 0.03;
        const pulse = 1 + amp * triangleWave(anim.breath % 1000, 1000);
        this.sprite(frameSprite(c.frame, (entity.state >> 4) & 15), x, y, rot, scale * pulse);
        break;
      }
      case 'construction':
        this.drawConstruction(p, x, y, rot, scale);
        break;
      case 'dynamite': {
        const value = (anim.breath % 500) / 500;
        this.withAlpha(1 - value, () =>
          this.sprite(frameSprite(c.frame, 1), x, y, rot, 0.95 + 0.3 * easeInOutQuad(value)),
        );
        this.sprite(frameSprite(c.frame, 0), x, y, rot, scale);
        break;
      }
      case 'landmine':
        this.withAlpha(easeInOutQuad(anim.reveal / 300), () =>
          this.sprite(frameSprite(c.frame, entity.id % 3), x, y, rot, scale),
        );
        break;
      case 'spike':
        this.drawSpike(p, x, y, rot, scale);
        break;
      case 'hiddenBuilding':
        this.withAlpha(easeInOutQuad(anim.reveal / 300), () =>
          this.sprite(frameSprite(c.frame, 0), x, y, rot, scale),
        );
        break;
      case 'switchOff':
        this.sprite(frameSprite(c.frame, (entity.state >> 4) & 1), x, y, rot, scale);
        break;
      case 'timerGate':
        this.sprite(frameSprite(c.frame, (entity.state >> 4) & 3), x, y, rot, scale);
        break;
      case 'automaticDoor':
        this.drawAutomaticDoor(p, x, y, rot, scale);
        break;
      default:
        this.sprite(frameSprite(c.frame, 0), x, y, rot, scale);
    }

    ctx.globalAlpha = prevAlpha;
  }

  // ---- autotiling ---------------------------------------------------------

  private wallFrame(p: Placed): number {
    const { i, j, anim, entity } = p;
    if (anim.hurt > 0 || entity.removed || entity.retracted) return 0;
    const group = p.client.autotileGroup ?? p.object.key;
    const has = (di: number, dj: number) => this.wallCells.get(tileKey(i + di, j + dj)) === group;
    return this.blobFrame(has);
  }

  private floorFrame(p: Placed): number {
    const { i, j, anim, entity } = p;
    if (anim.hurt > 0 || entity.removed || entity.retracted) return 0;
    const has = (di: number, dj: number) => this.floorCells.has(tileKey(i + di, j + dj));
    return this.blobFrame(has);
  }

  /** 8-neighbour blob autotile: corners only count when both adjacent edges connect. */
  private blobFrame(has: (di: number, dj: number) => boolean): number {
    let id = 0;
    const t = has(-1, 0);
    const d = has(1, 0);
    const l = has(0, -1);
    const r = has(0, 1);
    if (t) id |= TOP;
    if (d) id |= DOWN;
    if (l) id |= LEFT;
    if (r) id |= RIGHT;
    if (r && t && has(-1, 1)) id |= BIT_64;
    if (l && t && has(-1, -1)) id |= BIT_128;
    if (d && r && has(1, 1)) id |= BIT_16;
    if (d && l && has(1, -1)) id |= BIT_32;
    return TILE_BITMASK[id] ?? 0;
  }

  /** Old wmNMv: a low wall joins neighbours whose rotation lines up with its own edge. */
  private lowWallFrame(p: Placed): number {
    const { i, j, anim, entity, rotation, itemId } = p;
    if (anim.hurt > 0 || entity.removed || entity.retracted)
      return LOW_WALL_LOOKUP[rotation]![0] ?? 0;
    const cell = (di: number, dj: number): LowWallCell | undefined => {
      const c = this.lowWallCells.get(tileKey(i + di, j + dj));
      return c && c.itemId === itemId ? c : undefined;
    };
    let id = 0;
    let a: LowWallCell | undefined;
    switch (rotation) {
      case 0:
        if ((a = cell(1, 0))) {
          if (a.rotate === 1) id |= DIR_TOP;
          else if (a.rotate === 3) id |= DIR_RIGHT;
        }
        if ((a = cell(0, -1)) && (a.rotate === 3 || a.rotate === 0)) id |= DIR_BOTTOM;
        if ((a = cell(0, 1)) && (a.rotate === 1 || a.rotate === 0)) id |= DIR_LEFT;
        break;
      case 1:
        if ((a = cell(0, -1))) {
          if (a.rotate === 0) id |= DIR_RIGHT;
          else if (a.rotate === 2) id |= DIR_TOP;
        }
        if ((a = cell(-1, 0)) && (a.rotate === 0 || a.rotate === 1)) id |= DIR_BOTTOM;
        if ((a = cell(1, 0)) && (a.rotate === 2 || a.rotate === 1)) id |= DIR_LEFT;
        break;
      case 2:
        if ((a = cell(-1, 0))) {
          if (a.rotate === 1) id |= DIR_RIGHT;
          else if (a.rotate === 3) id |= DIR_TOP;
        }
        if ((a = cell(0, -1)) && (a.rotate === 3 || a.rotate === 2)) id |= DIR_LEFT;
        if ((a = cell(0, 1)) && (a.rotate === 1 || a.rotate === 2)) id |= DIR_BOTTOM;
        break;
      default:
        if ((a = cell(0, 1))) {
          if (a.rotate === 0) id |= DIR_TOP;
          else if (a.rotate === 2) id |= DIR_RIGHT;
        }
        if ((a = cell(-1, 0)) && (a.rotate === 0 || a.rotate === 3)) id |= DIR_LEFT;
        if ((a = cell(1, 0)) && (a.rotate === 2 || a.rotate === 3)) id |= DIR_BOTTOM;
        break;
    }
    return LOW_WALL_LOOKUP[rotation]![id] ?? LOW_WALL_LOOKUP[rotation]![0] ?? 0;
  }

  // ---- kinds --------------------------------------------------------------

  private drawDoor(p: Placed, x: number, y: number, scale: number): void {
    const { client: c, anim } = p;
    const swing = (c.angle ?? 0) * easeInOutQuad(anim.open / 500);
    const name = p.broke > 0 ? frameSprite(c.broken, p.broke - 1) : frameSprite(c.frame, 0);
    this.hinged(name, p, x, y, swing, scale);
    if (anim.fail > 0) {
      const t = anim.fail;
      const alpha = t > 400 ? easeOutQuad(1 - (t - 400) / 200) : t < 200 ? easeOutQuad(t / 200) : 1;
      this.withAlpha(alpha, () =>
        this.sprite(UNUSABLE_SPRITE, p.j * TILE + HALF_TILE, p.i * TILE + HALF_TILE, 0, 1),
      );
    }
  }

  /** Old containeropenic: a pulsing "busy" marker while someone else has this open. */
  private drawInUse(p: Placed): void {
    const { anim } = p;
    if (anim.use <= 0) return;
    const pulse = 1 + 0.15 * triangleWave(anim.breath % 1000, 1000);
    this.withAlpha(easeOutQuad(anim.use / 500), () =>
      this.sprite(UNUSABLE_SPRITE, p.j * TILE + HALF_TILE, p.i * TILE + HALF_TILE, 0, pulse),
    );
  }

  private wobble(p: Placed): number {
    return p.anim.work > 0 ? easeOutQuad(p.anim.work / 10000) : 0;
  }

  private drawWobbling(
    p: Placed,
    x: number,
    y: number,
    rot: number,
    scale: number,
    onSprite?: string,
    offSprite?: string,
  ): void {
    const value = this.wobble(p);
    if (value > 0) {
      this.sprite(
        onSprite,
        x + (Math.random() * 2 - 1) * value,
        y + (Math.random() * 2 - 1) * value,
        rot,
        scale,
      );
    } else {
      this.sprite(offSprite, x, y, rot, scale);
    }
    this.drawInUse(p);
  }

  private spine(p: Placed): { x: number; y: number } {
    const o = p.client.offset?.find((o) => o.rotation === p.rotation);
    return { x: o?.spineX ?? 0, y: o?.spineY ?? 0 };
  }

  private drawRotor(p: Placed, x: number, y: number, rot: number, scale: number): void {
    const c = p.client;
    const value = this.wobble(p);
    if (value > 0) {
      const wx = x + (Math.random() * 2 - 1) * value;
      const wy = y + (Math.random() * 2 - 1) * value;
      const s = this.spine(p);
      this.sprite(frameSprite(c.frame, 1), wx + s.x, wy + s.y, rot + p.anim.spin, scale);
      this.sprite(frameSprite(c.frame, 0), wx, wy, rot, scale);
    } else {
      this.sprite(frameSprite(c.frame, 2), x, y, rot, scale);
    }
    this.drawInUse(p);
  }

  private drawAgitator(p: Placed, x: number, y: number, rot: number, scale: number): void {
    const c = p.client;
    if (this.wobble(p) > 0) {
      const s = this.spine(p);
      this.sprite(frameSprite(c.frame, 1), x, y, rot, scale);
      this.sprite(frameSprite(c.frame, 2), x + s.x, y + s.y, rot + p.anim.spin, scale);
      this.sprite(frameSprite(c.frame, 3), x, y, rot, scale);
    } else {
      this.sprite(frameSprite(c.frame, 0), x, y, rot, scale);
    }
    this.drawInUse(p);
  }

  private drawTesla(p: Placed, x: number, y: number, rot: number, scale: number): void {
    const c = p.client;
    const t = p.anim.work;
    if (t > 0) {
      this.sprite(frameSprite(c.frame, 1 + (Math.floor(t / 500) % 3)), x, y, rot, scale);
      const lights = c.light ?? [];
      if (lights.length) {
        const span = (lights[lights.length - 1]?.index ?? 0) + 1;
        this.sprite(frameSprite(lights, Math.floor(t / 50) % span), x, y, rot, scale);
      }
    } else {
      this.sprite(frameSprite(c.frame, 0), x, y, rot, scale);
    }
    this.drawInUse(p);
  }

  private drawConstruction(p: Placed, x: number, y: number, rot: number, scale: number): void {
    const { client: c, anim, entity } = p;
    const EVOLVE_MS = 1000;
    this.sprite(c.builder, x, y, rot, 1);
    const level = (entity.state >> 4) & 15;
    const pulse = 1 + 0.03 * triangleWave(anim.breath % 1000, 1000);
    const s = scale * pulse;
    if (level === 0) {
      this.withAlpha(easeInOutQuad(Math.min(1, anim.stageT / EVOLVE_MS)), () =>
        this.sprite(frameSprite(c.frame, 0), x, y, rot, s),
      );
    } else if (anim.stageT < EVOLVE_MS) {
      const progress = easeInOutQuad(anim.stageT / EVOLVE_MS);
      this.withAlpha(1 - progress, () =>
        this.sprite(frameSprite(c.frame, level - 1), x, y, rot, s),
      );
      this.withAlpha(progress, () => this.sprite(frameSprite(c.frame, level), x, y, rot, s));
    } else {
      this.sprite(frameSprite(c.frame, level), x, y, rot, s);
    }
  }

  private drawSpike(p: Placed, x: number, y: number, rot: number, scale: number): void {
    const { client: c, anim, entity } = p;
    const triggered = (entity.state & 16) !== 0;
    const variant = entity.id % 3;
    if (triggered) {
      let jx = x;
      let jy = y;
      if (anim.jitter < 300) {
        jx += Math.random() * 6 - 4;
        jy += Math.random() * 6 - 4;
      }
      this.sprite(frameSprite(c.deployed, variant), jx, jy, rot, scale);
    } else {
      this.withAlpha(easeInOutQuad(anim.reveal / 300), () =>
        this.sprite(frameSprite(c.hidden, variant), x, y, rot, scale),
      );
    }
  }

  private drawAutomaticDoor(p: Placed, x: number, y: number, rot: number, scale: number): void {
    const { client: c, anim } = p;
    // Frames are keyed (state, break stage): state 0 closed, state 1 open.
    const closed = stateFrameSprite(c.frame, 0, p.broke);
    const open = stateFrameSprite(c.frame, 1, p.broke);
    if (anim.open > 0 && anim.open < 500) {
      this.withAlpha(easeOutQuad(anim.open / 500), () => this.sprite(open, x, y, rot, scale));
      this.withAlpha(easeOutQuad(1 - anim.open / 500), () => this.sprite(closed, x, y, rot, scale));
    } else {
      this.sprite(anim.open >= 500 ? open : closed, x, y, rot, scale);
    }
  }

  // ---- tops ---------------------------------------------------------------

  private drawCampfireLight(p: Placed): void {
    const { anim } = p;
    this.withAlpha(easeOutQuad(anim.lit / 500), () => {
      for (let i = 0; i < 3; i++) {
        const phase = (anim.breath + i * 333) % 1000;
        const s = 1 + 0.15 * triangleWave(phase, 1000);
        this.sprite(FIRE_LIGHTS[i], p.x + FIRE_LIGHT_X[i]!, p.y + FIRE_LIGHT_Y[i]!, 0, s);
      }
      const glow = 1 + 0.15 * triangleWave(anim.breath % 5000, 5000);
      this.sprite(FIRE_GLOW, p.x, p.y, 0, glow);
    });
  }

  private drawLampLight(p: Placed): void {
    const { anim, entity, client: c } = p;
    const color = (entity.state >> 4) & 7;
    const s = 1 + 0.09 * triangleWave(anim.breath % 5000, 5000);
    this.withAlpha(easeOutQuad(anim.power / 500), () =>
      this.sprite(frameSprite(c.top, color), p.x, p.y, 0, s),
    );
  }
}

export { STRUCTURE_HURT_MS };
