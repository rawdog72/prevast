// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// A one-pixel-per-tile picture of the grid layers, for low zoom and the minimap. Drawing a
// 655x655 map sprite by sprite at overview zoom would touch every entity every frame; this
// bitmap is repainted only where document changes land.
import { GRID_KINDS, tileOf, type ScenarioEntity } from '../../../../../shared/typescript/scenario-schema';
import type { CatalogEntry, EditorCatalog } from '../catalog/catalog';
import { footprint, type SpatialIndex } from '../document/spatial';
import type { Change, DocumentStore } from '../document/store';

const GROUND = [61, 89, 66];

const CATEGORY_COLOURS: Record<string, [number, number, number]> = {
  wall: [196, 176, 132],
  floor: [132, 112, 86],
  road: [96, 96, 96],
  furniture: [168, 120, 80],
  station: [210, 140, 60],
  container: [190, 150, 90],
  logic: [90, 170, 200],
  trap: [200, 80, 80],
  explosives: [220, 60, 60],
  plant: [120, 200, 90],
  spawner: [150, 100, 190],
  resource: [40, 120, 50],
};

function colourFor(entry: CatalogEntry | undefined): [number, number, number] {
  if (!entry) return [255, 0, 255];
  if (entry.kind === 'resource') {
    const ref = entry.ref;
    if (ref === 'stone') return [150, 150, 150];
    if (ref === 'steel') return [120, 140, 160];
    if (ref === 'uranium') return [140, 220, 90];
    if (ref === 'sulfur') return [220, 210, 80];
    return CATEGORY_COLOURS.resource!;
  }
  return CATEGORY_COLOURS[entry.category] ?? [180, 180, 180];
}

export class OverviewBitmap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private image: ImageData;
  private dirty = true;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: DocumentStore,
    private readonly spatial: SpatialIndex,
    private readonly catalog: EditorCatalog,
    doc: Document = document,
  ) {
    this.canvas = doc.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.image = this.allocate();
    this.repaintAll();
    this.unsubscribe = store.onChange((changes) => this.onChanges(changes));
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** The canvas, flushed if anything changed since the last call. */
  bitmap(): HTMLCanvasElement {
    if (this.dirty) {
      this.ctx.putImageData(this.image, 0, 0);
      this.dirty = false;
    }
    return this.canvas;
  }

  private allocate(): ImageData {
    const { tilesX, tilesY } = this.store.header.world;
    this.canvas.width = tilesX;
    this.canvas.height = tilesY;
    return this.ctx.createImageData(tilesX, tilesY);
  }

  private repaintAll(): void {
    const { tilesX, tilesY } = this.store.header.world;
    for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) this.paint(tx, ty);
    this.dirty = true;
  }

  private onChanges(changes: readonly Change[]): void {
    for (const c of changes) {
      if (c.kind === 'header') {
        if (c.before.world.tilesX !== c.after.world.tilesX || c.before.world.tilesY !== c.after.world.tilesY) {
          this.image = this.allocate();
          this.repaintAll();
          return;
        }
        continue;
      }
      if (c.kind !== 'entity') continue;
      for (const e of [c.before, c.after] as (ScenarioEntity | null)[]) {
        if (!e || !GRID_KINDS.has(e.kind)) continue;
        for (const [tx, ty] of footprint(e, this.catalog.resolve(e.kind, e.ref, e.variant))) this.paint(tx, ty);
      }
    }
    this.dirty = true;
  }

  private paint(tx: number, ty: number): void {
    const { tilesX, tilesY } = this.store.header.world;
    if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) return;
    const cell = this.spatial.cell(tx, ty);
    const id = cell?.solid ?? cell?.floor;
    const e = id ? this.store.entities.get(id) : undefined;
    const [r, g, b] = e ? colourFor(this.catalog.resolve(e.kind, e.ref, e.variant)) : GROUND;
    const i = (ty * tilesX + tx) * 4;
    const d = this.image.data;
    d[i] = r!;
    d[i + 1] = g!;
    d[i + 2] = b!;
    d[i + 3] = 255;
  }
}

/** Tile of a world coordinate, clamped into the map. */
export function clampTile(units: number, tiles: number): number {
  return Math.max(0, Math.min(tiles - 1, tileOf(units)));
}
