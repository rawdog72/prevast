// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Inspector sections for what a scenario populates: NPC wander, spawn loadouts, container
// contents, region creature spawners and the project's loot tables. Rules and units match the
// server (scenario_population.h): a loadout replaces the starting kit; a container's fixed
// entry k owns slot k and its loot table fills the empty slots after those; a refill only
// fills empty slots, so a player's deposit is never replaced.
import { EDITOR_LIMITS } from '../../../../../shared/typescript/editor-limits';
import type {
  ContainerContents,
  ItemStack,
  LootEntry,
  LootTable,
  RegionSpawner,
  ScenarioEntity,
  ScenarioRegion,
} from '../../../../../shared/typescript/scenario-schema';
import type { EditorContext } from '../editor-context';
import { button, field, h, numberInput, select, withOptional } from './dom';

const L = EDITOR_LIMITS.project;
const ITEM_LIST_ID = 'we-items';

/** What a section needs from the inspector that hosts it. */
export interface InspectorKit {
  ctx: EditorContext;
  keyed<T extends HTMLElement>(el: T, key: string): T;
  onCommit(el: HTMLInputElement | HTMLSelectElement, fn: (value: string) => void): void;
  edit(label: string, fn: () => void): void;
  section(title: string, ...children: (HTMLElement | null)[]): HTMLElement;
  selectIds(ids: string[]): void;
}

const int = (v: string, lo: number, hi: number): number | undefined => {
  const n = Number(v);
  return v.trim() !== '' && Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
};

/** The shared `<datalist>` item inputs point at; one per inspector. */
export function itemDatalist(ctx: EditorContext): HTMLDataListElement {
  return h('datalist', { id: ITEM_LIST_ID }, ...ctx.catalog.items.map((i) => h('option', { value: i.key }, i.name)));
}

/** Rows of item + count with add/remove; commits the whole list on every change. */
function stackEditor(kit: InspectorKit, key: string, stacks: readonly ItemStack[], max: number, commit: (next: ItemStack[]) => void): HTMLElement {
  const { catalog } = kit.ctx;
  const rows = stacks.map((s, i) => {
    const item = kit.keyed(h('input', { type: 'text', list: ITEM_LIST_ID, value: s.item, maxlength: 64, 'aria-label': 'Item' }), `${key}-item${i}`);
    const known = catalog.item(s.item);
    const count = kit.keyed(numberInput(s.count, { min: 1, max: known?.stack ?? 255 }), `${key}-count${i}`);
    const replace = (patch: Partial<ItemStack>) => commit(stacks.map((x, k) => (k === i ? { ...x, ...patch } : { ...x })));
    kit.onCommit(item, (v) => v.trim() && replace({ item: v.trim() }));
    kit.onCommit(count, (v) => {
      const n = int(v, 1, 255);
      if (n !== undefined) replace({ count: n });
    });
    return h(
      'div',
      { class: 'we-stack' },
      item,
      count,
      button('×', () => commit(stacks.filter((_, k) => k !== i).map((x) => ({ ...x }))), { class: 'we-icon', 'aria-label': 'Remove item' }),
      h('small', { class: known ? 'we-muted' : 'we-warn' }, known ? `${known.name} · stacks to ${known.stack}` : 'unknown item'),
    );
  });
  return h(
    'div',
    {},
    ...rows,
    stacks.length < max
      ? button('Add item', () => commit([...stacks.map((x) => ({ ...x })), { item: catalog.items[0]?.key ?? 'wood', count: 1 }]))
      : h('p', { class: 'we-muted' }, `At most ${max}.`),
  );
}

// --- NPCs -----------------------------------------------------------------------------------

export function npcSection(kit: InspectorKit, npcs: ScenarioEntity[]): HTMLElement {
  const { store } = kit.ctx;
  const values = new Set(npcs.map((n) => n.wander));
  const single = values.size === 1 ? [...values][0] : undefined;
  const wander = kit.keyed(numberInput(single, { min: 0, max: 20, placeholder: values.size > 1 ? 'mixed' : 'definition' }), 'npc-wander');
  kit.onCommit(wander, (v) => {
    const n = v.trim() === '' ? undefined : int(v, 0, 20);
    if (v.trim() !== '' && n === undefined) return kit.ctx.status('Wander is 0 to 20 tiles.', 'error');
    kit.edit('NPC wander', () => {
      for (const npc of npcs) store.put('entity', withOptional(store.entities.get(npc.id)!, 'wander', n));
    });
  });
  return kit.section(
    npcs.length > 1 ? `${npcs.length} NPCs` : 'NPC',
    field('Wander (tiles)', wander, 'How far from its placement it strolls; 0 stays put, empty uses the definition. Shop stock follows the placement: moving keeps it, duplicating starts fresh.'),
  );
}

