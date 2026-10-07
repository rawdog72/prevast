// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatModel, type ChatRoster } from '../../chat/chat-model';
import { ChatChannel } from '../../net/opcodes';
import { HudChat } from './hud-chat';

function roster(): ChatRoster {
  const players = new Map<number, string>([
    [1, 'Me'],
    [2, 'Bob'],
  ]);
  return {
    nameOf: (pid) => players.get(pid),
    ownGuid: () => 1,
    ownClan: () => -1,
    players: () => [...players].map(([guid, nickname]) => ({ guid, nickname })),
  };
}

const mounted: HudChat[] = [];
afterEach(() => {
  mounted.splice(0).forEach((hud) => hud.destroy());
  vi.restoreAllMocks();
});
function setup() {
  document.body.replaceChildren();
  localStorage.clear(); // the model remembers the active tab across sessions
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const root = document.createElement('div');
  document.body.append(root);
  const model = new ChatModel(roster(), () => 0);
  const hud = new HudChat();
  mounted.push(hud);
  const delegates = {
    onSubmit: vi.fn(),
    onOpenPrivate: vi.fn(),
    onFocusChange: vi.fn(),
    onPlayerMenu: vi.fn(),
  };
  hud.mount(root);
  hud.attach(model, delegates);
  hud.update();
  return { root, model, hud, delegates };
}

const tabIds = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('.hud-chat-tab')].map((b) => b.dataset['tab']);

