// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Editor-only drawing on top of the game render: grid, regions and their effect ranges,
// spawn markers, selection and rejected-operation highlights. World space throughout.
import { TILE_SIZE } from '../../../../../shared/typescript/editor-limits';
import {
  GRID_KINDS,
  type RegionShape,
  type ScenarioRegion,
} from '../../../../../shared/typescript/scenario-schema';
import { footprint } from '../document/spatial';
import { expandSelection, regionWorldShape, shapeBounds } from '../document/ops';
import type { EditorContext } from '../editor-context';

const STAT_COLOURS: Record<string, string> = {
  radiation: '120, 230, 80',
  warmth: '255, 160, 60',
  health: '240, 80, 80',
  stamina: '250, 220, 80',
  food: '200, 140, 90',
};
const PERMISSION_COLOUR = '110, 170, 255';
const TEAM_COLOURS = ['#f2f4f6', '#ff6b6b', '#5ab8ff', '#7ee07e', '#ffd166', '#c792ea'];

export function regionColour(region: ScenarioRegion): string {
  const first = region.effects?.[0];
  return first ? (STAT_COLOURS[first.stat] ?? PERMISSION_COLOUR) : PERMISSION_COLOUR;
}

function tracePath(g: CanvasRenderingContext2D, shape: RegionShape): void {
  g.beginPath();
  if (shape.type === 'circle') g.arc(shape.x, shape.y, shape.r, 0, Math.PI * 2);
  else if (shape.type === 'rect') g.rect(shape.x, shape.y, shape.w, shape.h);
  else {
    shape.points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
  }
}

export function drawRegionShape(
  g: CanvasRenderingContext2D,
  shape: RegionShape,
  stroke: string,
  fill: string,
  zoom: number,
  dashed = false,
): void {
  g.save();
  tracePath(g, shape);
  g.fillStyle = fill;
  g.fill();
  g.strokeStyle = stroke;
  g.lineWidth = 2 / zoom;
  if (dashed) g.setLineDash([10 / zoom, 6 / zoom]);
  g.stroke();
  g.restore();
}

/** Falloff visualised as a radial gradient for circles with linear falloff. */
function drawRegionFill(g: CanvasRenderingContext2D, region: ScenarioRegion, shape: RegionShape, zoom: number, selected: boolean): void {
  const rgb = regionColour(region);
  const linear = region.effects?.some((e) => e.falloff === 'linear');
  g.save();
  tracePath(g, shape);
  if (linear && shape.type === 'circle') {
    const grad = g.createRadialGradient(shape.x, shape.y, 0, shape.x, shape.y, shape.r);
    grad.addColorStop(0, `rgba(${rgb}, 0.35)`);
    grad.addColorStop(1, `rgba(${rgb}, 0.02)`);
    g.fillStyle = grad;
  } else {
    g.fillStyle = `rgba(${rgb}, ${selected ? 0.22 : 0.13})`;
  }
  g.fill();
  g.strokeStyle = `rgba(${rgb}, ${selected ? 1 : 0.75})`;
  g.lineWidth = (selected ? 3 : 2) / zoom;
  if (!region.effects?.length) g.setLineDash([12 / zoom, 8 / zoom]);
  g.stroke();
  g.restore();
}