// --- spawns ---------------------------------------------------------------------------------

export function loadoutSection(kit: InspectorKit, spawn: ScenarioEntity): HTMLElement {
  const { store } = kit.ctx;
  const put = (label: string, loadout: ItemStack[] | undefined) =>
    kit.edit(label, () => store.put('entity', withOptional(store.entities.get(spawn.id)!, 'loadout', loadout)));
  const custom = spawn.loadout !== undefined;
  const mode = kit.keyed(select(custom ? 'custom' : 'kit', [['kit', 'Starting kit'], ['custom', 'Custom loadout']] as const), 'loadout-mode');
  kit.onCommit(mode, (v) => put('Spawn loadout', v === 'custom' ? [] : undefined));
  return kit.section(
    'Loadout',
    field('Players start with', mode, custom ? 'Exactly these items, instead of the kit.' : 'The server’s usual starting kit.'),
    custom ? stackEditor(kit, 'loadout', spawn.loadout!, L.maxLoadoutItems, (next) => put('Edit loadout', next)) : null,
  );
}

// --- containers -----------------------------------------------------------------------------

export function containerSection(kit: InspectorKit, e: ScenarioEntity, slots: number): HTMLElement {
  const { store } = kit.ctx;
  const put = (label: string, container: ContainerContents | undefined) =>
    kit.edit(label, () => store.put('entity', withOptional(store.entities.get(e.id)!, 'container', container)));
  const c = e.container;
  const patch = (label: string, fn: (cur: ContainerContents) => ContainerContents) => {
    const next = fn({ ...(store.entities.get(e.id)!.container ?? {}) });
    for (const k of Object.keys(next) as (keyof ContainerContents)[]) if (next[k] === undefined) delete next[k];
    put(label, next);
  };
  const mode = kit.keyed(select(c ? 'authored' : 'default', [['default', 'Type’s default contents'], ['authored', 'Authored contents']] as const), 'container-mode');
  kit.onCommit(mode, (v) => put('Container contents', v === 'authored' ? {} : undefined));
  if (!c) return kit.section('Contents', field('Holds', mode, `${slots} slots.`));

  const tables = [...store.lootTables.values()];
  const loot = kit.keyed(
    select(c.loot ?? '', [['', 'No loot table'] as const, ...tables.map((t) => [t.id, t.name || t.id] as const)]),
    'container-loot',
  );
  kit.onCommit(loot, (v) => patch('Container loot', (cur) => ({ ...cur, loot: v || undefined })));
  const refill = kit.keyed(numberInput(c.refillSeconds, { min: 10, max: 86400, placeholder: 'never' }), 'container-refill');
  kit.onCommit(refill, (v) => {
    const n = v.trim() === '' ? undefined : int(v, 10, 86400);
    if (v.trim() !== '' && n === undefined) return kit.ctx.status('Refill is 10 to 86400 seconds, or empty for never.', 'error');
    patch('Container refill', (cur) => ({ ...cur, refillSeconds: n }));
  });
  return kit.section(
    'Contents',
    field('Holds', mode, `${slots} slots. Fixed item k fills slot k; the loot table fills the empty slots after them.`),
    h('p', { class: 'we-field-label' }, 'Fixed items'),
    stackEditor(kit, 'fixed', c.fixed ?? [], Math.min(slots, L.maxLootEntries), (next) =>
      patch('Container items', (cur) => ({ ...cur, fixed: next.length ? next : undefined })),
    ),
    field('Loot table', loot, tables.length ? undefined : 'Add loot tables in the project inspector (click empty map).'),
    field('Refill every (seconds)', refill, 'Fills empty slots only; what players put in stays.'),
  );
}

// --- spawners -------------------------------------------------------------------------------

