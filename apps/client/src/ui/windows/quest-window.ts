// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/windows/quest-window.ts
// J: the quest journal. Active and finished quests on the left; on the right
// the selected quest's current stage (journal text and objective rows), then
// the stages already done with what each paid. Everything shown comes from the
// server's journal entries (QuestStore), which only ever hold stages the player
// has reached. Authored text is set as text, never parsed as HTML.

import { npcKeywords } from '../../../../../shared/typescript/npc-protocol';
import type { QuestEntry, QuestObjective } from '../../../../../shared/typescript/quest-protocol';
import type { QuestRecord, QuestStore } from '../../world/quest-store';
import type { ProgressStore } from '../../world/progress-store';
import type { ContentStore } from '../../content/store';
import { renderAchievements } from './achievements-panel';
import { icon } from '../dom/icons';

export interface QuestWindowDeps {
  quests: QuestStore;
  socket: { questAction(questId: number, action: number): void };
  /** The Achievements tab; without it the tab is not shown. */
  progress?: ProgressStore;
  content?: ContentStore;
  bag?: BagCount;
}

type Tab = 'active' | 'finished' | 'achievements';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/** Journal text keeps the NPC {keyword} markup; the keyword is shown emphasised, braces dropped. */
function journalText(className: string, text: string): HTMLParagraphElement {
  const p = el('p', className);
  for (const part of npcKeywords(text)) p.append(part.keyword ? el('strong', 'dv-quest-keyword', part.text) : part.text);
  return p;
}

/** How many of an item (by key) the player carries; the journal and tracker show it for give objectives. */
export type BagCount = (itemKey: string) => number;

/** A signature piece for everything bag counts would change on screen. */
export function bagSignature(records: QuestRecord[], bag: BagCount | undefined): string {
  if (!bag) return '';
  const parts: string[] = [];
  for (const { entry } of records)
    for (const s of entry.stages)
      if (s.current) for (const o of s.objectives) if (o.type === 'give' && o.item) parts.push(`${o.item}=${bag(o.item)}`);
  return parts.join(',');
}

export function objectiveRow(objective: QuestObjective, flashing = false, bag?: BagCount): HTMLElement {
  const done = objective.count >= objective.required;
  const row = el('div', 'dv-quest-objective');
  row.classList.toggle('is-done', done);
  row.classList.toggle('is-locked', objective.locked);
  row.classList.toggle('is-flash', flashing);
  const mark = el('span', 'dv-quest-mark');
  mark.innerHTML = done ? icon('check') : objective.locked ? icon('lock') : '';
  const count = objective.required > 1 ? `${Math.min(objective.count, objective.required)}/${objective.required}` : '';
  row.append(mark, el('span', 'dv-quest-objective-text', objective.text || objective.key), el('span', 'dv-quest-count', count));
  // Give: what is still in the bag, so the player knows whether to go back yet.
  if (bag && objective.type === 'give' && objective.item && !done) {
    const carried = bag(objective.item);
    const bagText = el('span', 'dv-quest-bag', `${carried} in bag`);
    bagText.classList.toggle('is-enough', carried >= objective.required - objective.count);
    row.append(bagText);
  }
  return row;
}

export class QuestWindow {
  private body!: HTMLElement;
  private signature = '';
  private tab: Tab = 'active';
  private selected = '';
  private confirmAbandon = false;

  mount(body: HTMLElement, d: QuestWindowDeps): void {
    this.body = body;
    this.signature = '';
    this.confirmAbandon = false;
    this.refresh(d);
  }

  /** Opens on a particular quest (the tracker's names link here). */
  select(key: string, quests: QuestStore): void {
    const record = quests.byKey(key);
    if (!record) return;
    this.tab = record.entry.state === 'active' ? 'active' : 'finished';
    this.selected = key;
    this.confirmAbandon = false;
    this.signature = '';
  }

