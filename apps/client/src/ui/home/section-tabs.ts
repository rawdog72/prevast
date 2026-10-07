// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

/** A local tab set, with roving focus and labelled panels. */
export function sectionTabs(
  nav: HTMLElement,
  pages: Record<string, HTMLElement>,
  prefix: string,
  onChange?: (key: string) => void,
): (key: string) => void {
  const buttons = [...nav.querySelectorAll<HTMLButtonElement>('button[data-page]')];
  nav.setAttribute('role', 'tablist');
  const select = (key: string) => {
    for (const button of buttons) {
      const selected = button.dataset.page === key;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    for (const [name, page] of Object.entries(pages)) page.hidden = name !== key;
    onChange?.(key);
  };
  for (const button of buttons) {
    const key = button.dataset.page!;
    button.id = `${prefix}-tab-${key}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `${prefix}-page-${key}`);
    const page = pages[key]!;
    page.id = `${prefix}-page-${key}`;
    page.setAttribute('role', 'tabpanel');
    page.setAttribute('aria-labelledby', button.id);
    button.onclick = () => select(key);
    button.onkeydown = (event) => {
      const enabled = buttons.filter((b) => !b.disabled && !b.hidden);
      const index = enabled.indexOf(button);
      const direction = ['ArrowRight', 'ArrowDown'].includes(event.key)
        ? 1
        : ['ArrowLeft', 'ArrowUp'].includes(event.key)
          ? -1
          : 0;
      const next =
        event.key === 'Home'
          ? enabled[0]
          : event.key === 'End'
            ? enabled.at(-1)
            : direction
              ? enabled[(index + direction + enabled.length) % enabled.length]
              : null;
      if (!next) return;
      event.preventDefault();
      select(next.dataset.page!);
      next.focus();
    };
  }
  return select;
}
