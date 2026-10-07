// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The property inspector. With nothing selected it edits the project and world; otherwise
// it edits the selection. Overrides show one of three states per field: inherited (the
// definition's value, shown as placeholder), overridden, or mixed across the selection.
// Every edit applies to all selected records that support it, as one undo step.
import { TILE_SIZE } from '../../../../../shared/typescript/editor-limits';
import {
  EFFECT_STATS,
  GRID_KINDS,
  GROUP_KINDS,
  type EntityOverrides,
  type RegionEffect,
  type RegionShape,
  type ScenarioEntity,
  type ScenarioGroup,
  type ScenarioRegion,
} from '../../../../../shared/typescript/scenario-schema';
import type { OverrideField } from '../catalog/catalog';
import { expandSelection, selectionBounds, transformSelection } from '../document/ops';
import type { EditorContext } from '../editor-context';
import { button, clear, field, h, numberInput, select, withOptional } from './dom';
import {
  containerSection,
  itemDatalist,
  loadoutSection,
  lootTablesSection,
  npcSection,
  spawnerSection,
  type InspectorKit,
} from './population-fields';
import { effectiveRate } from '../../../../../shared/typescript/scenario-regions';

export interface InspectorActions {
  group(kind: ScenarioGroup['kind']): void;
  ungroup(id: string): void;
  saveTemplate(): void;
  remove(): void;
  duplicate(): void;
  replaceWithActive(): void;
  addEffectArea(): void;
  resize(tilesX: number, tilesY: number, removeOutside: boolean): void;
  selectIds(ids: string[]): void;
}

const OVERRIDE_LABELS: Record<OverrideField, string> = {
  healthMax: 'Maximum health',
  health: 'Initial health',
  destructible: 'Destructible',
  doorOpen: 'Door',
};

type Tri = 'inherit' | 'yes' | 'no';

export class InspectorPanel {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly kit: InspectorKit;

  constructor(
    private readonly ctx: EditorContext,
    private readonly actions: InspectorActions,
  ) {
    this.body = h('div', { class: 'we-inspector-body' });
    this.root = h('section', { class: 'we-inspector', 'aria-label': 'Inspector' }, this.body, itemDatalist(ctx));
    this.kit = {
      ctx,
      keyed: (el, key) => this.keyed(el, key),
      onCommit: (el, fn) => this.onCommit(el, fn),
      edit: (label, fn) => this.edit(label, fn),
      section: (title, ...children) => this.section(title, ...children),
      selectIds: (ids) => this.actions.selectIds(ids),
    };
  }

  render(): void {
    // Keep the focused control across re-renders so typing is never interrupted.
    const focused = document.activeElement as HTMLElement | null;
    const focusKey = focused && this.body.contains(focused) ? focused.dataset.key : undefined;
    clear(this.body);
    const ids = this.ctx.selection.values();
    if (!ids.length) this.renderProject();
    else if (ids.length === 1 && this.ctx.store.groups.has(ids[0]!)) this.renderGroup(this.ctx.store.groups.get(ids[0]!)!);
    else if (ids.length === 1 && this.ctx.store.regions.has(ids[0]!)) this.renderRegion(this.ctx.store.regions.get(ids[0]!)!);
    else this.renderEntities(ids);
    if (focusKey) this.body.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus();
  }

  // --- helpers ------------------------------------------------------------------------------

  private keyed<T extends HTMLElement>(el: T, key: string): T {
    el.dataset.key = key;
    return el;
  }

  private onCommit(el: HTMLInputElement | HTMLSelectElement, fn: (value: string) => void): void {
    el.addEventListener('change', () => fn(el.value));
  }

  private section(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
    return h('div', { class: 'we-section' }, h('h3', {}, title), ...children);
  }

  private edit(label: string, fn: () => void): void {
    this.ctx.store.transact(label, fn);
  }

  // --- project / world ----------------------------------------------------------------------