function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, zoom: number, colour = '#f2f4f6'): void {
  g.save();
  g.font = `${13 / zoom}px Viga, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 3 / zoom;
  g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.strokeText(text, x, y);
  g.fillStyle = colour;
  g.fillText(text, x, y);
  g.restore();
}

export function drawGrid(g: CanvasRenderingContext2D, ctx: EditorContext, x0: number, y0: number, x1: number, y1: number): void {
  const zoom = ctx.camera.zoom;
  if (zoom * TILE_SIZE < 8) return;
  const { tilesX, tilesY } = ctx.store.header.world;
  const tx0 = Math.max(0, Math.floor(x0 / TILE_SIZE));
  const ty0 = Math.max(0, Math.floor(y0 / TILE_SIZE));
  const tx1 = Math.min(tilesX, Math.ceil(x1 / TILE_SIZE));
  const ty1 = Math.min(tilesY, Math.ceil(y1 / TILE_SIZE));
  g.save();
  g.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  g.lineWidth = 1 / zoom;
  g.beginPath();
  for (let tx = tx0; tx <= tx1; tx++) {
    g.moveTo(tx * TILE_SIZE, ty0 * TILE_SIZE);
    g.lineTo(tx * TILE_SIZE, ty1 * TILE_SIZE);
  }
  for (let ty = ty0; ty <= ty1; ty++) {
    g.moveTo(tx0 * TILE_SIZE, ty * TILE_SIZE);
    g.lineTo(tx1 * TILE_SIZE, ty * TILE_SIZE);
  }
  g.stroke();
  // Chunk lines every 16 tiles help judge distance when zoomed out.
  g.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  g.beginPath();
  for (let tx = Math.ceil(tx0 / 16) * 16; tx <= tx1; tx += 16) {
    g.moveTo(tx * TILE_SIZE, ty0 * TILE_SIZE);
    g.lineTo(tx * TILE_SIZE, ty1 * TILE_SIZE);
  }
  for (let ty = Math.ceil(ty0 / 16) * 16; ty <= ty1; ty += 16) {
    g.moveTo(tx0 * TILE_SIZE, ty * TILE_SIZE);
    g.lineTo(tx1 * TILE_SIZE, ty * TILE_SIZE);
  }
  g.stroke();
  g.restore();
}

export function drawRegions(g: CanvasRenderingContext2D, ctx: EditorContext, x0: number, y0: number, x1: number, y1: number): void {
  if (ctx.hiddenLayers.has('regions')) return;
  const zoom = ctx.camera.zoom;
  for (const region of ctx.store.regions.values()) {
    const shape = regionWorldShape(ctx.store, region);
    if (!shape) continue;
    const b = shapeBounds(shape);
    if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1) continue;
    drawRegionFill(g, region, shape, zoom, ctx.selection.has(region.id));
    if (zoom > 0.08) {
      const effects = region.effects?.map((e) => `${e.stat} ${e.perMinute > 0 ? '+' : ''}${e.perMinute}/min`).join(', ');
      label(g, effects ? `${region.name} · ${effects}` : region.name, (b.x0 + b.x1) / 2, b.y0 + 14 / zoom, zoom);
    }
  }
}

export function drawSpawns(g: CanvasRenderingContext2D, ctx: EditorContext, ids: Iterable<string>): void {
  if (ctx.hiddenLayers.has('spawns')) return;
  const zoom = ctx.camera.zoom;
  const teams = new Map<string, number>();
  for (const id of ids) {
    const e = ctx.store.entities.get(id);
    if (!e || e.kind !== 'spawn') continue;
    const team = e.team ?? '';
    if (!teams.has(team)) teams.set(team, teams.size);
    g.save();
    g.translate(e.x, e.y);
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.strokeStyle = TEAM_COLOURS[teams.get(team)! % TEAM_COLOURS.length]!;
    g.lineWidth = 4;
    g.beginPath();
    g.arc(0, 0, 32, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.rotate(((e.angle ?? 0) / 256) * Math.PI * 2);
    g.beginPath();
    g.moveTo(40, 0);
    g.lineTo(24, -10);
    g.lineTo(24, 10);
    g.closePath();
    g.fillStyle = g.strokeStyle;
    g.fill();
    g.restore();
    label(g, team ? `Spawn · ${team}` : 'Spawn', e.x, e.y, zoom);
  }
}

/** Outlines for the selection (closure), rejected members and selected group pivots. */
export function drawSelection(g: CanvasRenderingContext2D, ctx: EditorContext): void {
  const zoom = ctx.camera.zoom;
  const outline = (id: string, colour: string) => {
    const e = ctx.store.entities.get(id);
    if (!e) return;
    g.strokeStyle = colour;
    if (GRID_KINDS.has(e.kind)) {
      for (const [tx, ty] of footprint(e, ctx.catalog.resolve(e.kind, e.ref, e.variant)))
        g.strokeRect(tx * TILE_SIZE + 3, ty * TILE_SIZE + 3, TILE_SIZE - 6, TILE_SIZE - 6);
    } else {
      g.beginPath();
      g.arc(e.x, e.y, 42, 0, Math.PI * 2);
      g.stroke();
    }
  };
  g.save();
  g.lineWidth = Math.max(2, 2 / zoom);
  const closure = expandSelection(ctx.store, ctx.selection.values());
  let drawn = 0;
  for (const id of closure) {
    if (drawn++ > 5000) break;
    outline(id, ctx.selection.has(id) ? 'rgba(255, 230, 120, 0.95)' : 'rgba(255, 230, 120, 0.55)');
  }
  for (const id of ctx.offenders) outline(id, 'rgba(255, 70, 70, 1)');
  for (const id of ctx.selection.values()) {
    const group = ctx.store.groups.get(id);
    if (!group) continue;
    const s = 18 / zoom;
    g.strokeStyle = 'rgba(255, 230, 120, 0.95)';
    g.beginPath();
    g.moveTo(group.pivot.x - s, group.pivot.y);
    g.lineTo(group.pivot.x + s, group.pivot.y);
    g.moveTo(group.pivot.x, group.pivot.y - s);
    g.lineTo(group.pivot.x, group.pivot.y + s);
    g.stroke();
  }
  g.restore();
}

/** Group outlines (houses and cities) with their names, when zoomed out enough to matter. */
export function drawGroupLabels(g: CanvasRenderingContext2D, ctx: EditorContext, bounds: (id: string) => { x0: number; y0: number; x1: number; y1: number } | undefined): void {
  const zoom = ctx.camera.zoom;
  for (const group of ctx.store.groups.values()) {
    if (group.kind === 'group' && !ctx.selection.has(group.id)) continue;
    const b = bounds(group.id);
    if (!b) continue;
    g.save();
    g.strokeStyle = group.kind === 'city' ? 'rgba(255, 200, 120, 0.6)' : 'rgba(200, 220, 255, 0.45)';
    g.lineWidth = 2 / zoom;
    g.setLineDash([14 / zoom, 8 / zoom]);
    g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    g.restore();
    label(g, group.name, (b.x0 + b.x1) / 2, b.y0 - 12 / zoom, zoom, group.kind === 'city' ? '#ffd799' : '#dce6f5');
  }
}
