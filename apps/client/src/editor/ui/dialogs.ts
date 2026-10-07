// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Modal dialogs: the project picker (new / open / import), and simple choices such as draft
// recovery and save conflicts. Each resolves a promise; Escape resolves as "cancel".
import { EDITOR_LIMITS } from '../../../../../shared/typescript/editor-limits';
import type { ProjectSummary } from '../storage/project-db';
import { button, clear, field, h, numberInput } from './dom';

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  tone?: 'primary' | 'danger';
}

export type PickerResult =
  | { type: 'new'; title: string; tilesX: number; tilesY: number }
  | { type: 'open'; id: string }
  | { type: 'import' }
  | { type: 'cancel' };

function when(ms: number | undefined): string {
  return ms ? new Date(ms).toLocaleString() : '—';
}

export class Dialogs {
  private readonly dialog: HTMLDialogElement;

  constructor(host: HTMLElement) {
    this.dialog = h('dialog', { class: 'we-dialog dv-window' });
    host.append(this.dialog);
  }

  dispose(): void {
    this.close();
    this.dialog.remove();
  }

  private close(): void {
    if (!this.dialog.open) return;
    if (typeof this.dialog.close === 'function') this.dialog.close();
    else this.dialog.removeAttribute('open');
  }

  private open<T>(build: (resolve: (value: T) => void) => (HTMLElement | null)[], cancelValue: T): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false;
      const finish = (value: T) => {
        if (settled) return;
        settled = true;
        this.dialog.removeEventListener('cancel', onCancel);
        this.close();
        resolve(value);
      };
      const onCancel = (ev: Event) => {
        ev.preventDefault();
        finish(cancelValue);
      };
      clear(this.dialog);
      this.dialog.append(...build(finish).filter((el): el is HTMLElement => el !== null));
      this.dialog.addEventListener('cancel', onCancel);
      if (!this.dialog.open) {
        if (typeof this.dialog.showModal === 'function') this.dialog.showModal();
        else this.dialog.setAttribute('open', '');
      }
      this.dialog.querySelector<HTMLElement>('[autofocus]')?.focus();
    });
  }

  choose<T extends string>(title: string, message: string | HTMLElement, options: ChoiceOption<T>[], cancel: T): Promise<T> {
    return this.open<T>(
      (resolve) => [
        h('h2', {}, title),
        typeof message === 'string' ? h('p', {}, message) : message,
        h(
          'div',
          { class: 'we-dialog-actions' },
          ...options.map((o, i) =>
            button(o.label, () => resolve(o.value), { class: o.tone === 'danger' ? 'we-danger' : o.tone === 'primary' ? 'we-primary' : '', autofocus: i === 0 }),
          ),
        ),
      ],
      cancel,
    );
  }

  prompt(title: string, label: string, value: string): Promise<string | null> {
    return this.open<string | null>((resolve) => {
      const input = h('input', { type: 'text', value, maxlength: 80, autofocus: true });
      const form = h('form', { class: 'we-form' }, field(label, input), h('div', { class: 'we-dialog-actions' },
        h('button', { type: 'submit', class: 'we-primary' }, 'OK'),
        button('Cancel', () => resolve(null)),
      ));
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        resolve(input.value.trim() || null);
      });
      return [h('h2', {}, title), form];
    }, null);
  }

  projectPicker(projects: ProjectSummary[], canCancel: boolean, storageError?: string): Promise<PickerResult> {
    const W = EDITOR_LIMITS.world;
    return this.open<PickerResult>((resolve) => {
      const title = h('input', { type: 'text', value: 'New scenario', maxlength: 80, required: true, autofocus: true });
      const w = numberInput(W.referenceTilesX, { min: W.minTiles, max: W.maxTiles });
      const hgt = numberInput(W.referenceTilesY, { min: W.minTiles, max: W.maxTiles });
      const error = h('p', { class: 'we-error', role: 'alert' });
      const form = h(
        'form',
        { class: 'we-form' },
        field('Title', title),
        h('div', { class: 'we-row' }, field('Width (tiles)', w), field('Height (tiles)', hgt)),
        h('small', {}, `Maps are ${W.minTiles}–${W.maxTiles} tiles per side; ${W.referenceTilesX}×${W.referenceTilesY} is the standard world.`),
        error,
        h('div', { class: 'we-dialog-actions' }, h('button', { type: 'submit', class: 'we-primary' }, 'Create project')),
      );
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const tx = Number(w.value);
        const ty = Number(hgt.value);
        const ok = [tx, ty].every((n) => Number.isInteger(n) && n >= W.minTiles && n <= W.maxTiles);
        if (!ok || !title.value.trim()) {
          error.textContent = `Enter a title and sizes from ${W.minTiles} to ${W.maxTiles}.`;
          return;
        }
        resolve({ type: 'new', title: title.value.trim(), tilesX: tx, tilesY: ty });
      });
      const list = h('ul', { class: 'we-projects' });
      for (const p of projects) {
        const draftNewer = p.draftAt !== undefined;
        list.append(
          h(
            'li',
            {},
            button(p.title, () => resolve({ type: 'open', id: p.id }), { class: 'we-project-open' }),
            h('small', {}, p.revision ? `rev ${p.revision} · saved ${when(p.savedAt)}` : 'never saved'),
            draftNewer ? h('small', { class: 'we-warn' }, `unsaved draft ${when(p.draftAt)}`) : null,
          ),
        );
      }
      if (!projects.length) list.append(h('li', { class: 'we-empty' }, 'No projects in this browser yet.'));
      return [
        h('h2', {}, 'World & Mode Editor'),
        storageError ? h('p', { class: 'we-error' }, `Browser storage is unavailable (${storageError}). You can still create, import and export files; autosave is off.`) : null,
        h('div', { class: 'we-picker' }, h('div', {}, h('h3', {}, 'New project'), form), h('div', {}, h('h3', {}, 'Open'), list,
          button('Import a .prevast.json file…', () => resolve({ type: 'import' }), { class: 'we-link' }))),
        h('div', { class: 'we-dialog-actions' }, button(canCancel ? 'Back to the project' : 'Close the editor', () => resolve({ type: 'cancel' }))),
      ];
    }, { type: 'cancel' });
  }
}