  private renderProject(): void {
    const { store } = this.ctx;
    const world = store.header.world;
    const title = this.keyed(h('input', { type: 'text', value: store.header.title, maxlength: 80 }), 'title');
    this.onCommit(title, (v) => v.trim() && store.setHeader({ title: v.trim() }));

    const w = this.keyed(numberInput(world.tilesX, { min: 10, max: 655 }), 'tilesX');
    const hgt = this.keyed(numberInput(world.tilesY, { min: 10, max: 655 }), 'tilesY');
    const resizeNote = h('div', { class: 'we-note' });
    const apply = button('Apply size', () => this.tryResize(Number(w.value), Number(hgt.value), resizeNote));
    const seed = this.keyed(numberInput(world.seed, { min: 0, max: 4294967295 }), 'seed');
    this.onCommit(seed, (v) => {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) store.setHeader({ world: { ...store.header.world, seed: n } });
    });
    const time = select(world.time, [['day', 'Always day'], ['night', 'Always night'], ['cycle', 'Day/night cycle']] as const);
    this.onCommit(time, (v) => store.setHeader({ world: { ...store.header.world, time: v as typeof world.time } }));
    const pop = (key: keyof typeof world.population, label: string) => {
      const box = h('input', { type: 'checkbox', checked: world.population[key] });
      box.addEventListener('change', () =>
        store.setHeader({ world: { ...store.header.world, population: { ...store.header.world.population, [key]: box.checked } } }),
      );
      return h('label', { class: 'we-check' }, box, label);
    };
    const counts = `${store.entities.size} placements · ${store.groups.size} groups · ${store.regions.size} regions · ${store.templates.size} templates`;
    this.body.append(
      this.section('Project', field('Title', title), h('p', { class: 'we-muted' }, counts), h('p', { class: 'we-muted' }, `Identity ${store.projectId} · saved revision ${store.revision || '—'}`)),
      this.section(
        'World',
        h('div', { class: 'we-row' }, field('Width (tiles)', w), field('Height (tiles)', hgt)),
        apply,
        resizeNote,
        field('Seed', seed, 'Every random stream derives from this.'),
        field('Time of day', time),
      ),
      this.section(
        'Automatic population',
        h('p', { class: 'we-muted' }, 'An authored map holds only what you place. Opt in to procedural content:'),
        pop('resources', 'Generated resources'),
        pop('structures', 'Generated structures'),
        pop('agents', 'Roaming creatures'),
      ),
      lootTablesSection(this.kit),
    );
  }

  private tryResize(tilesX: number, tilesY: number, note: HTMLElement): void {
    clear(note);
    if (![tilesX, tilesY].every((n) => Number.isInteger(n) && n >= 10 && n <= 655)) {
      note.textContent = 'Sizes are 10 to 655 tiles.';
      return;
    }
    const maxX = tilesX * TILE_SIZE;
    const maxY = tilesY * TILE_SIZE;
    const outside = [...this.ctx.store.entities.values()].filter((e) => e.x >= maxX || e.y >= maxY).map((e) => e.id);
    if (!outside.length) {
      this.actions.resize(tilesX, tilesY, false);
      return;
    }
    // Never silently crop: show what is affected and require an explicit choice.
    note.append(
      h('p', {}, `${outside.length} placement(s) lie outside ${tilesX}×${tilesY}. Move them first, or remove them explicitly.`),
      button('Select affected', () => this.actions.selectIds(outside)),
      button(`Remove ${outside.length} and resize`, () => this.actions.resize(tilesX, tilesY, true), { class: 'we-danger' }),
    );
  }

  // --- entities -----------------------------------------------------------------------------

  private renderEntities(ids: string[]): void {
    const { store, catalog } = this.ctx;
    const closure = [...expandSelection(store, ids)];
    const entities = closure.map((id) => store.entities.get(id)).filter((e): e is ScenarioEntity => !!e);
    const names = new Map<string, number>();
    for (const e of entities) {
      const name = catalog.resolve(e.kind, e.ref, e.variant)?.name ?? e.ref;
      names.set(name, (names.get(name) ?? 0) + 1);
    }
    const summary = [...names].slice(0, 4).map(([n, c]) => `${n} ×${c}`).join(', ') + (names.size > 4 ? ', …' : '');
    const actions = h(
      'div',
      { class: 'we-actions' },
      button('Group', () => this.actions.group('group'), { title: 'Ctrl+G' }),
      button('As house', () => this.actions.group('house')),
      button('As city', () => this.actions.group('city')),
      button('Save as template', () => this.actions.saveTemplate()),
      button('Duplicate', () => this.actions.duplicate(), { title: 'Ctrl+D' }),
      this.ctx.activeEntry ? button(`Replace with ${this.ctx.activeEntry.name}`, () => this.actions.replaceWithActive()) : null,
      button('Delete', () => this.actions.remove(), { class: 'we-danger', title: 'Delete' }),
    );
    this.body.append(this.section(`${entities.length} placement(s)`, h('p', { class: 'we-muted' }, summary || 'No placements.'), actions));
    if (!entities.length) return;
    if (entities.length === 1) this.renderSingle(entities[0]!);
    this.renderOverrides(entities);
    const spawns = entities.filter((e) => e.kind === 'spawn');
    if (spawns.length) this.renderSpawnFields(spawns);
    if (spawns.length === 1 && entities.length === 1) this.body.append(loadoutSection(this.kit, spawns[0]!));
    const npcs = entities.filter((e) => e.kind === 'npc');
    if (npcs.length) this.body.append(npcSection(this.kit, npcs));
    if (entities.length === 1 && entities[0]!.kind === 'object') {
      const slots = catalog.resolve('object', entities[0]!.ref, entities[0]!.variant)?.containerSlots;
      if (slots) this.body.append(containerSection(this.kit, entities[0]!, slots));
    }
  }

  private renderSingle(e: ScenarioEntity): void {
    const { store, catalog, spatial } = this.ctx;
    const entry = catalog.resolve(e.kind, e.ref, e.variant);
    const grid = GRID_KINDS.has(e.kind);
    const px = this.keyed(numberInput(grid ? Math.floor(e.x / TILE_SIZE) : e.x, { min: 0 }), 'px');
    const py = this.keyed(numberInput(grid ? Math.floor(e.y / TILE_SIZE) : e.y, { min: 0 }), 'py');
    const move = () => {
      const nx = Number(px.value) * (grid ? TILE_SIZE : 1) + (grid ? TILE_SIZE / 2 : 0);
      const ny = Number(py.value) * (grid ? TILE_SIZE : 1) + (grid ? TILE_SIZE / 2 : 0);
      if (!Number.isInteger(nx) || !Number.isInteger(ny)) return;
      const result = transformSelection(store, spatial, catalog, [e.id], { dx: nx - e.x, dy: ny - e.y, turns: 0, pivot: { x: 0, y: 0 } });
      if (!result.ok) this.ctx.status(result.reason ?? 'Cannot move there.', 'error');
    };
    px.addEventListener('change', move);
    py.addEventListener('change', move);
    const name = this.keyed(h('input', { type: 'text', value: e.name ?? '', maxlength: 80, placeholder: entry?.name ?? e.ref }), 'name');
    this.onCommit(name, (v) => this.edit('Rename', () => store.put('entity', withOptional(store.entities.get(e.id)!, 'name', v.trim() || undefined))));
    const tags = this.keyed(h('input', { type: 'text', value: (e.tags ?? []).join(', '), placeholder: 'comma, separated' }), 'tags');
    this.onCommit(tags, (v) => {
      const list = [...new Set(v.split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 16);
      this.edit('Tags', () => store.put('entity', withOptional(store.entities.get(e.id)!, 'tags', list.length ? list : undefined)));
    });
    let orientation: HTMLElement | null = null;
    if (e.kind === 'object' && entry?.rotatable) {
      const rot = this.keyed(select(String(e.rotation ?? 0), [['0', '0°'], ['1', '90°'], ['2', '180°'], ['3', '270°']] as const), 'rot');
      rot.addEventListener('change', () => {
        const turns = (Number(rot.value) - (e.rotation ?? 0) + 4) % 4;
        const result = transformSelection(store, spatial, catalog, [e.id], { dx: 0, dy: 0, turns, pivot: { x: e.x, y: e.y } });
        if (!result.ok) this.ctx.status(result.reason ?? 'Cannot rotate here.', 'error');
      });
      orientation = field('Rotation', rot);
    } else if (!grid || e.kind === 'resource') {
      const angle = this.keyed(numberInput(e.angle ?? 0, { min: 0, max: 255 }), 'angle');
      this.onCommit(angle, (v) => {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 0 && n <= 255) this.edit('Facing', () => store.put('entity', { ...store.entities.get(e.id)!, angle: n }));
      });
      orientation = field('Facing (0–255)', angle, '64 steps per quarter turn.');
    }
    const parent = e.parent ? store.groups.get(e.parent) : undefined;
    const attached = store.attachedRegions(e.id);
    this.body.append(
      this.section(
        entry?.name ?? e.ref,
        h('p', { class: 'we-muted' }, `${e.kind} · ${e.ref}${e.variant !== undefined ? ` · variant ${e.variant}` : ''} · id ${e.id}`),
        h('div', { class: 'we-row' }, field(grid ? 'Tile X' : 'X', px), field(grid ? 'Tile Y' : 'Y', py)),
        orientation,
        field('Name', name),
        field('Tags', tags),
        parent ? h('p', { class: 'we-muted' }, 'In ', button(parent.name, () => this.actions.selectIds([parent.id]), { class: 'we-link' })) : null,
      ),
      this.section(
        'Effect areas',
        ...attached.map((r) => h('p', {}, button(r.name, () => this.actions.selectIds([r.id]), { class: 'we-link' }), ` · ${describeEffects(r)}`)),
        button('Add effect area', () => this.actions.addEffectArea(), { title: 'A circle that follows this placement; configure it in the inspector.' }),
      ),
    );
  }

  private renderOverrides(entities: ScenarioEntity[]): void {
    const { store, catalog } = this.ctx;
    const objects = entities.filter((e) => e.kind === 'object');
    if (!objects.length) return;
    const entries = objects.map((e) => catalog.resolve(e.kind, e.ref, e.variant));
    const fields = (['healthMax', 'health', 'destructible', 'doorOpen'] as OverrideField[]).filter((f) =>
      entries.some((en) => en?.overridable.includes(f)),
    );
    if (!fields.length) return;
    const supports = (e: ScenarioEntity, f: OverrideField) => catalog.resolve(e.kind, e.ref, e.variant)?.overridable.includes(f) ?? false;
    const apply = (f: OverrideField, value: number | boolean | undefined) =>
      this.edit(value === undefined ? `Reset ${OVERRIDE_LABELS[f]}` : `Set ${OVERRIDE_LABELS[f]}`, () => {
        for (const e of objects) {
          if (!supports(e, f)) continue;
          const current = store.entities.get(e.id)!;
          const overrides: EntityOverrides = { ...current.overrides };
          if (value === undefined) delete overrides[f];
          else (overrides as Record<string, unknown>)[f] = value;
          store.put('entity', withOptional(current, 'overrides', Object.keys(overrides).length ? overrides : undefined));
        }
      });
    const rows: HTMLElement[] = [];
    for (const f of fields) {
      const applicable = objects.filter((e) => supports(e, f));
      const values = new Set(applicable.map((e) => JSON.stringify(e.overrides?.[f])));
      const mixed = values.size > 1;
      const single = mixed ? undefined : applicable[0]?.overrides?.[f];
      const overridden = !mixed && single !== undefined;
      const state = mixed ? 'mixed' : overridden ? 'overridden' : 'inherited';
      const reset = button('Reset', () => apply(f, undefined), { class: 'we-icon', disabled: state === 'inherited', 'aria-label': `Reset ${OVERRIDE_LABELS[f]} to the definition` });
      let control: HTMLElement;
      if (f === 'healthMax' || f === 'health') {
        const defaults = new Set(applicable.map((e) => catalog.resolve(e.kind, e.ref, e.variant)?.healthMax));
        const def = defaults.size === 1 ? [...defaults][0] : undefined;
        const input = this.keyed(
          numberInput(overridden ? (single as number) : undefined, {
            min: 1,
            max: 65535,
            placeholder: mixed ? 'mixed' : def !== undefined ? `${def} (definition)` : 'definition',
          }),
          `ov-${f}`,
        );
        this.onCommit(input, (v) => {
          if (v === '') return apply(f, undefined);
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > 65535) {
            this.ctx.status(`${OVERRIDE_LABELS[f]} must be a whole number from 1 to 65535.`, 'error');
            return;
          }
          apply(f, n);
        });
        control = input;
      } else {
        const labels: Record<Tri, string> =
          f === 'doorOpen'
            ? { inherit: 'Definition (closed)', yes: 'Open', no: 'Closed' }
            : { inherit: 'Definition (yes)', yes: 'Yes', no: 'No — indestructible' };
        const current: Tri = mixed ? 'inherit' : single === undefined ? 'inherit' : single ? 'yes' : 'no';
        const sel = this.keyed(select<Tri | 'mixed'>(mixed ? 'mixed' : current, [
          ...(mixed ? ([['mixed', 'Mixed']] as const) : []),
          ['inherit', labels.inherit],
          ['yes', labels.yes],
          ['no', labels.no],
        ]), `ov-${f}`);
        this.onCommit(sel, (v) => v !== 'mixed' && apply(f, v === 'inherit' ? undefined : v === 'yes'));
        control = sel;
      }
      rows.push(
        h(
          'div',
          { class: `we-override is-${state}` },
          field(`${OVERRIDE_LABELS[f]}${applicable.length < objects.length ? ` (${applicable.length} of ${objects.length})` : ''}`, control),
          h('span', { class: 'we-badge' }, state),
          reset,
        ),
      );
    }
    this.body.append(this.section('Instance properties', h('p', { class: 'we-muted' }, 'Applies to the selected placements only.'), ...rows));
  }

  private renderSpawnFields(spawns: ScenarioEntity[]): void {
    const { store } = this.ctx;
    const teams = new Set(spawns.map((s) => s.team ?? ''));
    const weights = new Set(spawns.map((s) => s.weight ?? 1));
    const team = this.keyed(h('input', { type: 'text', maxlength: 32, value: teams.size === 1 ? [...teams][0]! : '', placeholder: teams.size > 1 ? 'mixed' : 'any team' }), 'team');
    this.onCommit(team, (v) =>
      this.edit('Spawn team', () => {
        for (const s of spawns) store.put('entity', withOptional(store.entities.get(s.id)!, 'team', v.trim() || undefined));
      }),
    );
    const weight = this.keyed(numberInput(weights.size === 1 ? [...weights][0] : undefined, { min: 1, max: 1000, placeholder: 'mixed' }), 'weight');
    this.onCommit(weight, (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 1000) return;
      this.edit('Spawn weight', () => {
        for (const s of spawns) store.put('entity', withOptional(store.entities.get(s.id)!, 'weight', n === 1 ? undefined : n));
      });
    });
    this.body.append(
      this.section('Player spawn', field('Team', team, 'Scenario team key; not a player clan.'), field('Weight', weight, 'Relative chance among safe spawns of the team.')),
    );
  }

  // --- groups -------------------------------------------------------------------------------

  private renderGroup(g: ScenarioGroup): void {
    const { store } = this.ctx;
    const name = this.keyed(h('input', { type: 'text', value: g.name, maxlength: 80 }), 'gname');
    this.onCommit(name, (v) => v.trim() && this.edit('Rename group', () => store.put('group', { ...store.groups.get(g.id)!, name: v.trim() })));
    const kind = this.keyed(select(g.kind, GROUP_KINDS.map((k) => [k, k[0]!.toUpperCase() + k.slice(1)] as const)), 'gkind');
    this.onCommit(kind, (v) => this.edit('Group kind', () => store.put('group', { ...store.groups.get(g.id)!, kind: v as ScenarioGroup['kind'] })));
    const marker = h('input', { type: 'checkbox', checked: !!g.marker });
    marker.addEventListener('change', () =>
      this.edit('Marker', () => store.put('group', withOptional(store.groups.get(g.id)!, 'marker', marker.checked || undefined))),
    );
    const members = store.descendants(g.id);
    const template = g.template ? store.templates.get(g.template.id) : undefined;
    this.body.append(
      this.section(
        g.name,
        h('p', { class: 'we-muted' }, `${members.length} member(s) · pivot ${g.pivot.x}, ${g.pivot.y} · id ${g.id}`),
        field('Name', name),
        field('Kind', kind, 'A label organises content; it adds no gameplay by itself.'),
        h('label', { class: 'we-check' }, marker, 'Show a map marker'),
        g.template
          ? h('p', { class: 'we-muted' }, `From template “${template?.name ?? g.template.id}” rev ${g.template.revision} · ${g.template.linked ? 'linked' : 'independent copy'}`)
          : null,
        h(
          'div',
          { class: 'we-actions' },
          button('Select members', () => this.actions.selectIds(members)),
          button('Ungroup', () => this.actions.ungroup(g.id), { title: 'Ctrl+Shift+G' }),
          button('Save as template', () => this.actions.saveTemplate()),
          button('Duplicate', () => this.actions.duplicate()),
          button('Add region over group', () => this.addGroupRegion(g)),
          button('Delete with contents', () => this.actions.remove(), { class: 'we-danger' }),
        ),
      ),
    );
  }

  private addGroupRegion(g: ScenarioGroup): void {
    const b = selectionBounds(this.ctx.store, [g.id]);
    if (!b) return;
    const id = this.ctx.store.transact('Add group region', () => {
      const regionId = this.ctx.store.allocId('r');
      this.ctx.store.put('region', {
        id: regionId,
        name: `${g.name} area`,
        parent: g.id,
        priority: 0,
        shape: { type: 'rect', x: Math.round(b.x0), y: Math.round(b.y0), w: Math.round(b.x1 - b.x0), h: Math.round(b.y1 - b.y0) },
      });
      return regionId;
    });
    this.actions.selectIds([id]);
  }

  // --- regions ------------------------------------------------------------------------------

  private renderRegion(r: ScenarioRegion): void {
    const { store } = this.ctx;
    const put = (label: string, patch: (cur: ScenarioRegion) => ScenarioRegion) =>
      this.edit(label, () => store.put('region', patch(store.regions.get(r.id)!)));
    const name = this.keyed(h('input', { type: 'text', value: r.name, maxlength: 80 }), 'rname');
    this.onCommit(name, (v) => v.trim() && put('Rename region', (c) => ({ ...c, name: v.trim() })));
    const priority = this.keyed(numberInput(r.priority, { min: -1000, max: 1000 }), 'rprio');
    this.onCommit(priority, (v) => {
      const n = Number(v);
      if (Number.isInteger(n) && n >= -1000 && n <= 1000) put('Region priority', (c) => ({ ...c, priority: n }));
    });
    const shapeFields = this.shapeFields(r, (shape) => put('Region shape', (c) => ({ ...c, shape })));
    const perm = (key: 'build' | 'pvp' | 'spawn', label: string) => {
      const sel = this.keyed(select(r.permissions?.[key] ?? 'inherit', [['inherit', 'Inherit'], ['allow', 'Allow'], ['deny', 'Deny']] as const), `perm-${key}`);
      this.onCommit(sel, (v) =>
        put('Region permission', (c) => {
          const permissions = { ...c.permissions };
          if (v === 'inherit') delete permissions[key];
          else permissions[key] = v as 'allow' | 'deny';
          return withOptional(c, 'permissions', Object.keys(permissions).length ? permissions : undefined);
        }),
      );
      return field(label, sel);
    };
    const effects = (r.effects ?? []).map((effect, i) => this.effectRow(r, effect, i));
    const attached = r.attach ? store.entities.get(r.attach) : undefined;
    const parent = r.parent ? store.groups.get(r.parent) : undefined;
    this.body.append(
      this.section(
        r.name,
        h('p', { class: 'we-muted' }, `${r.shape.type} · id ${r.id}`),
        field('Name', name),
        field('Priority', priority, 'Permissions: higher priority wins; at equal priority, deny wins.'),
        ...shapeFields,
        attached
          ? h('p', { class: 'we-muted' }, 'Follows ', button(attached.name ?? attached.ref, () => this.actions.selectIds([attached.id]), { class: 'we-link' }), ' (offsets are relative).')
          : null,
        parent ? h('p', { class: 'we-muted' }, 'Moves with group ', button(parent.name, () => this.actions.selectIds([parent.id]), { class: 'we-link' })) : null,
      ),
      this.section(
        'Permissions',
        h('p', { class: 'we-muted' }, 'PvP needs both fighters’ positions to allow it. Spawning covers players, creatures and spawners.'),
        perm('build', 'Building'),
        perm('pvp', 'Player combat'),
        perm('spawn', 'Spawning'),
      ),
      this.section(
        'Effects',
        h(
          'p',
          { class: 'we-muted' },
          'Gauge points per minute at full strength, in steps of 6. Inside, the ordinary drift against the effect pauses (a radiation zone contaminates though radiation normally fades). In one stack channel the strongest effect per direction applies; channels add. Radiation: positive contaminates, negative cleanses.',
        ),
        ...effects,
        button('Add effect', () =>
          put('Add effect', (c) => ({ ...c, effects: [...(c.effects ?? []), { stat: 'radiation', perMinute: 30, falloff: 'none' }] })),
        ),
      ),
      spawnerSection(this.kit, r),
      h('div', { class: 'we-actions' }, button('Delete region', () => this.actions.remove(), { class: 'we-danger' })),
    );
  }

  private shapeFields(r: ScenarioRegion, commit: (shape: RegionShape) => void): HTMLElement[] {
    const s = r.shape;
    const num = (key: string, value: number, min: number) => {
      const input = this.keyed(numberInput(value, { min }), `shape-${key}`);
      return input;
    };
    if (s.type === 'polygon') return [h('p', { class: 'we-muted' }, `${s.points.length} points (move or rotate with the canvas tools).`)];
    const inputs: Record<string, HTMLInputElement> =
      s.type === 'circle'
        ? { x: num('x', s.x, -65535), y: num('y', s.y, -65535), r: num('r', s.r, 1) }
        : { x: num('x', s.x, -65535), y: num('y', s.y, -65535), w: num('w', s.w, 1), h: num('h', s.h, 1) };
    const read = (): RegionShape | undefined => {
      const v = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, Number(el.value)]));
      if (Object.values(v).some((n) => !Number.isInteger(n))) return undefined;
      return s.type === 'circle'
        ? v.r! >= 1 ? { type: 'circle', x: v.x!, y: v.y!, r: v.r! } : undefined
        : v.w! >= 1 && v.h! >= 1 ? { type: 'rect', x: v.x!, y: v.y!, w: v.w!, h: v.h! } : undefined;
    };
    for (const el of Object.values(inputs))
      el.addEventListener('change', () => {
        const shape = read();
        if (shape) commit(shape);
      });
    const label = r.attach ? ' (offset)' : '';
    return [
      h('div', { class: 'we-row' }, field(`X${label}`, inputs.x!), field(`Y${label}`, inputs.y!)),
      s.type === 'circle'
        ? field('Radius (units)', inputs.r!, `${(s.r / TILE_SIZE).toFixed(1)} tiles`)
        : h('div', { class: 'we-row' }, field('Width', inputs.w!), field('Height', inputs.h!)),
    ];
  }

  private effectRow(r: ScenarioRegion, effect: RegionEffect, index: number): HTMLElement {
    const { store } = this.ctx;
    const update = (patch: Partial<RegionEffect> | null) =>
      this.edit(patch ? 'Edit effect' : 'Remove effect', () => {
        const cur = store.regions.get(r.id)!;
        const effects = [...(cur.effects ?? [])];
        if (patch) {
          const next = { ...effects[index]!, ...patch };
          if (!next.channel) delete next.channel;
          if (!next.stacking || next.stacking === 'strongest') delete next.stacking;
          effects[index] = next;
        } else effects.splice(index, 1);
        store.put('region', withOptional(cur, 'effects', effects.length ? effects : undefined));
      });
    const stat = this.keyed(select(effect.stat, EFFECT_STATS.map((s) => [s, s[0]!.toUpperCase() + s.slice(1)] as const)), `fx${index}-stat`);
    this.onCommit(stat, (v) => update({ stat: v as RegionEffect['stat'] }));
    const rate = this.keyed(numberInput(effect.perMinute, { min: -6000, max: 6000 }), `fx${index}-rate`);
    this.onCommit(rate, (v) => {
      const n = Number(v);
      if (Number.isInteger(n) && n >= -6000 && n <= 6000) update({ perMinute: n });
    });
    const polygon = r.shape.type === 'polygon';
    const falloff = this.keyed(
      select(effect.falloff, polygon ? ([['none', 'Even']] as const) : ([['none', 'Even'], ['linear', 'Fades to edge']] as const)),
      `fx${index}-falloff`,
    );
    this.onCommit(falloff, (v) => update({ falloff: v as RegionEffect['falloff'] }));
    const channel = this.keyed(h('input', { type: 'text', maxlength: 32, value: effect.channel ?? '', placeholder: effect.stat }), `fx${index}-channel`);
    this.onCommit(channel, (v) => update({ channel: v.trim() || undefined }));
    const stacking = this.keyed(select(effect.stacking ?? 'strongest', [['strongest', 'Strongest wins'], ['additive', 'Adds up']] as const), `fx${index}-stack`);
    this.onCommit(stacking, (v) => update({ stacking: v as RegionEffect['stacking'] }));
    return h(
      'div',
      { class: 'we-effect' },
      h(
        'div',
        { class: 'we-row' },
        field('Stat', stat),
        field('Per minute', rate, effectiveRate(effect.perMinute) !== effect.perMinute ? `runs at ${effectiveRate(effect.perMinute)}` : undefined),
      ),
      polygon ? h('small', { class: 'we-muted' }, 'Polygons apply effects evenly.') : null,
      h('div', { class: 'we-row' }, field('Falloff', falloff), field('Channel', channel)),
      field('Stacking', stacking),
      button('Remove effect', () => update(null), { class: 'we-link' }),
    );
  }
}

export function describeEffects(r: ScenarioRegion): string {
  const fx = r.effects?.map((e) => `${e.stat} ${e.perMinute > 0 ? '+' : ''}${e.perMinute}/min`) ?? [];
  const perms = Object.entries(r.permissions ?? {}).map(([k, v]) => `${k} ${v}`);
  const spawner = r.spawner ? [`spawns ${r.spawner.agent} ×${r.spawner.maxAlive}`] : [];
  return [...fx, ...perms, ...spawner].join(', ') || 'no effects yet';
}

export { withOptional };
