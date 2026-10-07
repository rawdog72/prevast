// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DisconnectWindow } from './disconnect-window';

const html = readFileSync(path.resolve(process.cwd(), 'apps/client/public/index.html'), 'utf8');
const bodyMarkup = html
  .slice(html.indexOf('<body'), html.indexOf('</body>'))
  .replace(/^<body[^>]*>/, '');
const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;

describe('DisconnectWindow', () => {
  let dialog: DisconnectWindow;
  beforeEach(() => {
    document.body.innerHTML = bodyMarkup;
    dialog = new DisconnectWindow($('#dv-disconnect'));
  });

  it('opens over the last frame and closes cleanly', () => {
    expect(dialog.isOpen).toBe(false);
    dialog.open('data:image/jpeg;base64,AAAA');
    expect(dialog.isOpen).toBe(true);
    expect($('.dv-disconnect-backdrop').style.backgroundImage).toContain(
      'data:image/jpeg;base64,AAAA',
    );
    dialog.close();
    expect(dialog.isOpen).toBe(false);
    expect($('.dv-disconnect-backdrop').style.backgroundImage).toBe('');
  });

  it('renders the view and reports the chosen action', () => {
    const onAction = vi.fn();
    dialog.open('');
    dialog.render(
      {
        title: 'You were kicked',
        message: 'An admin removed you.',
        detail: 'spam',
        busy: false,
        actions: ['reconnect', 'main-menu'],
      },
      onAction,
    );
    expect($('#dv-disconnect-title').textContent).toBe('You were kicked');
    expect($('.dv-disconnect-message').textContent).toBe('An admin removed you.');
    expect($('.dv-disconnect-detail').textContent).toBe('spam');
    expect($('.dv-disconnect-panel').getAttribute('aria-busy')).toBe('false');
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>('.dv-disconnect-actions button'),
    ];
    expect(buttons.map((b) => b.textContent)).toEqual(['Reconnect', 'Main menu']);
    expect(document.activeElement).toBe(buttons[0]);
    buttons[1]!.click();
    expect(onAction).toHaveBeenCalledWith('main-menu');
  });

  it('marks a busy view and replaces the previous buttons', () => {
    dialog.open('');
    dialog.render(
      { title: 'a', message: '', detail: '', busy: false, actions: ['reconnect', 'main-menu'] },
      () => {},
    );
    dialog.render(
      { title: 'b', message: 'Reconnecting…', detail: '', busy: true, actions: ['main-menu'] },
      () => {},
    );
    expect($('.dv-disconnect-panel').getAttribute('aria-busy')).toBe('true');
    expect(document.querySelectorAll('.dv-disconnect-actions button')).toHaveLength(1);
  });
});