export function spawnerSection(kit: InspectorKit, r: ScenarioRegion): HTMLElement {
  const { store, catalog } = kit.ctx;
  const put = (label: string, spawner: RegionSpawner | undefined) =>
    kit.edit(label, () => store.put('region', withOptional(store.regions.get(r.id)!, 'spawner', spawner)));
  const s = r.spawner;
  const creatures = catalog.entries.filter((e) => e.kind === 'agent');
  if (!s)
    return kit.section(
      'Creature spawner',
      h('p', { class: 'we-muted' }, 'Keep a creature population inside this region.'),
      button('Add spawner', () =>
        put('Add spawner', { agent: creatures[0]?.ref ?? 'normal_ghoul', maxAlive: 4, batch: 2, everySeconds: 30 }),
      ),
    );
  const patch = (label: string, next: Partial<RegionSpawner>) => {
    const merged: RegionSpawner = { ...store.regions.get(r.id)!.spawner!, ...next };
    if (merged.total === undefined) delete merged.total;
    if (!merged.startDelay) delete merged.startDelay;
    put(label, merged);
  };
  const num = (key: keyof RegionSpawner, value: number | undefined, lo: number, hi: number, label: string, optional = false) => {
    const input = kit.keyed(numberInput(value, { min: lo, max: hi, placeholder: optional ? 'none' : undefined }), `spawner-${key}`);
    kit.onCommit(input, (v) => {
      const n = optional && v.trim() === '' ? undefined : int(v, lo, hi);
      if (n === undefined && !(optional && v.trim() === '')) return kit.ctx.status(`${label} is ${lo} to ${hi}.`, 'error');
      patch(`Spawner ${label.toLowerCase()}`, { [key]: n });
    });
    return input;
  };
  const agent = kit.keyed(select(s.agent, creatures.map((c) => [c.ref, c.name] as const)), 'spawner-agent');
  kit.onCommit(agent, (v) => patch('Spawner creature', { agent: v }));
  return kit.section(
    'Creature spawner',
    field('Creature', agent),
    h(
      'div',
      { class: 'we-row' },
      field('Alive at most', num('maxAlive', s.maxAlive, 1, L.maxSpawnerAlive, 'Alive at most')),
      field('Per wave', num('batch', s.batch, 1, 16, 'Per wave')),
    ),
    h(
      'div',
      { class: 'we-row' },
      field('Every (s)', num('everySeconds', s.everySeconds, 1, 3600, 'Every')),
      field('First after (s)', num('startDelay', s.startDelay ?? 0, 0, 3600, 'First after')),
    ),
    field('Total, then stop', num('total', s.total, 1, 100000, 'Total', true), 'Empty keeps spawning forever. Points must be free ground the region allows spawning on.'),
    button('Remove spawner', () => put('Remove spawner', undefined), { class: 'we-link' }),
  );
}

// --- loot tables ----------------------------------------------------------------------------

// Which tables are unfolded, across re-renders.
const openTables = new Set<string>();

function lootUsers(kit: InspectorKit, id: string): string[] {
  return [...kit.ctx.store.entities.values()].filter((e) => e.container?.loot === id).map((e) => e.id);
}

export function lootTablesSection(kit: InspectorKit): HTMLElement {
  const { store } = kit.ctx;
  const tables = [...store.lootTables.values()];
  const add = () => {
    const id = store.transact('Add loot table', () => {
      const tableId = store.allocId('l');
      store.put('loot', {
        id: tableId,
        name: `Loot ${tables.length + 1}`,
        mode: 'weighted',
        rolls: 1,
        empty: 0,
        entries: [{ item: kit.ctx.catalog.items[0]?.key ?? 'wood', min: 1, max: 1, weight: 1 }],
      });
      return tableId;
    });
    openTables.add(id);
  };
  return kit.section(
    'Loot tables',
    h('p', { class: 'we-muted' }, 'Weighted: each roll picks one entry by weight, or nothing by the empty weight. Independent: every entry rolls its own chance (of 10000). Rolls repeat for the same seed and chest.'),
    ...tables.map((t) => lootTableEditor(kit, t)),
    tables.length < L.maxLootTables ? button('Add loot table', add) : null,
  );
}

