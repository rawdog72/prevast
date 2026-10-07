// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { npcKeywords } from '../../../../../shared/typescript/npc-protocol';
import {
  MAX_CHAT_BYTES,
  type ChatLine,
  type ChatModel,
  type ChatTab,
  type ChatTabId,
} from '../../chat/chat-model';
import { loadChatSettings, saveChatSettings } from '../../chat/chat-settings';
import { ChatChannel } from '../../net/opcodes';
import { badgeNodes } from '../badges';
import { icon } from '../dom/icons';
import { chatSettingsPanel } from './hud-chat-settings';

export interface HudChatDelegates {
  /** False means rejected locally: keep the input and focus. */
  onSubmit(text: string): boolean | void;
  onOpenPrivate(pid: number): void;
  onPlayerMenu?(pid: number, clientX: number, clientY: number, text?: string): void;
  onFocusChange?(focused: boolean): void;
  onNpcKeyword?(session: number, revision: number, text: string): void;
  onNpcClose?(session: number): void;
}

const HISTORY_MAX = 30;
const SCROLL_SLACK_PX = 6;
export const NOTICE_LIFE_MS = 6000;
const NOTICE_MAX = 3;
type ReadingPosition = { top: number; latest: boolean };

export class HudChat {
  readonly settings = loadChatSettings();
  private mounted = false;
  private root!: HTMLElement;
  private tabsEl!: HTMLElement;
  private logEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private inputRow!: HTMLElement;
  private input!: HTMLInputElement;
  private countEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private jump!: HTMLButtonElement;
  private suggestions!: HTMLElement;
  private settingsEl!: HTMLElement;
  private model: ChatModel | null = null;
  private delegates: HudChatDelegates | null = null;
  private renderedVersion = -1;
  private renderedTabsKey = '';
  private renderedTabId: ChatTabId | null = null;
  private renderedLastLineId = 0;
  private logWasVisible = true;
  private playerMenuTimer?: ReturnType<typeof setTimeout>;
  private readonly positions = new Map<ChatTabId, ReadingPosition>();
  private readonly history: string[] = [];
  private historyIndex = -1;
  private historyDraft = '';
  private completion: {
    start: number;
    end: number;
    values: { label: string; text: string }[];
    index: number;
  } | null = null;
  private resizeObserver?: ResizeObserver;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private readonly noticeTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  private readonly foreground = () => {
    this.syncReading();
    this.update();
  };
  private readonly resize = () => this.fitToViewport();
  public noticesEl!: HTMLElement;