  refresh(d: QuestWindowDeps): void {
    const signature = `${d.quests.version}:${d.progress?.version ?? 0}:${this.tab}:${this.selected}:${this.confirmAbandon}:${bagSignature(d.quests.active, d.bag)}`;
    if (signature === this.signature) return;
    this.signature = signature;

    const active = d.quests.active;
    const finished = d.quests.finished;
    const list = this.tab === 'active' ? active : finished;
    if (!list.some((r) => r.entry.key === this.selected)) {
      this.selected = list[0]?.entry.key ?? '';
      this.confirmAbandon = false;
    }

    this.body.replaceChildren();
    const tabs = el('div', 'dv-quest-tabs');
    const tabList: [Tab, string][] = [['active', `Active (${active.length})`], ['finished', `Completed (${finished.length})`]];
    if (d.progress) tabList.push(['achievements', 'Achievements']);
    for (const [tab, label] of tabList) {
      const button = el('button', 'dv-btn dv-quest-tab', label);
      button.type = 'button';
      button.classList.toggle('is-active', this.tab === tab);
      button.addEventListener('click', () => {
        this.tab = tab;
        this.confirmAbandon = false;
        this.refresh(d);
      });
      tabs.append(button);
    }
    this.body.append(tabs);

    if (this.tab === 'achievements' && d.progress) {
      const content = d.content;
      this.body.append(renderAchievements({
        progress: d.progress,
        achievements: content?.has('achievements') ? content.table('achievements') : undefined,
        stats: content?.has('stats') ? content.table('stats') : undefined,
      }));
      return;
    }

    if (!list.length) {
      this.body.append(
        el('p', 'dv-quest-empty', this.tab === 'active'
          ? 'No quests yet. An NPC with a ! over their head has work for you.'
          : 'No finished quests yet.'),
      );
      return;
    }

    const columns = el('div', 'dv-quest-columns');
    const nav = el('div', 'dv-quest-list');
    nav.setAttribute('role', 'listbox');
    for (const record of list) nav.append(this.listRow(record, d));
    const selected = list.find((r) => r.entry.key === this.selected)!;
    columns.append(nav, this.detail(selected, d));
    this.body.append(columns);
  }

  private listRow(record: QuestRecord, d: QuestWindowDeps): HTMLElement {
    const { entry } = record;
    const row = el('button', 'dv-quest-row');
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(entry.key === this.selected));
    row.classList.toggle('is-selected', entry.key === this.selected);
    row.classList.toggle('is-failed', entry.state === 'failed');
    const name = el('span', 'dv-quest-row-name', entry.name);
    row.append(name);
    if (entry.category === 'main') row.append(el('span', 'dv-quest-tag', 'Main'));
    if (d.quests.isTracked(entry.key) && entry.state === 'active') {
      const pin = el('span', 'dv-quest-pin');
      pin.innerHTML = icon('check');
      pin.title = 'Tracked';
      row.append(pin);
    }
    row.addEventListener('click', () => {
      this.selected = entry.key;
      this.confirmAbandon = false;
      this.refresh(d);
    });
    return row;
  }

  private detail(record: QuestRecord, d: QuestWindowDeps): HTMLElement {
    const { entry } = record;
    const detail = el('section', 'dv-quest-detail');
    const title = el('h3', 'dv-quest-title', entry.name);
    if (entry.state !== 'active') title.append(el('span', `dv-quest-state is-${entry.state}`, entry.state === 'completed' ? 'Completed' : 'Failed'));
    detail.append(title);
    if (entry.description) detail.append(journalText('dv-quest-description', entry.description));

    const current = entry.stages.find((s) => s.current);
    if (current) {
      const block = el('div', 'dv-quest-current');
      block.append(journalText('dv-quest-journal', current.journal));
      for (const objective of current.objectives) block.append(objectiveRow(objective, d.quests.isFlashing(entry.key, objective.key), d.bag));
      detail.append(block);
    }
    if (entry.ending) detail.append(journalText('dv-quest-ending', entry.ending));

    const done = entry.stages.filter((s) => !s.current);
    if (done.length) {
      detail.append(el('h4', 'dv-quest-subhead', 'Story so far'));
      const story = el('ol', 'dv-quest-story');
      for (const stage of [...done].reverse()) {
        const item = el('li');
        item.append(journalText('', stage.journal));
        if (stage.rewards) item.append(el('span', 'dv-quest-paid', `Received ${stage.rewards}`));
        story.append(item);
      }
      detail.append(story);
    }

    if (entry.state === 'active') detail.append(this.actions(entry, d));
    return detail;
  }

  private actions(entry: QuestEntry, d: QuestWindowDeps): HTMLElement {
    const bar = el('div', 'dv-quest-actions');
    const track = el('button', 'dv-btn', d.quests.isTracked(entry.key) ? 'Untrack' : 'Track');
    track.type = 'button';
    track.addEventListener('click', () => {
      d.quests.toggleTrack(entry.key);
      this.refresh(d);
    });
    const abandon = el('button', 'dv-btn is-danger', this.confirmAbandon ? 'Really abandon?' : 'Abandon');
    abandon.type = 'button';
    abandon.addEventListener('click', () => {
      if (!this.confirmAbandon) {
        this.confirmAbandon = true;
        this.refresh(d);
        return;
      }
      this.confirmAbandon = false;
      d.quests.abandon(d.socket, entry.key);
      this.refresh(d);
    });
    bar.append(track);
    if (entry.abandon) bar.append(abandon);
    return bar;
  }
}
