// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Feeds document entities to the game's own renderer. Each placement is encoded exactly as
// the server encodes it on the wire (Object/Resource::buildUpdate) and loaded into a private
// WorldState, so autotiling, frames, layering and day/night art are the game's -- not an
// editor approximation. Only chunks around the viewport are loaded; the set is rebuilt when
// the view crosses a chunk boundary or the document changes.
import type { ContentStore } from '../../content/store';
import { EntityType } from '../../world/entity-types';
import { newPlayerInfo, WorldState } from '../../world/world-state';
import type { UnitRecord } from '../../net/events';
import type { ScenarioEntity } from '../../../../../shared/typescript/scenario-schema';
import type { CatalogEntry, EditorCatalog, EditorLayer } from '../catalog/catalog';
import { SpatialIndex } from '../document/spatial';
import type { DocumentStore } from '../document/store';

/** The walkthrough avatar's player id in the private world. */
export const PREVIEW_PID = 1;

/** Wire encoding of one placement, mirroring the server's buildUpdate for its kind. */
export function unitRecordFor(
  e: ScenarioEntity,
  entry: CatalogEntry | undefined,
  content: ContentStore,
  id: number,
  doorOpen = e.overrides?.doorOpen ?? false,
): UnitRecord | undefined {
  const base = { pid: 0, id, rotation: 0, startX: e.x, startY: e.y, endX: e.x, endY: e.y };
  switch (e.kind) {
    case 'object': {
      if (!entry || entry.itemId === undefined) return undefined;
      let state = 1;
      const subtype = e.variant ?? entry.subtype ?? 0;
      state |= (subtype & 0x3f) << 5;
      if (doorOpen) state |= entry.ref === 'automatic_door' ? 128 : 16;
      const extra = ((e.rotation ?? 0) & 3) << 5 | ((entry.itemId & 0x1ff) << 7);
      return { ...base, type: entry.protocolType, state, extra };
    }
    case 'resource': {
      if (!entry || !content.has('resources')) return undefined;
      const res = content.byKey('resources', e.ref);
      if (!res) return undefined;
      const extra = ((res.id & 0x1f) << 5) | (((e.variant ?? 0) & 7) << 10);
      return { ...base, type: entry.protocolType, state: 1, rotation: e.angle ?? 0, extra };
    }
    case 'agent': {
      const agent = content.has('agents') ? content.byKey('agents', e.ref) : undefined;
      if (!agent) return undefined;
      return { ...base, type: EntityType.AI, state: 1, rotation: e.angle ?? 0, extra: agent.id & 15 };
    }
    case 'npc': {
      const npc = content.has('npcs') ? content.byKey('npcs', e.ref) : undefined;
      if (!npc) return undefined;
      return { ...base, type: EntityType.NPC, state: 1, rotation: e.angle ?? 0, extra: npc.id };
    }
    default:
      return undefined; // spawns are editor markers
  }
}

export class SceneWorld {
  readonly world = new WorldState();
  private readonly numeric = new Map<string, number>();
  private nextNumeric = 1;
  private builtSpan = '';
  private builtVersion = -1;
  private builtHidden = '';
  /** Doc entities currently loaded. */
  readonly loaded = new Set<string>();
  /** Walkthrough-only door states (id -> open); never written to the document. */
  previewDoors: ReadonlyMap<string, boolean> | null = null;

  constructor(
    private readonly store: DocumentStore,
    private readonly spatial: SpatialIndex,
    private readonly catalog: EditorCatalog,
    private readonly content: ContentStore,
  ) {}

  /** Loads the chunks around a world rectangle; cheap when nothing relevant changed. */
  sync(x0: number, y0: number, x1: number, y1: number, hidden: ReadonlySet<EditorLayer>): void {
    const { tilesX, tilesY } = this.store.header.world;
    this.world.tilesX = tilesX;
    this.world.tilesY = tilesY;
    const span = SpatialIndex.chunkSpan(x0, y0, x1, y1);
    const hiddenKey = [...hidden].sort().join(',');
    if (span === this.builtSpan && this.store.version === this.builtVersion && hiddenKey === this.builtHidden)
      return;
    this.builtSpan = span;
    this.builtVersion = this.store.version;
    this.builtHidden = hiddenKey;

    const avatar = this.world.entities.get(PREVIEW_PID, 0);
    const records: UnitRecord[] = [];
    this.loaded.clear();
    for (const id of this.spatial.query(x0, y0, x1, y1)) {
      const e = this.store.entities.get(id);
      if (!e) continue;
      const entry = this.catalog.resolve(e.kind, e.ref, e.variant);
      if (entry && hidden.has(entry.layer)) continue;
      let n = this.numeric.get(id);
      if (n === undefined) this.numeric.set(id, (n = this.nextNumeric++));
      const record = unitRecordFor(e, entry, this.content, n, this.previewDoors?.get(id) ?? e.overrides?.doorOpen ?? false);
      if (record) records.push(record);
      this.loaded.add(id);
    }
    this.world.entities.processUnits(records, true);
    if (avatar) this.restoreAvatar(avatar.x, avatar.y, avatar.angle);
  }

  /** Forces the next sync to rebuild (after content or layer changes). */
  invalidate(): void {
    this.builtSpan = '';
  }

  // --- walkthrough avatar -------------------------------------------------------------------

  placeAvatar(x: number, y: number, angle: number): void {
    this.world.ownGuid = PREVIEW_PID;
    if (!this.world.players.has(PREVIEW_PID))
      this.world.players.set(PREVIEW_PID, newPlayerInfo(PREVIEW_PID, 'Preview'));
    this.restoreAvatar(x, y, angle);
  }

  private restoreAvatar(x: number, y: number, angle: number): void {
    const rotation = Math.round((((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 255);
    this.world.entities.processUnits([
      { pid: PREVIEW_PID, id: 0, type: EntityType.PLAYER, rotation, state: 1, startX: x, startY: y, endX: x, endY: y, extra: 0 },
    ]);
    const avatar = this.world.entities.get(PREVIEW_PID, 0);
    if (avatar) {
      avatar.x = avatar.rx = avatar.nx = x;
      avatar.y = avatar.ry = avatar.ny = y;
      avatar.angle = avatar.nangle = angle;
    }
  }

  /** Drops the avatar without a death animation: the whole private world is rebuilt. */
  removeAvatar(): void {
    this.world.entities.clear();
    this.world.ownGuid = -1;
    this.world.players.delete(PREVIEW_PID);
    this.invalidate();
  }
}