  mount(root: HTMLElement, noticesRoot?: HTMLElement): void {
    if (this.mounted) return;
    this.mounted = true;
    this.root = root;
    root.replaceChildren();
    root.classList.add('hud-chat-console', 'dv-panel');
    this.noticesEl = noticesRoot ?? document.createElement('div');
    this.noticesEl.replaceChildren();
    this.noticesEl.classList.add('hud-chat-notices');
    if (!noticesRoot) root.ownerDocument.body.append(this.noticesEl);
    this.tabsEl = element('div', 'hud-chat-tabs');
    this.contextEl = element('div', 'hud-chat-context');
    this.logEl = element('div', 'hud-chat-log');
    this.logEl.setAttribute('aria-label', 'Chat messages');
    this.jump = button('New messages ↓', 'hud-chat-jump');
    this.jump.hidden = true;
    this.jump.addEventListener('click', () => {
      this.logEl.scrollTop = this.logEl.scrollHeight;
      this.savePosition();
      this.syncReading();
      this.renderedVersion = -1;
      this.update();
    });
    this.settingsEl = element('div', 'hud-chat-settings-host');
    this.settingsEl.hidden = true;
    this.settingsEl.append(chatSettingsPanel(this.settings, () => this.applySettings()));
    this.suggestions = element('div', 'hud-chat-suggestions');
    this.suggestions.hidden = true;
    this.suggestions.setAttribute('aria-label', 'Name suggestions');
    this.inputRow = element('div', 'hud-chat-inputrow');
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'hud-chat-input';
    this.input.setAttribute('aria-label', 'Chat message');
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    // Keep over-limit text editable; validate the UTF-8 body before sending.
    this.input.maxLength = 2000;
    const send = button('Send', 'hud-chat-send');
    send.addEventListener('click', () => this.submit());
    this.inputRow.append(this.input, send);
    const footer = element('div', 'hud-chat-footer');
    this.hintEl = element('span', 'hud-chat-hint');
    this.countEl = element('span', 'hud-chat-count');
    footer.append(this.hintEl, this.countEl);
    root.append(
      this.tabsEl,
      this.contextEl,
      this.settingsEl,
      this.logEl,
      this.jump,
      this.suggestions,
      this.inputRow,
      footer,
    );
    this.bind();
    this.applySettings();
    window.addEventListener('focus', this.foreground);
    window.addEventListener('blur', this.foreground);
    document.addEventListener('visibilitychange', this.foreground);
    window.addEventListener('resize', this.resize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.fitToViewport();
        if (
          this.model &&
          this.positions.get(this.model.active.id)?.latest &&
          !this.model.collapsed &&
          this.settingsEl.hidden
        )
          this.logEl.scrollTop = this.logEl.scrollHeight;
        this.renderedVersion = -1;
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
          if (this.model?.collapsed) return;
          const width = Number.parseFloat(this.root.style.width),
            height = Number.parseFloat(this.root.style.height);
          if (Number.isFinite(width)) this.settings.width = Math.max(300, Math.min(900, width));
          if (Number.isFinite(height)) this.settings.height = Math.max(180, Math.min(600, height));
          saveChatSettings(this.settings);
        }, 200);
      });
      this.resizeObserver.observe(root);
    }
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    clearTimeout(this.resizeTimer);
    clearTimeout(this.playerMenuTimer);
    for (const timer of this.noticeTimers.values()) clearTimeout(timer);
    this.noticeTimers.clear();
    this.noticesEl?.replaceChildren();
    window.removeEventListener('focus', this.foreground);
    window.removeEventListener('blur', this.foreground);
    document.removeEventListener('visibilitychange', this.foreground);
    window.removeEventListener('resize', this.resize);
    this.mounted = false;
  }
  attach(model: ChatModel, delegates: HudChatDelegates): void {
    this.model = model;
    this.delegates = delegates;
    this.renderedVersion = -1;
  }
  isFocused(): boolean {
    return this.mounted && document.activeElement === this.input;
  }
  focus(): void {
    if (!this.mounted) return;
    this.model?.setCollapsed(false);
    this.settingsEl.hidden = true;
    this.root.classList.remove('is-settings');
    this.update();
    this.input.focus();
  }
  blur(): void {
    if (this.mounted) this.input.blur();
  }

  /** Called before handling arrivals as well as on scroll/focus. */
  syncReading(): void {
    if (!this.model || !this.mounted) return;
    this.model.setReading(
      this.model.active.id,
      this.renderedTabId === this.model.active.id &&
        this.logWasVisible &&
        !this.root.classList.contains('is-collapsed') &&
        this.atBottom() &&
        this.settingsEl.hidden &&
        document.visibilityState !== 'hidden' &&
        document.hasFocus(),
    );
  }
  update(): void {
    const model = this.model;
    if (!model || !this.mounted) return;
    model.refresh();
    if (model.version === this.renderedVersion) return;
    this.syncReading();
    const active = model.active,
      switched = active.id !== this.renderedTabId;
    const visible = !model.collapsed && this.settingsEl.hidden;
    const restorePosition = switched || (visible && !this.logWasVisible);
    this.root.classList.toggle('is-collapsed', model.collapsed);
    if (switched) {
      this.savePosition();
      this.hideSuggestions();
      this.renderedTabId = active.id;
      this.renderedLastLineId = 0;
      this.logEl.replaceChildren();
      this.historyIndex = -1;
    }
    this.appendNewLines(active);
    if (restorePosition) {
      const position = this.positions.get(active.id);
      this.logEl.scrollTop = position && !position.latest ? position.top : this.logEl.scrollHeight;
    }
    this.logWasVisible = visible;
    this.savePosition();
    this.syncReading();
    const tabs = model.visibleTabs();
    const tabsKey =
      tabs.map((t) => `${t.id}|${t.label}|${t.unread}|${t.unreadMentions}|${t.pinned}`).join(';') +
      `@${active.id}:${model.collapsed}`;
    if (tabsKey !== this.renderedTabsKey) {
      // A native select can have its popup open while messages arrive. Defer
      // replacement until blur, rather than closing the player's picker.
      if (!this.tabsEl.querySelector('.hud-chat-conversations:focus')) {
        this.renderedTabsKey = tabsKey;
        this.renderTabs(tabs, active.id, model);
      }
      this.renderContext(active);
    }
    const value = active.draft ?? '';
    if (this.input.value !== value) this.input.value = value;
    this.input.placeholder = active.npcSession
      ? `Talk to ${active.label}…`
      : active.channel === null
        ? 'Activity is read-only · /help for commands'
        : `Message ${active.label}…`;
    this.input.setAttribute('aria-label', this.input.placeholder);
    this.input.readOnly = !!active.pending;
    this.inputRow.querySelector<HTMLButtonElement>('.hud-chat-send')!.disabled = !!active.pending;
    this.updateCapacity();
    this.jump.hidden = this.atBottom() || active.unread === 0;
    this.jump.textContent = `${active.unread} new message${active.unread === 1 ? '' : 's'} ↓`;
    for (const pill of this.logEl.querySelectorAll<HTMLButtonElement>('button[data-npc-revision]'))
      pill.disabled = Number(pill.dataset['npcRevision']) !== active.npcRevision;
    this.renderedVersion = model.version;
  }
  private applySettings(): void {
    saveChatSettings(this.settings);
    this.root.style.width = `${this.settings.width}px`;
    this.root.style.height = `${this.settings.height}px`;
    this.root.style.setProperty('--chat-font-size', `${this.settings.fontSize}px`);
    this.root.style.setProperty(
      '--chat-font',
      this.settings.font === 'game' ? 'var(--dv-font)' : 'Arial, sans-serif',
    );
    this.root.style.setProperty('--chat-opacity', String(this.settings.opacity));
    this.root.classList.toggle('hide-timestamps', !this.settings.timestamps);
    this.fitToViewport();
    this.renderedVersion = -1;
    this.update();
  }
  private fitToViewport(): void {
    const rect = this.root.getBoundingClientRect();
    const zoom = this.root.offsetWidth > 0 ? rect.width / this.root.offsetWidth : 1;
    const scale = zoom > 0 ? zoom : 1;
    this.root.style.maxWidth = `${Math.max(180, (window.innerWidth - rect.left - 12) / scale)}px`;
    const bottom = rect.bottom || window.innerHeight - 140;
    const height = `${Math.max(100, (bottom - 12) / scale)}px`;
    this.root.style.maxHeight = height;
    this.root.style.setProperty('--chat-available-height', height);
  }
  private renderTabs(tabs: ChatTab[], activeId: ChatTabId, model: ChatModel): void {
    const frag = document.createDocumentFragment(),
      strip = element('div', 'hud-chat-tabstrip');
    strip.setAttribute('aria-label', 'Chat channels');
    const grouped: ChatTab[] = [];
    for (const tab of tabs) {
      if (tab.id === 'server' || (tab.channel === ChatChannel.PRIVATE && !tab.pinned)) {
        grouped.push(tab);
        continue;
      }
      const btn = button(tab.label, 'hud-chat-tab');
      btn.dataset['tab'] = tab.id;
      btn.setAttribute('aria-pressed', String(tab.id === activeId));
      btn.classList.toggle('is-active', tab.id === activeId);
      btn.classList.toggle('is-pm', tab.channel === ChatChannel.PRIVATE);
      btn.classList.toggle('is-npc', !!tab.npcSession);
      if (tab.unread > 0) this.addUnread(btn, tab);
      strip.append(btn);
    }
    frag.append(strip);
    const select = document.createElement('select');
    select.className = 'hud-chat-conversations';
    select.setAttribute('aria-label', 'Private messages and Activity');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    const privateUnread = grouped
      .filter((t) => t.channel === ChatChannel.PRIVATE)
      .reduce((sum, t) => sum + t.unread, 0);
    placeholder.textContent = `Messages${privateUnread ? ` (${privateUnread > 99 ? '99+' : privateUnread})` : ''}`;
    select.append(placeholder);
    for (const tab of grouped) {
      const option = document.createElement('option');
      option.value = tab.id;
      option.textContent = `${tab.label}${tab.unread ? (tab.channel === ChatChannel.PRIVATE || tab.unreadMentions ? ` (${tab.unread})` : ' •') : ''}`;
      select.append(option);
    }
    select.value = grouped.some((t) => t.id === activeId) ? activeId : '';
    select.addEventListener('change', () => {
      if (select.value) {
        const id = select.value as ChatTabId;
        select.blur();
        this.activate(id);
      }
    });
    frag.append(select);
    const settings = button('', 'hud-chat-tool');
    settings.innerHTML = icon('settings');
    settings.setAttribute('aria-label', 'Chat settings');
    settings.title = 'Chat settings';
    settings.addEventListener('click', () => {
      this.settingsEl.hidden = !this.settingsEl.hidden;
      if (!this.settingsEl.hidden) {
        this.settingsEl.replaceChildren(
          chatSettingsPanel(this.settings, () => this.applySettings()),
        );
        model.setCollapsed(false);
        this.blur();
      }
      this.root.classList.toggle('is-settings', !this.settingsEl.hidden);
      this.syncReading();
      this.renderedVersion = -1;
      this.update();
    });
    const collapse = button('', 'hud-chat-collapse');
    collapse.dataset['collapse'] = '1';
    collapse.innerHTML = icon(model.collapsed ? 'caret_up' : 'caret_down');
    collapse.setAttribute('aria-label', model.collapsed ? 'Expand chat' : 'Collapse chat');
    collapse.setAttribute('aria-expanded', String(!model.collapsed));
    frag.append(settings, collapse);
    this.tabsEl.replaceChildren(frag);
  }
  private addUnread(btn: HTMLElement, tab: ChatTab): void {
    const important = tab.channel === ChatChannel.PRIVATE || !!tab.unreadMentions,
      badge = element('span', important ? 'badge' : 'unread-dot');
    badge.textContent = important ? (tab.unread > 99 ? '99+' : String(tab.unread)) : '•';
    badge.setAttribute(
      'aria-label',
      `${tab.unread} unread${tab.unreadMentions ? ', including mentions' : ''}`,
    );
    btn.append(badge);
  }
  private renderContext(tab: ChatTab): void {
    const label = element('span', 'hud-chat-destination');
    label.textContent = tab.npcSession
      ? tab.label
      : tab.channel === ChatChannel.PRIVATE
        ? `Private · ${tab.label}`
        : tab.id === 'local'
          ? 'Local · nearby players'
          : tab.id === 'global'
            ? 'Global · everyone on this server'
            : tab.id === 'clan'
              ? 'Clan · members only'
              : tab.id === 'server'
                ? 'Activity · read-only'
                : tab.label;
    this.contextEl.replaceChildren(label);
    if (tab.channel === ChatChannel.PRIVATE) {
      const pin = button(tab.pinned ? 'Unpin' : 'Pin', 'hud-chat-context-action');
      pin.addEventListener('click', () => {
        this.model?.togglePin(tab.id);
        this.update();
      });
      this.contextEl.append(pin);
    }
    if (tab.closable) {
      const close = button('Close', 'hud-chat-context-action');
      close.dataset['close'] = tab.id;
      close.addEventListener('click', () => this.closeTab(tab));
      this.contextEl.append(close);
    }
  }
  private activate(id: ChatTabId): void {
    this.savePosition();
    this.model?.setActive(id);
    this.update();
    if (!this.model?.collapsed) this.input.focus();
  }
  private closeTab(tab: ChatTab): void {
    if (tab.pending || tab.draft?.trim()) {
      this.model?.noteInActive(
        tab.pending
          ? 'Wait for this send to finish before closing.'
          : 'Send or clear this draft before closing.',
      );
      this.update();
      return;
    }
    if (tab.npcSession) this.delegates?.onNpcClose?.(tab.npcSession);
    this.model?.closeTab(tab.id);
    this.positions.delete(tab.id);
    this.update();
  }
  private atBottom(): boolean {
    return (
      this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - SCROLL_SLACK_PX
    );
  }
  private savePosition(): void {
    if (this.renderedTabId && !this.model?.collapsed && this.settingsEl.hidden)
      this.positions.set(this.renderedTabId, {
        top: this.logEl.scrollTop,
        latest: this.atBottom(),
      });
  }
  private appendNewLines(tab: ChatTab): void {
    const el = this.logEl,
      atBottom = this.atBottom(),
      oldHeight = el.scrollHeight;
    let removed = false;
    while (
      el.firstElementChild &&
      Number((el.firstElementChild as HTMLElement).dataset['id']) < (tab.lines[0]?.id ?? Infinity)
    ) {
      el.firstElementChild.remove();
      removed = true;
    }
    if (removed && !atBottom) el.scrollTop -= oldHeight - el.scrollHeight;
    let appended = false;
    for (const line of tab.lines) {
      if (line.id <= this.renderedLastLineId) continue;
      el.append(this.lineNode(line));
      this.renderedLastLineId = line.id;
      appended = true;
    }
    if (tab.lines.length === 0) this.renderedLastLineId = 0;
    if (appended && atBottom) el.scrollTop = el.scrollHeight;
  }
  private lineNode(line: ChatLine): HTMLElement {
    const row = element('div', `hud-chat-line kind-${line.kind}`);
    row.dataset['id'] = String(line.id);
    if (line.self) row.classList.add('is-self');
    if (line.admin) row.classList.add('is-admin');
    if (line.mention) row.classList.add('is-mention');
    const time = element('span', 'time');
    time.textContent = clock(line.time);
    row.append(time);
    const body = element('span', 'message');
    if (line.pid >= 0 || line.npcSession) {
      const who = line.npcSession ? element('span', 'who') : button('', 'who');
      if (!line.npcSession) {
        who.dataset['pid'] = String(line.pid);
        who.setAttribute('aria-label', `Actions for ${line.name}`);
        who.title = 'Player actions · double-click to message';
      }
      const badges = badgeNodes(document, line.badges ?? []);
      if (line.kind === 'broadcast') who.append(`[${line.name}`, ...badges, ']');
      else who.append(line.name, ...badges, ':');
      body.append(who);
    }
    const text = element('span', 'text');
    if (line.npcSession) {
      for (const part of npcKeywords(line.text)) {
        if (!part.keyword) {
          text.append(document.createTextNode(part.text));
          continue;
        }
        const pill = button(part.text, 'hud-chat-keyword');
        pill.dataset['npcRevision'] = String(line.npcRevision);
        pill.addEventListener('click', () =>
          this.delegates?.onNpcKeyword?.(line.npcSession!, line.npcRevision!, part.text),
        );
        text.append(pill);
      }
    } else text.textContent = line.text;
    body.append(text);
    row.append(body);
    return row;
  }
  notice(line: ChatLine, tab: ChatTab): void {
    if (!this.mounted) return;
    for (const previous of this.noticesEl.querySelectorAll<HTMLElement>('[data-tab]'))
      if (previous.dataset['tab'] === tab.id) this.removeNotice(previous);
    const card = button('', 'hud-chat-notice');
    card.dataset['tab'] = tab.id;
    const head = element('span', 'head'),
      title = element('span', 'title'),
      kicker = element('span', 'kicker');
    title.textContent = line.name;
    kicker.textContent =
      tab.channel === ChatChannel.PRIVATE
        ? 'Private message'
        : line.mention
          ? `Mention · ${tab.label}`
          : `${tab.label} message`;
    head.append(title, kicker);
    const text = element('span', 'text');
    text.textContent = line.text;
    card.append(head, text);
    card.addEventListener('click', () => {
      this.removeNotice(card);
      this.activate(tab.id);
      this.focus();
    });
    this.noticesEl.append(card);
    while (this.noticesEl.childElementCount > NOTICE_MAX)
      this.removeNotice(this.noticesEl.firstElementChild as HTMLElement);
    this.noticeTimers.set(
      card,
      setTimeout(() => this.removeNotice(card), NOTICE_LIFE_MS),
    );
  }
  private removeNotice(card: HTMLElement): void {
    clearTimeout(this.noticeTimers.get(card));
    this.noticeTimers.delete(card);
    card.remove();
  }
  private updateCapacity(): void {
    const bytes = this.model?.messageBytes(this.input.value) ?? 0;
    this.countEl.textContent = `${bytes} / ${MAX_CHAT_BYTES}`;
    this.countEl.hidden = bytes < 160;
    this.countEl.classList.toggle('is-over', bytes > MAX_CHAT_BYTES);
    this.countEl.title = 'UTF-8 bytes; accented letters and emoji use more space';
    this.hintEl.textContent = this.model?.active.pending
      ? 'Sending… draft kept until confirmed'
      : 'Enter send · Esc leave typing · /help';
  }
  private submit(): void {
    const model = this.model;
    if (!model || model.active.pending) return;
    const source = model.active,
      text = this.input.value;
    model.setDraft(source.id, text);
    if (!text.trim()) {
      this.blur();
      return;
    }
    const accepted = this.delegates?.onSubmit(text);
    if (accepted === false) {
      this.update();
      this.input.focus();
      return;
    }
    this.history.push(text);
    if (this.history.length > HISTORY_MAX) this.history.shift();
    this.historyIndex = -1;
    this.historyDraft = '';
    if (!source.pending) model.setDraft(source.id, '');
    this.hideSuggestions();
    this.update();
    if (!this.settings.stayTyping) this.blur();
    else this.input.focus();
  }
  private hideSuggestions(): void {
    this.completion = null;
    this.suggestions.hidden = true;
    this.suggestions.replaceChildren();
  }
  private suggest(): void {
    this.hideSuggestions();
    const end = this.input.selectionStart ?? this.input.value.length,
      before = this.input.value.slice(0, end);
    const whisper = /^(?:\/(?:w|whisper)\s+|!priv(?:ate)?=)([^\s"]*)$/i.exec(before),
      mention = /(?:^|\s)@([^@\s]*)$/.exec(before),
      match = whisper ?? mention;
    if (!match) return;
    const prefix = match[1]!,
      values =
        this.model
          ?.completePlayers(prefix)
          .map((p) => ({ label: p.label, text: whisper ? p.whisper : p.mention })) ?? [];
    if (!values.length) return;
    this.completion = { start: end - prefix.length, end, values, index: 0 };
    this.suggestions.hidden = false;
    values.forEach((value, index) => {
      const choice = button(value.label, 'hud-chat-suggestion');
      choice.classList.toggle('is-active', index === 0);
      choice.addEventListener('mousedown', (e) => e.preventDefault());
      choice.addEventListener('click', () => this.acceptSuggestion(index));
      this.suggestions.append(choice);
    });
  }
  private acceptSuggestion(index: number): void {
    const completion = this.completion;
    if (!completion) return;
    const value = completion.values[index];
    if (!value) return;
    const suffix = this.input.value.slice(completion.end),
      replacement = value.text + (suffix.startsWith(' ') ? '' : ' ');
    this.input.value = this.input.value.slice(0, completion.start) + replacement + suffix;
    const caret = completion.start + replacement.length;
    this.input.setSelectionRange(caret, caret);
    this.input.focus();
    this.model?.setDraft(this.model.active.id, this.input.value);
    this.updateCapacity();
    this.hideSuggestions();
  }
  private bind(): void {
    this.tabsEl.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      if (target.closest('[data-collapse]')) {
        this.savePosition();
        this.model?.setCollapsed(!this.model.collapsed);
        this.blur();
        this.update();
        return;
      }
      const tab = target.closest<HTMLElement>('[data-tab]');
      if (tab) this.activate(tab.dataset['tab'] as ChatTabId);
    });
    this.logEl.addEventListener('scroll', () => {
      this.savePosition();
      this.syncReading();
      this.renderedVersion = -1;
      this.update();
    });
    const playerMenu = (ev: MouseEvent) => {
      const who = (ev.target as HTMLElement).closest<HTMLElement>('.who[data-pid]');
      if (!who || !this.delegates?.onPlayerMenu) return;
      ev.preventDefault();
      const rect = who.getBoundingClientRect(),
        text = who.closest('.hud-chat-line')?.querySelector('.text')?.textContent ?? '';
      this.delegates.onPlayerMenu(
        Number(who.dataset['pid']),
        ev.clientX || rect.left,
        ev.clientY || rect.bottom,
        text,
      );
    };
    this.logEl.addEventListener('click', (ev) => {
      clearTimeout(this.playerMenuTimer);
      if (ev.detail === 0) playerMenu(ev);
      else if (ev.detail === 1) this.playerMenuTimer = setTimeout(() => playerMenu(ev), 250);
    });
    this.logEl.addEventListener('contextmenu', (ev) => {
      clearTimeout(this.playerMenuTimer);
      playerMenu(ev);
    });
    this.tabsEl.addEventListener('contextmenu', (ev) => {
      const tab = this.model?.tab(
        (ev.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset['tab'] as ChatTabId,
      );
      if (tab?.channel === ChatChannel.PRIVATE && tab.peer !== undefined) {
        ev.preventDefault();
        this.delegates?.onPlayerMenu?.(tab.peer, ev.clientX, ev.clientY);
      }
    });
    this.logEl.addEventListener('dblclick', (ev) => {
      clearTimeout(this.playerMenuTimer);
      const who = (ev.target as HTMLElement).closest<HTMLElement>('.who[data-pid]');
      if (who) this.delegates?.onOpenPrivate(Number(who.dataset['pid']));
    });
    this.input.addEventListener('input', () => {
      if (this.model) this.model.setDraft(this.model.active.id, this.input.value);
      this.updateCapacity();
      this.suggest();
    });
    this.input.addEventListener('keydown', (ev) => {
      if (ev.isComposing) {
        ev.stopPropagation();
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (this.completion) this.acceptSuggestion(this.completion.index);
        else this.submit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        if (this.completion) this.hideSuggestions();
        else {
          if (this.model) this.model.setDraft(this.model.active.id, this.input.value);
          this.blur();
        }
      } else if (ev.key === 'Tab') {
        if (ev.ctrlKey) {
          ev.preventDefault();
          this.model?.cycle(ev.shiftKey ? -1 : 1);
          this.update();
        } else if (this.completion) {
          ev.preventDefault();
          this.acceptSuggestion(this.completion.index);
        } else if (!ev.shiftKey) {
          this.suggest();
          if (this.completion) {
            ev.preventDefault();
            this.acceptSuggestion(0);
          }
        }
      } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        const direction = ev.key === 'ArrowUp' ? -1 : 1;
        if (this.completion) {
          this.completion.index =
            (this.completion.index + direction + this.completion.values.length) %
            this.completion.values.length;
          [...this.suggestions.children].forEach((el, i) =>
            el.classList.toggle('is-active', i === this.completion!.index),
          );
        } else this.recall(direction);
      }
      ev.stopPropagation();
    });
    this.root.addEventListener('keydown', (ev) => {
      // Buttons keep native keyboard navigation, while movement keys still
      // work after clicking Send or Collapse. Form fields always consume keys.
      if (
        (ev.target as HTMLElement).matches('input, select') ||
        ['Enter', ' ', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(
          ev.key,
        )
      )
        ev.stopPropagation();
    });
    // Let keyup reach the tracker so keys held before clicking a control cannot stick.
    this.root.addEventListener('focusin', (ev) => {
      if ((ev.target as HTMLElement).matches('input, select'))
        this.delegates?.onFocusChange?.(true);
    });
    this.root.addEventListener('focusout', (ev) => {
      if ((ev.target as HTMLElement).matches('input, select'))
        this.delegates?.onFocusChange?.(false);
      if ((ev.target as HTMLElement).matches('.hud-chat-conversations')) this.renderedVersion = -1;
    });
  }
  private recall(direction: 1 | -1): void {
    if (!this.history.length || this.model?.active.pending) return;
    if (this.historyIndex < 0) {
      if (direction > 0) return;
      this.historyDraft = this.input.value;
      this.historyIndex = this.history.length;
    }
    const next = this.historyIndex + direction;
    if (next < 0) return;
    this.historyIndex = next >= this.history.length ? -1 : next;
    this.input.value = this.historyIndex < 0 ? this.historyDraft : this.history[this.historyIndex]!;
    if (this.model) this.model.setDraft(this.model.active.id, this.input.value);
    this.updateCapacity();
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}
function button(text: string, className: string): HTMLButtonElement {
  const el = element('button', className);
  el.type = 'button';
  el.textContent = text;
  return el;
}
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
