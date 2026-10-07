// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Object/group tree, layer toggles and the validation list: the right-hand tabs besides the
// inspector. The tree expands lazily and caps long lists so a 100k-piece project stays cheap.
import {
  hasErrors,
  type Diagnostic,
} from '../../../../../shared/typescript/scenario-schema';
import { EDITOR_LAYERS, LAYER_LABELS, type EditorLayer } from '../catalog/catalog';
import type { EditorContext } from '../editor-context';
import { button, clear, h } from './dom';

const PAGE = 200;

export class OutlinePanel {
  readonly root: HTMLElement;
  private readonly tree: HTMLElement;
  private readonly expanded = new Set<string>();
  private readonly shown = new Map<string, number>();

  constructor(
    private readonly ctx: EditorContext,
    private readonly select: (ids: string[], additive: boolean) => void,
  ) {
    this.tree = h('div', { class: 'we-tree', role: 'tree', 'aria-label': 'Groups and placements' });
    this.root = h('section', { class: 'we-outline', 'aria-label': 'Outline' }, this.tree);
  }

  render(): void {
    clear(this.tree);
    const { store } = this.ctx;
    const topGroups = [...store.groups.values()].filter((g) => !g.parent).sort((a, b) => a.name.localeCompare(b.name));
    for (const g of topGroups) this.tree.append(this.groupNode(g.id, 0));
    const loose = [...store.entities.values()].filter((e) => !e.parent).map((e) => e.id);
    const regions = [...store.regions.values()].filter((r) => !r.parent && !r.attach).map((r) => r.id);
    if (regions.length) this.tree.append(this.bucket('regions', `Regions (${regions.length})`, regions, 0));
    if (loose.length) this.tree.append(this.bucket('loose', `Ungrouped (${loose.length})`, loose, 0));
    if (!topGroups.length && !loose.length && !regions.length) this.tree.append(h('p', { class: 'we-empty' }, 'The map is empty.'));
  }

  private label(id: string): string {
    const { store, catalog } = this.ctx;
    const e = store.entities.get(id);
    if (e) {
      const entry = catalog.resolve(e.kind, e.ref, e.variant);
      return `${e.name ?? entry?.name ?? e.ref}${e.overrides ? ' •' : ''}`;
    }
    const g = store.groups.get(id);
    if (g) return `${g.kind === 'city' ? '🏙 ' : g.kind === 'house' ? '🏠 ' : '▣ '}${g.name}`;
    const r = store.regions.get(id);
    return r ? `◌ ${r.name}` : id;
  }

  private row(id: string, depth: number, toggle?: HTMLElement): HTMLElement {
    const selected = this.ctx.selection.has(id);
    const row = h(
      'div',
      { class: `we-tree-row${selected ? ' is-selected' : ''}`, role: 'treeitem', 'aria-selected': String(selected), tabindex: 0, style: `padding-left:${8 + depth * 14}px` },
      toggle ?? h('span', { class: 'we-tree-toggle' }),
      h('span', {}, this.label(id)),
    );
    const act = (ev: MouseEvent | KeyboardEvent) => this.select([id], ev.shiftKey || ev.ctrlKey || ev.metaKey);
    row.addEventListener('click', act);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        act(ev);
      }
    });
    return row;
  }

  private toggle(key: string): HTMLElement {
    const open = this.expanded.has(key);
    const t = button(open ? '▾' : '▸', () => {
      if (open) this.expanded.delete(key);
      else this.expanded.add(key);
      this.render();
    }, { class: 'we-tree-toggle', 'aria-label': open ? 'Collapse' : 'Expand', 'aria-expanded': String(open) });
    t.addEventListener('click', (ev) => ev.stopPropagation());
    return t;
  }

  private groupNode(id: string, depth: number): HTMLElement {
    const node = h('div', { role: 'group' }, this.row(id, depth, this.toggle(id)));
    if (!this.expanded.has(id)) return node;
    const children = [...this.ctx.store.childrenOf(id)];
    const groups = children.filter((c) => this.ctx.store.groups.has(c));
    const rest = children.filter((c) => !this.ctx.store.groups.has(c));
    for (const g of groups) node.append(this.groupNode(g, depth + 1));
    this.appendPaged(node, id, rest, depth + 1);
    return node;
  }

  private bucket(key: string, title: string, ids: string[], depth: number): HTMLElement {
    const node = h(
      'div',
      { role: 'group' },
      h('div', { class: 'we-tree-row we-tree-bucket', style: `padding-left:${8 + depth * 14}px` }, this.toggle(key), h('span', {}, title)),
    );
    if (this.expanded.has(key)) this.appendPaged(node, key, ids, depth + 1);
    return node;
  }

  private appendPaged(node: HTMLElement, key: string, ids: string[], depth: number): void {
    const limit = this.shown.get(key) ?? PAGE;
    for (const id of ids.slice(0, limit)) node.append(this.row(id, depth));
    if (ids.length > limit)
      node.append(
        button(`Show ${Math.min(PAGE, ids.length - limit)} more of ${ids.length - limit}`, () => {
          this.shown.set(key, limit + PAGE);
          this.render();
        }, { class: 'we-link', style: `margin-left:${8 + depth * 14}px` }),
      );
  }
}