describe('HudChat console', () => {
  it('draws the fixed tabs, adds Admin only when granted, and marks the active one', () => {
    const { root, model, hud } = setup();
    expect(tabIds(root)).toEqual(['local', 'global']);
    expect(root.querySelector('option[value="server"]')!.textContent).toBe('Activity');
    expect(root.querySelector('.hud-chat-tab.is-active')!.getAttribute('data-tab')).toBe('local');

    model.setAccess({ mask: 1 << ChatChannel.ADMIN });
    hud.update();
    expect(tabIds(root)).toEqual(['local', 'global', 'admin']);
  });

  it('appends only new lines and switches the log on tab change', () => {
    const { root, model, hud } = setup();
    model.onChat({ channel: ChatChannel.LOCAL, pid: 2, peer: 0, flags: 0, text: 'one' });
    hud.update();
    model.onChat({ channel: ChatChannel.LOCAL, pid: 1, peer: 0, flags: 0, text: 'two' });
    hud.update();
    const lines = [...root.querySelectorAll<HTMLElement>('.hud-chat-line')];
    expect(lines.map((l) => l.querySelector('.text')!.textContent)).toEqual(['one', 'two']);
    expect(lines[0]!.querySelector('.who')!.textContent).toBe('Bob:');
    expect(lines[1]!.classList.contains('is-self')).toBe(true);

    model.onChat({ channel: ChatChannel.GLOBAL, pid: 2, peer: 0, flags: 0, text: 'g' });
    hud.update();
    expect(root.querySelector('[data-tab="global"] .unread-dot')!.getAttribute('aria-label')).toBe(
      '1 unread',
    );

    (root.querySelector('[data-tab="global"]') as HTMLElement).click();
    hud.update();
    expect([...root.querySelectorAll('.hud-chat-line .text')].map((t) => t.textContent)).toEqual([
      'g',
    ]);
    expect(root.querySelector('[data-tab="global"] .unread-dot')).toBeNull();
  });

  it('adds is-mention class when a line mentions the player', () => {
    const { root, model, hud } = setup();
    model.onChat({ channel: ChatChannel.LOCAL, pid: 2, peer: 0, flags: 0, text: 'hello @Me!' });
    hud.update();
    const line = root.querySelector<HTMLElement>('.hud-chat-line')!;
    expect(line.classList.contains('is-mention')).toBe(true);
  });

  it('Enter hands the text to the delegate, Escape blurs, double-click on a name opens a PM', () => {
    const { root, hud, delegates, model } = setup();
    const input = root.querySelector<HTMLInputElement>('input.hud-chat-input')!;
    hud.focus();
    expect(hud.isFocused()).toBe(true);
    expect(delegates.onFocusChange).toHaveBeenCalledWith(true);

    input.value = 'hello';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(delegates.onSubmit).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('');
    // Send and go: Enter drops focus so WASD works again at once.
    expect(hud.isFocused()).toBe(false);

    hud.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(hud.isFocused()).toBe(false);

    model.onChat({ channel: ChatChannel.LOCAL, pid: 2, peer: 0, flags: 0, text: 'hi' });
    hud.update();
    root.querySelector('.who')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(delegates.onOpenPrivate).toHaveBeenCalledWith(2);
  });

  it('right-click on a speaker or a private tab asks for the player menu', () => {
    const { root, model, hud, delegates } = setup();
    model.onChat({ channel: ChatChannel.PRIVATE, pid: 2, peer: 2, flags: 0, text: 'spam' });
    model.setActive('pm:2');
    model.togglePin('pm:2');
    hud.update();
    const onName = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 40,
    });
    root.querySelector('.who')!.dispatchEvent(onName);
    expect(delegates.onPlayerMenu).toHaveBeenCalledWith(2, 30, 40, 'spam');
    expect(onName.defaultPrevented).toBe(true);

    const onTab = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 5,
      clientY: 6,
    });
    root.querySelector('[data-tab="pm:2"]')!.dispatchEvent(onTab);
    expect(delegates.onPlayerMenu).toHaveBeenLastCalledWith(2, 5, 6);

    // A fixed tab is no player: the browser menu is left alone.
    const onLocal = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    root.querySelector('[data-tab="local"]')!.dispatchEvent(onLocal);
    expect(delegates.onPlayerMenu).toHaveBeenCalledTimes(2);
    expect(onLocal.defaultPrevented).toBe(false);
  });

  it('shows a private tab with a close button that drops it', () => {
    const { root, model, hud } = setup();
    model.onChat({ channel: ChatChannel.PRIVATE, pid: 2, peer: 2, flags: 0, text: 'psst' });
    hud.update();
    expect(tabIds(root)).not.toContain('pm:2');
    const picker = root.querySelector<HTMLSelectElement>('.hud-chat-conversations')!;
    picker.value = 'pm:2';
    picker.dispatchEvent(new Event('change'));
    (root.querySelector('[data-close="pm:2"]') as HTMLElement).click();
    hud.update();
    expect(root.querySelector('option[value="pm:2"]')).toBeNull();
  });

  it('collapse hides the log and input; the model remembers it', () => {
    const { root, model, hud } = setup();
    (root.querySelector('[data-collapse]') as HTMLElement).click();
    hud.update();
    expect(root.classList.contains('is-collapsed')).toBe(true);
    expect(model.collapsed).toBe(true);
    hud.focus(); // typing re-opens the console
    expect(model.collapsed).toBe(false);
  });

  it('colours an admin speaker and only shows the Clan tab while in a clan', () => {
    const { root, model, hud } = setup();
    expect(tabIds(root)).toEqual(['local', 'global']);
    model.onChat({ channel: ChatChannel.LOCAL, pid: 2, peer: 0, flags: 1, text: 'gm here' });
    hud.update();
    expect(root.querySelector('.hud-chat-line')!.classList.contains('is-admin')).toBe(true);
  });

  it('a private-message notice shows at the top and a click jumps to that tab', () => {
    const { root, model, hud } = setup();
    const notices = document.body.querySelector('.hud-chat-notices')!;
    const arrival = model.onChat({
      channel: ChatChannel.PRIVATE,
      pid: 2,
      peer: 2,
      flags: 0,
      text: 'psst',
    })!;
    expect(arrival.unseen).toBe(true);
    hud.notice(arrival.line, arrival.tab);
    const card = notices.querySelector<HTMLElement>('.hud-chat-notice')!;
    expect(card.querySelector('.title')!.textContent).toBe('Bob');
    expect(card.querySelector('.text')!.textContent).toBe('psst');

    card.click();
    hud.update();
    expect(model.active.id).toBe('pm:2');
    expect(hud.isFocused()).toBe(true);
    expect(notices.querySelector('.hud-chat-notice')).toBeNull();
    expect(root.querySelector<HTMLSelectElement>('.hud-chat-conversations')!.value).toBe('pm:2');
  });

  it('keeps separate drafts on tab switches and Escape, and preserves rejected input', () => {
    const { root, hud, model, delegates } = setup();
    const input = root.querySelector<HTMLInputElement>('.hud-chat-input')!;
    input.value = 'local draft';
    input.dispatchEvent(new Event('input'));
    root.querySelector<HTMLButtonElement>('[data-tab="global"]')!.click();
    expect(input.value).toBe('');
    input.value = 'global draft';
    input.dispatchEvent(new Event('input'));
    root.querySelector<HTMLButtonElement>('[data-tab="local"]')!.click();
    expect(input.value).toBe('local draft');
    hud.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(input.value).toBe('local draft');
    expect(hud.isFocused()).toBe(false);
    delegates.onSubmit.mockReturnValue(false);
    hud.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(input.value).toBe('local draft');
    expect(hud.isFocused()).toBe(true);
    expect(model.tab('global')!.draft).toBe('global draft');
  });

  it('uses Tab to complete player names and ignores Enter during IME composition', () => {
    const { root, delegates } = setup();
    const input = root.querySelector<HTMLInputElement>('.hud-chat-input')!;
    input.value = '/w Bo';
    input.dispatchEvent(new Event('input'));
    expect(root.querySelector('.hud-chat-suggestions')!.textContent).toContain('Bob #2');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(input.value).toBe('/w #2 ');
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    );
    expect(delegates.onSubmit).not.toHaveBeenCalled();
  });

  it('restores reading positions and keeps unread until jumping to the latest messages', () => {
    const { root, model, hud } = setup();
    model.onChat({ channel: ChatChannel.LOCAL, pid: 2, peer: 0, flags: 0, text: 'old' });
    hud.update();
    const log = root.querySelector<HTMLElement>('.hud-chat-log')!;
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 100 });
    log.scrollTop = 150;
    log.dispatchEvent(new Event('scroll'));
    model.onChat({ channel: ChatChannel.LOCAL, pid: 2, peer: 0, flags: 0, text: 'new' });
    hud.update();
    expect(model.active.unread).toBe(1);
    expect(root.querySelector<HTMLButtonElement>('.hud-chat-jump')!.hidden).toBe(false);
    model.setActive('global');
    hud.update();
    model.setActive('local');
    hud.update();
    expect(log.scrollTop).toBe(150);
    expect(model.active.unread).toBe(1);
    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(log.scrollTop).toBe(150);
    expect(model.active.unread).toBe(1);
    root.querySelector<HTMLButtonElement>('.hud-chat-jump')!.click();
    expect(model.active.unread).toBe(0);
  });

  it('labels mentions correctly and groups repeated notices by conversation', () => {
    const { hud, model } = setup();
    const arrival = model.onChat({
      channel: ChatChannel.GLOBAL,
      pid: 2,
      peer: 0,
      flags: 0,
      text: '@Me hello',
    })!;
    hud.notice(arrival.line, arrival.tab);
    hud.notice(arrival.line, arrival.tab);
    expect(hud.noticesEl.children).toHaveLength(1);
    expect(hud.noticesEl.querySelector('.kicker')!.textContent).toBe('Mention · Global');
  });

  it('pins a private conversation and persists appearance settings', () => {
    const { root, hud, model } = setup();
    model.openPrivate(2);
    hud.update();
    root.querySelector<HTMLButtonElement>('.hud-chat-context-action')!.click();
    expect(tabIds(root)).toContain('pm:2');
    root.querySelector<HTMLButtonElement>('[aria-label="Chat settings"]')!.click();
    const size = root.querySelector<HTMLInputElement>('input[aria-label="Text size"]')!;
    size.value = '16';
    size.dispatchEvent(new Event('input'));
    expect(root.style.getPropertyValue('--chat-font-size')).toBe('16px');
    expect(JSON.parse(localStorage.getItem('prevast.chat.settings')!).fontSize).toBe(16);
  });

  it('keeps a focused conversation picker mounted during arrivals and refreshes on blur', () => {
    const { root, hud, model } = setup();
    const picker = root.querySelector<HTMLSelectElement>('.hud-chat-conversations')!;
    picker.focus();
    model.onChat({ channel: ChatChannel.PRIVATE, pid: 2, peer: 2, flags: 0, text: 'hello' });
    hud.update();
    expect(root.querySelector('.hud-chat-conversations')).toBe(picker);
    expect(document.activeElement).toBe(picker);
    picker.blur();
    hud.update();
    expect(root.querySelector('option[value="pm:2"]')).not.toBeNull();
  });
});