function lootTableEditor(kit: InspectorKit, t: LootTable): HTMLElement {
  const { store } = kit.ctx;
  const put = (label: string, next: LootTable) => kit.edit(label, () => store.put('loot', next));
  const current = () => store.lootTables.get(t.id)!;
  const name = kit.keyed(h('input', { type: 'text', value: t.name, maxlength: 80 }), `loot-${t.id}-name`);
  kit.onCommit(name, (v) => put('Rename loot table', { ...current(), name: v.trim() }));
  const mode = kit.keyed(select(t.mode, [['weighted', 'Weighted picks'], ['independent', 'Independent chances']] as const), `loot-${t.id}-mode`);
  kit.onCommit(mode, (v) => {
    const { id, name: n, entries } = current();
    put('Loot table mode', v === 'weighted' ? { id, name: n, mode: 'weighted', rolls: 1, empty: 0, entries } : { id, name: n, mode: 'independent', entries });
  });
  const settings: HTMLElement[] = [];
  if (t.mode === 'weighted') {
    const rolls = kit.keyed(numberInput(t.rolls, { min: 1, max: 16 }), `loot-${t.id}-rolls`);
    kit.onCommit(rolls, (v) => {
      const n = int(v, 1, 16);
      const cur = current();
      if (n !== undefined && cur.mode === 'weighted') put('Loot rolls', { ...cur, rolls: n });
    });
    const empty = kit.keyed(numberInput(t.empty, { min: 0, max: 10000 }), `loot-${t.id}-empty`);
    kit.onCommit(empty, (v) => {
      const n = int(v, 0, 10000);
      const cur = current();
      if (n !== undefined && cur.mode === 'weighted') put('Loot empty weight', { ...cur, empty: n });
    });
    settings.push(h('div', { class: 'we-row' }, field('Rolls', rolls), field('Nothing (weight)', empty)));
  }
  const setEntries = (label: string, entries: LootEntry[]) => put(label, { ...current(), entries });
  const entryRows = t.entries.map((e, i) => {
    const replace = (patch: Partial<LootEntry>) => setEntries('Edit loot entry', current().entries.map((x, k) => (k === i ? { ...x, ...patch } : x)));
    const item = kit.keyed(h('input', { type: 'text', list: ITEM_LIST_ID, value: e.item, maxlength: 64, 'aria-label': 'Item' }), `loot-${t.id}-item${i}`);
    kit.onCommit(item, (v) => v.trim() && replace({ item: v.trim() }));
    const bound = (key: 'min' | 'max' | 'weight', lo: number, hi: number) => {
      const input = kit.keyed(numberInput(e[key], { min: lo, max: hi }), `loot-${t.id}-${key}${i}`);
      kit.onCommit(input, (v) => {
        const n = int(v, lo, hi);
        if (n !== undefined) replace({ [key]: n });
      });
      return input;
    };
    const known = kit.ctx.catalog.item(e.item);
    return h(
      'div',
      { class: 'we-effect' },
      field('Item', item, known ? known.name : 'unknown item'),
      h('div', { class: 'we-row' }, field('Min', bound('min', 1, 255)), field('Max', bound('max', 1, 255)), field(t.mode === 'weighted' ? 'Weight' : 'Chance /10000', bound('weight', 1, 10000))),
      t.entries.length > 1 ? button('Remove entry', () => setEntries('Remove loot entry', current().entries.filter((_, k) => k !== i)), { class: 'we-link' }) : null,
    );
  });
  const remove = () => {
    const users = lootUsers(kit, t.id);
    if (users.length) {
      kit.ctx.status(`${users.length} container(s) use “${t.name || t.id}”; point them elsewhere first.`, 'error');
      kit.selectIds(users);
      return;
    }
    openTables.delete(t.id);
    kit.edit('Delete loot table', () => store.remove('loot', t.id));
  };
  const users = lootUsers(kit, t.id).length;
  const details = h(
    'details',
    { class: 'we-loot', open: openTables.has(t.id) },
    h('summary', {}, `${t.name || t.id} · ${t.mode} · ${t.entries.length} entr${t.entries.length === 1 ? 'y' : 'ies'} · ${users} container(s)`),
    field('Name', name),
    field('Mode', mode),
    ...settings,
    ...entryRows,
    h(
      'div',
      { class: 'we-actions' },
      t.entries.length < L.maxLootEntries
        ? button('Add entry', () => setEntries('Add loot entry', [...current().entries, { item: kit.ctx.catalog.items[0]?.key ?? 'wood', min: 1, max: 1, weight: t.mode === 'weighted' ? 1 : 5000 }]))
        : null,
      users ? button('Select containers', () => kit.selectIds(lootUsers(kit, t.id))) : null,
      button('Delete table', remove, { class: 'we-danger' }),
    ),
  );
  details.addEventListener('toggle', () => (details.open ? openTables.add(t.id) : openTables.delete(t.id)));
  return details;
}