export class LayersPanel {
  readonly root: HTMLElement;

  constructor(
    private readonly ctx: EditorContext,
    private readonly changed: () => void,
  ) {
    this.root = h('section', { class: 'we-layers', 'aria-label': 'Layers' });
  }

  render(): void {
    clear(this.root);
    this.root.append(h('p', { class: 'we-muted' }, 'Hiding or locking a layer affects editing only. Everything still runs on a server.'));
    for (const layer of EDITOR_LAYERS) this.root.append(this.row(layer));
  }

  private row(layer: EditorLayer): HTMLElement {
    const visible = h('input', { type: 'checkbox', checked: !this.ctx.hiddenLayers.has(layer), 'aria-label': `Show ${LAYER_LABELS[layer]}` });
    visible.addEventListener('change', () => {
      if (visible.checked) this.ctx.hiddenLayers.delete(layer);
      else this.ctx.hiddenLayers.add(layer);
      this.changed();
    });
    const locked = h('input', { type: 'checkbox', checked: this.ctx.lockedLayers.has(layer), 'aria-label': `Lock ${LAYER_LABELS[layer]}` });
    locked.addEventListener('change', () => {
      if (locked.checked) this.ctx.lockedLayers.add(layer);
      else this.ctx.lockedLayers.delete(layer);
      this.changed();
    });
    return h(
      'div',
      { class: 'we-layer' },
      h('span', {}, LAYER_LABELS[layer]),
      h('label', { class: 'we-check' }, visible, 'Show'),
      h('label', { class: 'we-check' }, locked, 'Lock'),
    );
  }
}

export class IssuesPanel {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly summary: HTMLElement;

  constructor(
    private readonly select: (id: string) => void,
    private readonly revalidate: () => void,
  ) {
    this.summary = h('p', { class: 'we-muted' }, 'Not checked yet.');
    this.list = h('ul', { class: 'we-issues-list' });
    this.root = h(
      'section',
      { class: 'we-issues', 'aria-label': 'Validation' },
      h('div', { class: 'we-row' }, this.summary, button('Check now', () => this.revalidate())),
      this.list,
    );
  }

  show(diagnostics: readonly Diagnostic[]): void {
    clear(this.list);
    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
    this.summary.textContent = hasErrors(diagnostics)
      ? `${errors} error(s), ${warnings} warning(s). Errors block running this project on a server.`
      : warnings
        ? `No errors, ${warnings} warning(s).`
        : 'No problems found.';
    for (const d of diagnostics.slice(0, 500)) {
      const item = h(
        'li',
        { class: `we-issue is-${d.severity}` },
        h('span', { class: 'we-badge' }, d.severity),
        h('span', {}, d.message),
        h('small', {}, `${d.code}${d.path ? ` · ${d.path}` : ''}`),
      );
      if (d.target) {
        item.tabIndex = 0;
        item.classList.add('is-link');
        item.addEventListener('click', () => this.select(d.target!));
        item.addEventListener('keydown', (ev) => ev.key === 'Enter' && this.select(d.target!));
      }
      this.list.append(item);
    }
  }
}
