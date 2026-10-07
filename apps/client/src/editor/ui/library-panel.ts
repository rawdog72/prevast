// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The asset library: every placeable from the catalog, searchable and filterable by category,
// with favorites and the project's templates. The list is virtualized: only visible rows exist.
import type { AssetLoader } from '../../assets/asset-loader';
import { categoryLabel, type CatalogEntry } from '../catalog/catalog';
import type { EditorContext } from '../editor-context';
import { button, clear, h } from './dom';

const ROW_HEIGHT = 44;
const OVERSCAN = 6;

export interface LibraryActions {
  pickEntry(entry: CatalogEntry): void;
  pickTemplate(id: string): void;
  toggleFavorite(key: string): void;
  renameTemplate(id: string): void;
  deleteTemplate(id: string): void;
  exportTemplate(id: string): void;
  importStructures(): void;
}

export function drawThumbnail(canvas: HTMLCanvasElement, assets: AssetLoader, sprite: string | undefined): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (!sprite) return;
  const img = assets.get(sprite);
  if (!img) {
    void assets.load(sprite, 'normal').then(() => drawThumbnail(canvas, assets, sprite)).catch(() => {});
    return;
  }
  const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight, 1);
  const w = img.naturalWidth * scale;
  const h2 = img.naturalHeight * scale;
  g.drawImage(img.image, (canvas.width - w) / 2, (canvas.height - h2) / 2, w, h2);
}

export class LibraryPanel {
  readonly root: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly chips: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly templates: HTMLElement;
  private category = '';
  private favoritesOnly = false;
  private filtered: CatalogEntry[] = [];

  constructor(
    private readonly ctx: EditorContext,
    private readonly actions: LibraryActions,
  ) {
    this.search = h('input', { type: 'search', class: 'we-search', placeholder: 'Search pieces…', 'aria-label': 'Search the library' });
    this.search.addEventListener('input', () => this.refresh());
    this.chips = h('div', { class: 'we-chips', role: 'group', 'aria-label': 'Categories' });
    this.rows = h('div', { class: 'we-lib-rows', role: 'listbox', 'aria-label': 'Placeable pieces' });
    this.spacer = h('div', { class: 'we-lib-spacer' }, this.rows);
    this.viewport = h('div', { class: 'we-lib-list' }, this.spacer);
    this.viewport.addEventListener('scroll', () => this.renderRows());
    this.templates = h('div', { class: 'we-templates' });
    this.root = h(
      'section',
      { class: 'we-panel we-library', 'aria-label': 'Library' },
      h('h2', {}, 'Library'),
      this.search,
      this.chips,
      this.viewport,
      h('h2', {}, 'Templates'),
      this.templates,
    );
    this.buildChips();
    this.refresh();
  }

  /** Re-reads favorites, templates and the active piece. */
  refresh(): void {
    const favorites = new Set(this.ctx.store.editor.favorites ?? []);
    const query = this.search.value.trim();
    this.filtered = this.ctx.catalog
      .search(query, this.category || undefined)
      .filter((e) => !this.favoritesOnly || favorites.has(e.key));
    this.spacer.style.height = `${this.filtered.length * ROW_HEIGHT}px`;
    this.renderRows();
    this.renderTemplates();
  }

  private buildChips(): void {
    const make = (value: string, label: string) => {
      const chip = button(label, () => {
        this.favoritesOnly = value === '★';
        this.category = value === '★' ? '' : value;
        for (const c of this.chips.children) c.setAttribute('aria-pressed', String(c === chip));
        this.viewport.scrollTop = 0;
        this.refresh();
      }, { class: 'we-chip', 'aria-pressed': value === '' ? 'true' : 'false' });
      return chip;
    };
    this.chips.append(make('', 'All'), make('★', '★ Favorites'));
    for (const c of this.ctx.catalog.categories()) this.chips.append(make(c, categoryLabel(c)));
  }

  private renderRows(): void {
    const top = this.viewport.scrollTop;
    const height = this.viewport.clientHeight || 400;
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(this.filtered.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
    const favorites = new Set(this.ctx.store.editor.favorites ?? []);
    clear(this.rows);
    this.rows.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
    for (let i = first; i < last; i++) {
      const entry = this.filtered[i]!;
      const active = this.ctx.activeEntry?.key === entry.key && !this.ctx.activeTemplate;
      const thumb = h('canvas', { width: 36, height: 36, class: 'we-thumb', 'aria-hidden': 'true' });
      drawThumbnail(thumb, this.ctx.assets, entry.icon);
      const row = h(
        'div',
        { class: `we-lib-row${active ? ' is-active' : ''}`, role: 'option', 'aria-selected': String(active), tabindex: 0, title: `${entry.name} · ${categoryLabel(entry.category)}` },
        thumb,
        h('span', { class: 'we-lib-name' }, entry.name),
      );
      const star = button(favorites.has(entry.key) ? '★' : '☆', () => this.actions.toggleFavorite(entry.key), {
        class: 'we-star',
        'aria-label': favorites.has(entry.key) ? `Remove ${entry.name} from favorites` : `Add ${entry.name} to favorites`,
      });
      star.addEventListener('click', (ev) => ev.stopPropagation());
      row.append(star);
      row.addEventListener('click', () => this.actions.pickEntry(entry));
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          this.actions.pickEntry(entry);
        }
      });
      this.rows.append(row);
    }
    if (!this.filtered.length) this.rows.append(h('p', { class: 'we-empty' }, 'Nothing matches.'));
  }

  private renderTemplates(): void {
    clear(this.templates);
    const list = [...this.ctx.store.templates.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length)
      this.templates.append(h('p', { class: 'we-empty' }, 'Select pieces and choose “Save as template” to reuse them.'));
    for (const t of list) {
      const active = this.ctx.activeTemplate === t.id;
      const row = h(
        'div',
        { class: `we-template${active ? ' is-active' : ''}` },
        button(`${t.name}`, () => this.actions.pickTemplate(t.id), { class: 'we-template-name', title: `${t.size.w}×${t.size.h} tiles · ${t.entities.length} pieces · rev ${t.revision}` }),
        h('small', {}, `${t.size.w}×${t.size.h}`),
        button('✎', () => this.actions.renameTemplate(t.id), { class: 'we-icon', 'aria-label': `Rename ${t.name}` }),
        button('⤓', () => this.actions.exportTemplate(t.id), { class: 'we-icon', 'aria-label': `Export ${t.name}` }),
        button('✕', () => this.actions.deleteTemplate(t.id), { class: 'we-icon', 'aria-label': `Delete ${t.name}` }),
      );
      this.templates.append(row);
    }
    this.templates.append(button('Import game structures…', () => this.actions.importStructures(), { class: 'we-link' }));
  }
}
