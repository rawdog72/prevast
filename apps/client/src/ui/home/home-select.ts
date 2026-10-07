// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Start-screen picker. The native select remains the value/change-event source;
// the enhanced view keeps focus on the combobox while browsing its listbox.
interface ChoiceText {
  title: string;
  detail?: string;
  badge?: string;
  tone?: string;
}

interface HomeSelectOptions {
  empty?: () => ChoiceText;
  onInteraction?: () => void;
  onClose?: () => void;
}

export class HomeSelect {
  readonly trigger: HTMLButtonElement;
  private readonly menu: HTMLDivElement;
  private readonly value: HTMLSpanElement;
  private readonly empty: HTMLDivElement;
  private readonly rows = new Map<string, HTMLDivElement>();
  private active = '';
  private opened = false;
  private search = '';
  private searchedAt = 0;
  private nextId = 0;

  constructor(
    private readonly select: HTMLSelectElement,
    root: HTMLElement,
    private readonly options: HomeSelectOptions = {},
  ) {
    const doc = select.ownerDocument;
    this.trigger = doc.createElement('button');
    this.trigger.type = 'button';
    this.trigger.id = `${select.id}-trigger`;
    this.trigger.className = 'dv-select-trigger';
    this.trigger.setAttribute('role', 'combobox');
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-controls', `${select.id}-listbox`);
    this.value = doc.createElement('span');
    this.value.className = 'dv-select-value';
    this.value.id = `${select.id}-value`;
    this.trigger.append(this.value);
    const label = select.labels?.[0];
    const name = label?.textContent ?? select.getAttribute('aria-label') ?? '';
    if (label) {
      label.id ||= `${select.id}-label`;
      label.htmlFor = this.trigger.id;
      this.trigger.setAttribute('aria-labelledby', label.id);
    } else this.trigger.setAttribute('aria-label', name);

    this.menu = doc.createElement('div');
    this.menu.id = `${select.id}-listbox`;
    this.menu.className = 'dv-select-menu';
    this.menu.setAttribute('role', 'listbox');
    this.menu.setAttribute('aria-label', name);
    this.menu.setAttribute('aria-hidden', 'true');
    this.menu.inert = true;
    this.empty = doc.createElement('div');
    this.empty.className = 'dv-select-empty';
    this.empty.setAttribute('role', 'presentation');
    this.menu.append(this.empty);
    // Outside the glass window so its overflow/backdrop filter cannot clip the menu.
    root.append(this.menu);
    select.after(this.trigger);
    select.hidden = true;
    this.trigger.addEventListener('click', () => (this.opened ? this.close() : this.open()));
    this.trigger.addEventListener('keydown', (event) => this.keydown(event));
    select.addEventListener('change', () => this.sync());
    this.menu.addEventListener('pointerdown', (event) => event.preventDefault());
    this.sync();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  sync(): void {
    this.trigger.disabled = this.select.disabled;
    if (this.trigger.disabled) this.close();
    const selected = this.select.selectedOptions[0];
    const empty = this.options.empty?.() ?? { title: 'No options available' };
    this.paint(this.value, selected ? this.describe(selected) : empty);
    this.paint(this.empty, empty);
    this.empty.hidden = this.select.options.length > 0;
    const keys = new Set<string>();
    let previous: Element = this.empty;
    for (const option of this.select.options) {
      keys.add(option.value);
      let row = this.rows.get(option.value);
      if (!row) {
        row = this.select.ownerDocument.createElement('div');
        row.id = `${this.menu.id}-${this.nextId++}`;
        row.className = 'dv-select-option';
        row.setAttribute('role', 'option');
        const value = option.value;
        row.addEventListener('click', () => this.commit(value));
        this.rows.set(value, row);
        this.menu.append(row);
      }
      this.paint(row, this.describe(option));
      row.setAttribute('aria-selected', String(option.selected));
      row.setAttribute('aria-disabled', String(option.disabled));
      if (previous.nextElementSibling !== row) previous.after(row);
      previous = row;
    }
    for (const [key, row] of this.rows) {
      if (!keys.has(key)) {
        row.remove();
        this.rows.delete(key);
      }
    }
    if (this.opened) {
      if (!this.enabled().some((option) => option.value === this.active))
        this.active = this.enabled()[0]?.value ?? '';
      this.highlight();
      this.position();
    }
  }

  open(): void {
    if (this.select.disabled || this.opened) return;
    this.options.onInteraction?.();
    this.sync();
    this.opened = true;
    this.active =
      this.enabled().find((option) => option.selected)?.value ?? this.enabled()[0]?.value ?? '';
    this.search = '';
    this.menu.inert = false;
    this.menu.setAttribute('aria-hidden', 'false');
    this.trigger.setAttribute('aria-expanded', 'true');
    this.position();
    this.menu.classList.add('is-open');
    this.highlight(true);
    const doc = this.select.ownerDocument;
    doc.addEventListener('pointerdown', this.outside, true);
    doc.addEventListener('focusin', this.outside, true);
    doc.addEventListener('scroll', this.scroll, true);
    doc.defaultView?.addEventListener('resize', this.resize);
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.menu.classList.remove('is-open');
    this.menu.inert = true;
    this.menu.setAttribute('aria-hidden', 'true');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.removeAttribute('aria-activedescendant');
    const doc = this.select.ownerDocument;
    doc.removeEventListener('pointerdown', this.outside, true);
    doc.removeEventListener('focusin', this.outside, true);
    doc.removeEventListener('scroll', this.scroll, true);
    doc.defaultView?.removeEventListener('resize', this.resize);
    this.options.onClose?.();
  }

  private readonly outside = (event: Event): void => {
    const target = event.target as Node;
    if (!this.trigger.contains(target) && !this.menu.contains(target)) this.close();
  };
  private readonly scroll = (event: Event): void => {
    if (!this.menu.contains(event.target as Node)) this.close();
  };
  private readonly resize = (): void => this.close();

  private enabled(): HTMLOptionElement[] {
    return [...this.select.options].filter((option) => !option.disabled);
  }

  private describe(option: HTMLOptionElement): ChoiceText {
    return {
      title: option.dataset.title ?? option.text,
      detail: option.dataset.detail,
      badge: option.dataset.badge,
      tone: option.dataset.tone,
    };
  }

  private paint(element: HTMLElement, text: ChoiceText): void {
    // Avoid replacing text nodes on every latency update (including while browsing).
    for (const [key, value] of [
      ['title', text.title],
      ['detail', text.detail],
      ['badge', text.badge],
    ] as const) {
      let part = element.querySelector<HTMLSpanElement>(`.dv-select-${key}`);
      if (!part) {
        part = this.select.ownerDocument.createElement('span');
        part.className = `dv-select-${key}`;
        element.append(part);
      }
      if (part.textContent !== (value ?? '')) part.textContent = value ?? '';
      part.hidden = !value;
    }
    element.dataset.tone = text.tone ?? '';
    element.title = [text.title, text.detail, text.badge].filter(Boolean).join(' · ');
  }

  private highlight(scroll = false): void {
    for (const [key, row] of this.rows) row.classList.toggle('is-active', key === this.active);
    const row = this.rows.get(this.active);
    if (row) {
      this.trigger.setAttribute('aria-activedescendant', row.id);
      if (scroll) {
        // Only scroll the menu; scrollIntoView can also move the centered home screen.
        const top = row.offsetTop;
        const bottom = top + row.offsetHeight;
        if (top < this.menu.scrollTop) this.menu.scrollTop = top;
        else if (bottom > this.menu.scrollTop + this.menu.clientHeight)
          this.menu.scrollTop = bottom - this.menu.clientHeight;
      }
    } else this.trigger.removeAttribute('aria-activedescendant');
  }

  private commit(value: string): void {
    const option = this.enabled().find((option) => option.value === value);
    if (this.select.disabled || !option) return;
    const changed = this.select.value !== value;
    this.select.value = value;
    this.sync();
    this.close();
    if (changed) this.select.dispatchEvent(new Event('change', { bubbles: true }));
    this.trigger.focus({ preventScroll: true });
  }

  private keydown(event: KeyboardEvent): void {
    const { key } = event;
    if (key === 'Tab') {
      this.close();
      return;
    }
    if (key === 'Escape') {
      if (this.opened) {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const navigation = ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key);
    const confirm = key === 'Enter' || key === ' ';
    const typing = key.length === 1 && !confirm;
    if (!navigation && !confirm && !typing) return;
    event.preventDefault();
    this.options.onInteraction?.();
    if (confirm) {
      if (this.opened) this.commit(this.active);
      else this.open();
      return;
    }
    const wasOpen = this.opened;
    this.open();
    const choices = this.enabled();
    let index = choices.findIndex((option) => option.value === this.active);
    if (key === 'Home') index = 0;
    else if (key === 'End') index = choices.length - 1;
    else if (navigation && wasOpen) index += key === 'ArrowDown' ? 1 : -1;
    else if (typing) {
      const now = Date.now();
      this.search = (now - this.searchedAt > 700 ? '' : this.search) + key.toLowerCase();
      this.searchedAt = now;
      const repeated = [...this.search].every((ch) => ch === this.search[0]);
      const query = repeated ? key.toLowerCase() : this.search;
      const start = repeated ? index + 1 : index;
      for (let offset = 0; offset < choices.length; offset++) {
        const candidate = (Math.max(0, start) + offset) % choices.length;
        if (this.describe(choices[candidate]).title.toLowerCase().startsWith(query)) {
          index = candidate;
          break;
        }
      }
    }
    this.active = choices[Math.max(0, Math.min(choices.length - 1, index))]?.value ?? '';
    this.highlight(true);
  }

  private position(): void {
    const rect = this.trigger.getBoundingClientRect();
    const viewport = this.select.ownerDocument.defaultView;
    const height = viewport?.innerHeight ?? 800;
    const width = viewport?.innerWidth ?? 400;
    const below = height - rect.bottom - 12;
    const above = rect.top - 12;
    const upwards = below < Math.min(300, this.menu.scrollHeight) && above > below;
    const maxHeight = Math.max(0, Math.min(320, upwards ? above : below));
    this.menu.style.width = `${Math.min(rect.width, width - 24)}px`;
    this.menu.style.maxHeight = `${maxHeight}px`;
    this.menu.style.left = `${Math.max(12, Math.min(rect.left, width - rect.width - 12))}px`;
    this.menu.style.top = upwards ? 'auto' : `${rect.bottom + 6}px`;
    this.menu.style.bottom = upwards ? `${height - rect.top + 6}px` : 'auto';
    this.menu.dataset.side = upwards ? 'above' : 'below';
  }
}
