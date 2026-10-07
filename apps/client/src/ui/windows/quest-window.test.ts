// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { QuestAction, QuestCause, type QuestEntry } from '../../../../../shared/typescript/quest-protocol';
import { dispatchServerMessage } from '../../net/dispatcher';
import { NetEventBus } from '../../net/events';
import { progressPacket, questEntry, statePacket } from '../../net/quest-fixtures';
import { QuestStore } from '../../world/quest-store';
import { HudQuestTracker } from '../hud/hud-quest-tracker';
import { QuestWindow } from './quest-window';

function setup(entries: [number, QuestEntry][]) {
  const bus = new NetEventBus();
  const quests = new QuestStore(() => 0);
  quests.attachBus(bus);
  for (const [id, entry] of entries) dispatchServerMessage(statePacket(id, QuestCause.STARTED, JSON.stringify(entry)), bus);
  const socket = { questAction: vi.fn() };
  const body = document.createElement('div');
  return { bus, quests, socket, body };
}

const finished = questEntry({
  key: 'supplies', name: 'A Little Firewood', state: 'completed', stage: '',
  ending: 'Mara paid you 100 caps. <img src=x onerror=alert(1)>',
  stages: [{ key: 'firewood', journal: 'Bring wood and say {finish}.', current: false, outcome: 'wood', rewards: '100 caps', objectives: [] }],
});

describe('QuestWindow', () => {
  it('shows the current stage with objective rows and keyword markup as text', () => {
    const { quests, socket, body } = setup([[0, questEntry({ stages: [{ ...questEntry().stages[0]!, journal: 'Kill 3, then say {ghouls}.' }] })]]);
    new QuestWindow().mount(body, { quests, socket });
    expect(body.querySelector('.dv-quest-title')!.textContent).toBe('Clear the Road');
    expect(body.querySelector('.dv-quest-journal')!.textContent).toBe('Kill 3, then say ghouls.');
    expect(body.querySelector('.dv-quest-keyword')!.textContent).toBe('ghouls');
    const rows = [...body.querySelectorAll('.dv-quest-objective')];
    expect(rows.map((r) => r.textContent)).toEqual(['Defeat normal ghouls0/3', 'Report to Rook']);
    expect(rows[1]!.classList.contains('is-locked')).toBe(true);
  });

  it('lists finished quests with their ending and what each stage paid, never as HTML', () => {
    const { quests, socket, body } = setup([[1, finished]]);
    const win = new QuestWindow();
    win.mount(body, { quests, socket });
    expect(body.textContent).toContain('No quests yet');
    [...body.querySelectorAll<HTMLButtonElement>('.dv-quest-tab')].find((b) => b.textContent!.startsWith('Completed'))!.click();
    expect(body.querySelector('.dv-quest-ending')!.textContent).toContain('<img src=x');
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('.dv-quest-paid')!.textContent).toBe('Received 100 caps');
    expect(body.querySelector('.dv-quest-actions')).toBeNull();
  });

  it('abandons only after a confirming second click, and hides the button when the quest forbids it', () => {
    const { quests, socket, body } = setup([[7, questEntry()], [8, questEntry({ key: 'story', name: 'Story', abandon: false })]]);
    const win = new QuestWindow();
    win.mount(body, { quests, socket });
    const abandon = () => [...body.querySelectorAll<HTMLButtonElement>('.dv-quest-actions .dv-btn')].find((b) => /bandon/.test(b.textContent!));
    abandon()!.click();
    expect(socket.questAction).not.toHaveBeenCalled();
    expect(abandon()!.textContent).toBe('Really abandon?');
    abandon()!.click();
    expect(socket.questAction).toHaveBeenCalledWith(7, QuestAction.ABANDON);
    [...body.querySelectorAll<HTMLButtonElement>('.dv-quest-row')].find((b) => b.textContent!.includes('Story'))!.click();
    expect(abandon()).toBeUndefined();
  });

  it('select() opens the right tab on the right quest', () => {
    const { quests, socket, body } = setup([[0, questEntry()], [1, finished]]);
    const win = new QuestWindow();
    win.select('supplies', quests);
    win.mount(body, { quests, socket });
    expect(body.querySelector('.dv-quest-title')!.textContent).toContain('A Little Firewood');
  });
});

describe('give objectives', () => {
  it('show what is still in the bag, green once it covers what is owed', () => {
    const give = questEntry({ key: 'supplies', stages: [{ key: 'firewood', journal: 'Wood.', current: true, outcome: '', rewards: '', objectives: [
      { key: 'wood', text: 'Bring firewood', type: 'give', count: 4, required: 10, after: '', locked: false, item: 'wood' },
    ] }] });
    const { quests, socket, body } = setup([[0, give]]);
    let carried = 5;
    const win = new QuestWindow();
    win.mount(body, { quests, socket, bag: () => carried });
    expect(body.querySelector('.dv-quest-count')!.textContent).toBe('4/10');
    expect(body.querySelector('.dv-quest-bag')!.textContent).toBe('5 in bag');
    expect(body.querySelector('.dv-quest-bag')!.classList.contains('is-enough')).toBe(false);
    carried = 6;
    win.refresh({ quests, socket, bag: () => carried });
    expect(body.querySelector('.dv-quest-bag')!.classList.contains('is-enough')).toBe(true);
  });
});

describe('HudQuestTracker', () => {
  it('shows tracked quests with live counters and folds away', () => {
    const { bus, quests } = setup([[0, questEntry()]]);
    const root = document.createElement('div'), onOpen = vi.fn();
    const tracker = new HudQuestTracker();
    tracker.mount(root, { onOpen });
    tracker.update(quests, 0);
    expect(root.hidden).toBe(false);
    expect(root.querySelector('.hud-quest-name')!.textContent).toBe('Clear the Road');
    dispatchServerMessage(progressPacket(0, 0, 2), bus);
    tracker.update(quests, 16);
    expect(root.querySelector('.dv-quest-count')!.textContent).toBe('2/3');
    root.querySelector<HTMLButtonElement>('.hud-quest-name')!.click();
    expect(onOpen).toHaveBeenCalledWith('ghouls');
    root.querySelector<HTMLButtonElement>('.hud-quests-head')!.click();
    tracker.update(quests, 32);
    expect(root.querySelector('.hud-quest')).toBeNull();
  });

  it('hides when nothing is tracked', () => {
    const { quests } = setup([]);
    const root = document.createElement('div');
    const tracker = new HudQuestTracker();
    tracker.mount(root, { onOpen: () => {} });
    tracker.update(quests, 0);
    expect(root.hidden).toBe(true);
  });
});
