// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Small DOM helpers for the editor panels. Text always goes in as text, never as markup.

type Attrs = Record<string, string | number | boolean | undefined | null>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

export function clear(el: Element): void {
  el.replaceChildren();
}

export function button(label: string, onClick: () => void, attrs: Attrs = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', ...attrs }, label);
  b.addEventListener('click', onClick);
  return b;
}

/** A labelled field row: `<label><span>Label</span>control</label>`. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  return h('label', { class: 'we-field' }, h('span', { class: 'we-field-label' }, label), control, hint ? h('small', {}, hint) : null);
}

export function numberInput(value: number | undefined, options: { min?: number; max?: number; step?: number; placeholder?: string } = {}): HTMLInputElement {
  return h('input', {
    type: 'number',
    value: value === undefined ? '' : String(value),
    min: options.min,
    max: options.max,
    step: options.step ?? 1,
    placeholder: options.placeholder,
  });
}

export function select<T extends string>(value: T, options: readonly (readonly [T, string])[]): HTMLSelectElement {
  const el = h('select');
  for (const [v, label] of options) el.append(h('option', { value: v, selected: v === value }, label));
  return el;
}

/** Whether keyboard input belongs to a text control rather than the canvas. */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'range', 'color'].includes(type);
}

export function downloadText(filename: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copy of a record with an optional field set, or removed when `value` is undefined. */
export function withOptional<T extends object, K extends keyof T>(record: T, key: K, value: T[K] | undefined): T {
  const next = { ...record };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}
