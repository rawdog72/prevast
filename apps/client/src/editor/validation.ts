// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Authoring diagnostics for the open document: the shared structural rules plus what needs
// the content catalog -- missing content, unsupported overrides, container and loot contents,
// and static spawn safety. The codes match the server's compile step (scenario_compile.cpp).
// A static check says a tile is blocked; it cannot prove a level is playable.
import { TILE_SIZE } from '../../../../shared/typescript/editor-limits';
import { permissionAt, regionContains, resolveRegions } from '../../../../shared/typescript/scenario-regions';
import {
  validateProject,
  type Diagnostic,
  type ItemStack,
  type ScenarioProject,
} from '../../../../shared/typescript/scenario-schema';
import type { EditorCatalog } from './catalog/catalog';
import type { SpatialIndex } from './document/spatial';

export function validateDocument(
  project: ScenarioProject,
  catalog: EditorCatalog,
  spatial: SpatialIndex,
): Diagnostic[] {
  const out = [...validateProject(project).diagnostics];
  const diag = (severity: Diagnostic['severity'], code: string, path: string, message: string, target?: string) =>
    out.push({ severity, code, path, message, ...(target ? { target } : {}) });
  // An item stack must name a real item and fit one inventory slot.
  const stack = (s: ItemStack, path: string, target: string) => {
    const item = catalog.item(s.item);
    if (!item) diag('error', 'content.missing', `${path}.item`, `"${s.item}" is not an item in this game.`, target);
    else if (s.count > item.stack)
      diag('error', 'item.count', `${path}.count`, `${item.name} stacks to ${item.stack}; ${s.count} do not fit one slot.`, target);
  };

  const { tilesX, tilesY } = project.world;
  const regions = resolveRegions(project);
  const solidAt = (tx: number, ty: number) => Boolean(spatial.cell(tx, ty)?.solid);
  let spawns = 0;
  project.entities.forEach((e, i) => {
    const path = `entities[${i}]`;
    const entry = catalog.resolve(e.kind, e.ref, e.variant);
    if (!entry && e.kind !== 'spawn') {
      diag('error', 'content.missing', `${path}.ref`, `"${e.ref}" is not in this game's content; it will not be placed.`, e.id);
      return;
    }
    const o = e.overrides;
    if (o && entry) {
      for (const field of Object.keys(o) as (keyof typeof o)[])
        if (!entry.overridable.includes(field))
          diag('error', 'override.unsupported', `${path}.overrides.${field}`, `${entry.name} does not support a ${field} override.`, e.id);
      const max = o.healthMax ?? entry.healthMax;
      if (o.health !== undefined && max !== undefined && o.health > max)
        diag('error', 'override.range', `${path}.overrides.health`, `Initial health ${o.health} exceeds the maximum ${max}.`, e.id);
    }
    if (e.container && entry) {
      if (!entry.containerSlots) diag('error', 'override.unsupported', `${path}.container`, `${entry.name} holds no items.`, e.id);
      else if ((e.container.fixed?.length ?? 0) > entry.containerSlots)
        diag('error', 'container.slots', `${path}.container.fixed`, `${e.container.fixed!.length} fixed items; ${entry.name} has ${entry.containerSlots} slots.`, e.id);
      e.container.fixed?.forEach((s, k) => stack(s, `${path}.container.fixed[${k}]`, e.id));
    }
    e.loadout?.forEach((s, k) => stack(s, `${path}.loadout[${k}]`, e.id));

    const tx = Math.floor(e.x / TILE_SIZE);
    const ty = Math.floor(e.y / TILE_SIZE);
    const who = e.name ?? e.id;
    if (e.kind === 'spawn') {
      spawns++;
      if (solidAt(tx, ty)) diag('warning', 'spawn.blocked', path, `Spawn "${who}" stands on a solid piece.`, e.id);
      if (permissionAt(regions, 'spawn', e.x, e.y) === false)
        diag('error', 'spawn.denied', path, `Spawn "${who}" is inside a region that denies spawning.`, e.id);
      if (tx < 1 || ty < 1 || tx >= tilesX - 1 || ty >= tilesY - 1)
        diag('warning', 'spawn.edge', path, 'Spawns on the outermost tiles are rejected by the server spawn check.', e.id);
    } else if (e.kind === 'npc' && solidAt(tx, ty)) {
      diag('warning', 'npc.blocked', path, `NPC "${who}" stands on a solid piece.`, e.id);
    } else if (e.kind === 'agent' && solidAt(tx, ty)) {
      diag('error', 'agent.blocked', path, `Creature "${who}" stands on a solid piece; the server will not open.`, e.id);
    }
  });
  if (!spawns) diag('info', 'spawn.none', 'entities', 'No player spawn placed: players use the server’s default spawn search.');

  project.lootTables.forEach((t, i) =>
    t.entries.forEach((e, k) => stack({ item: e.item, count: e.max }, `lootTables[${i}].entries[${k}]`, t.id)),
  );

  project.regions.forEach((r, i) => {
    if (!r.spawner) return;
    if (!catalog.resolve('agent', r.spawner.agent))
      diag('error', 'content.missing', `regions[${i}].spawner.agent`, `Creature "${r.spawner.agent}" is not in this game's content.`, r.id);
    // A spawner needs one tile it could use; stop at the first.
    const resolved = regions.find((x) => x.region.id === r.id);
    let room = false;
    if (resolved) {
      const y0 = Math.max(1, Math.floor(resolved.minY / TILE_SIZE));
      const y1 = Math.min(tilesY - 2, Math.floor(resolved.maxY / TILE_SIZE));
      const x0 = Math.max(1, Math.floor(resolved.minX / TILE_SIZE));
      const x1 = Math.min(tilesX - 2, Math.floor(resolved.maxX / TILE_SIZE));
      for (let ty = y0; !room && ty <= y1; ty++)
        for (let tx = x0; !room && tx <= x1; tx++) {
          const cx = tx * TILE_SIZE + TILE_SIZE / 2;
          const cy = ty * TILE_SIZE + TILE_SIZE / 2;
          room = regionContains(resolved, cx, cy) && !solidAt(tx, ty) && permissionAt(regions, 'spawn', cx, cy) !== false;
        }
    }
    if (!room) diag('warning', 'spawner.no-room', `regions[${i}].spawner`, `Spawner "${r.name || r.id}" has no free tile inside its region.`, r.id);
  });

  // Equal priority, overlapping, opposite answers: deny wins, which may not be what was meant.
  const ruled = regions.filter((r) => r.region.permissions);
  for (let a = 0; a < ruled.length; a++)
    for (let b = a + 1; b < ruled.length; b++) {
      const ra = ruled[a]!;
      const rb = ruled[b]!;
      if (ra.region.priority !== rb.region.priority) continue;
      const pa = ra.region.permissions!;
      const pb = rb.region.permissions!;
      const clash = (['build', 'pvp', 'spawn'] as const).some((k) => pa[k] && pb[k] && pa[k] !== pb[k]);
      if (!clash || ra.maxX < rb.minX || rb.maxX < ra.minX || ra.maxY < rb.minY || rb.maxY < ra.minY) continue;
      const index = project.regions.indexOf(rb.region);
      diag(
        'info',
        'region.conflict',
        `regions[${index}].permissions`,
        `"${ra.region.name || ra.region.id}" and "${rb.region.name || rb.region.id}" overlap at the same priority with opposite permissions; where both apply, deny wins.`,
        rb.region.id,
      );
    }
  return out;
}
