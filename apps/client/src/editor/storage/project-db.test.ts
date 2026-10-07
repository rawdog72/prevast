// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createProject } from '../../../../../shared/typescript/scenario-schema';
import { ProjectDb } from './project-db';

const project = (title = 'Bunker') => createProject({ id: 'prj-1', title, tilesX: 20, tilesY: 20 });

describe('ProjectDb', () => {
  it('saves revisions, keeps the previous one and clears the draft', async () => {
    const db = new ProjectDb('t1', new IDBFactory());
    await db.putDraft(project('Draft'), 0);
    expect((await db.list())[0]).toMatchObject({ id: 'prj-1', draftBase: 0, title: 'Draft' });
    expect(await db.save(project('One'), 0)).toEqual({ ok: true, revision: 1 });
    expect(await db.loadDraft('prj-1')).toBeUndefined();
    expect(await db.save(project('Two'), 1)).toEqual({ ok: true, revision: 2 });
    const record = await db.load('prj-1');
    expect(record?.project).toMatchObject({ title: 'Two', revision: 2 });
    expect(record?.previous).toMatchObject({ title: 'One', revision: 1 });
  });

  it('refuses to overwrite a revision saved by someone else', async () => {
    const db = new ProjectDb('t2', new IDBFactory());
    await db.save(project('Tab A'), 0);
    expect(await db.save(project('Tab B'), 0)).toEqual({ ok: false, conflict: true, storedRevision: 1 });
    expect((await db.load('prj-1'))?.title).toBe('Tab A');
  });

  it('reports unavailable storage instead of throwing on save', async () => {
    const db = new ProjectDb('t3', undefined);
    const outcome = await db.save(project(), 0);
    expect(outcome.ok).toBe(false);
  });
});
