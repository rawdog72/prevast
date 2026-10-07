// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The World & Mode Editor (docs/world-editor.md). Owns one editor
// session: the DOM layout, the canvas and its render loop, input routing, commands, local
// storage and the walkthrough. stop() tears everything down -- listeners, frames, timers,
// storage handles -- so entering and leaving repeatedly leaks nothing.
import type { AssetLoader } from '../assets/asset-loader';
import type { ContentStore } from '../content/store';
import { baseWorldScale, Camera } from '../core/camera';
import { TILE_SIZE } from '../../../../shared/typescript/editor-limits';
import { gameplayHash } from '../../../../shared/typescript/scenario-canonical';
import {
  GRID_KINDS,
  SCENARIO_FILE_EXTENSION,
  createProject,
  newProjectId,
  parseProjectText,
  tileOf,
  type Diagnostic,
  type ScenarioProject,
  type ScenarioTemplate,
} from '../../../../shared/typescript/scenario-schema';
import { BuildingAnimator } from '../render/building-animator';
import { CharacterAnimator } from '../render/character-animator';
import { GameRenderer } from '../render/renderer';
import { EditorCatalog, type CatalogEntry, type EditorLayer } from './catalog/catalog';
import {
  createTemplate,
  deletionImpact,
  expandSelection,
  extractFragment,
  groupSelection,
  insertFragment,
  placeEntities,
  removeWithDependents,
  selectionBounds,
  snapPivot,
  topLevel,
  transformSelection,
  ungroup,
  type Fragment,
} from './document/ops';
import { SpatialIndex } from './document/spatial';
import { DocumentStore } from './document/store';
import { Selection, type EditorContext, type StatusTone } from './editor-context';
import { convertLegacy, describeImport, legacyStructures } from './io/legacy-map';
import { Walkthrough } from './preview/walkthrough';
import { drawGroupLabels, drawGrid, drawRegions, drawSelection, drawSpawns } from './scene/overlays';
import { OverviewBitmap } from './scene/overview';
import { SceneWorld } from './scene/scene-world';
import { ProjectChannel, ProjectDb, type ProjectSummary } from './storage/project-db';
import { EraseTool, FillTool, LineTool, PickTool, PlaceTool, RectTool } from './tools/paint-tools';
import { RegionTool } from './tools/region-tool';
import { SelectTool } from './tools/select-tool';
import type { PointerInfo, Tool, ToolId } from './tools/tool';
import { Dialogs } from './ui/dialogs';
import { button, downloadText, h, isTextTarget, slug } from './ui/dom';
import { InspectorPanel, withOptional } from './ui/inspector-panel';
import { LibraryPanel } from './ui/library-panel';
import { Minimap } from './ui/minimap';
import { IssuesPanel, LayersPanel, OutlinePanel } from './ui/outline-panel';
import { validateDocument } from './validation';

export interface WorldEditorOptions {
  content: ContentStore;
  assets: AssetLoader;
  onExit: () => void;
  host?: HTMLElement;
  /** Injected for tests. */
  db?: ProjectDb;
}

/** Above this many visible tiles the map is drawn from the overview bitmap. */
const DETAIL_TILE_LIMIT = 16000;
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 3;
const AUTOSAVE_MS = 4000;
const VALIDATE_DEBOUNCE_MS = 600;
const LAST_PROJECT_KEY = 'prevast.editor.lastProject';
const TEMPLATE_FORMAT = 'prevast-template';
/** Template files exported before the project was renamed. */
const LEGACY_TEMPLATE_FORMAT = 'devast-template';

type RightTab = 'inspect' | 'outline' | 'layers' | 'issues';

interface Session {
  store: DocumentStore;
  spatial: SpatialIndex;
  overview: OverviewBitmap;
  scene: SceneWorld;
  ctx: EditorContext;
  library: LibraryPanel;
  inspector: InspectorPanel;
  outline: OutlinePanel;
  layers: LayersPanel;
  issues: IssuesPanel;
  minimap: Minimap;
  unsubscribe: (() => void)[];
  /** Where this document came from, for the status line. */
  origin: 'new' | 'saved' | 'draft' | 'import';
  autosavedVersion: number;
  autosaveError: string | null;
  staleRevision: number | null;
  groupBounds: Map<string, ReturnType<typeof selectionBounds>>;
  groupBoundsVersion: number;
}

export class WorldEditor {
  private readonly content: ContentStore;
  private readonly assets: AssetLoader;
  private readonly onExit: () => void;
  private readonly host: HTMLElement;
  private readonly db: ProjectDb;
  private readonly catalog: EditorCatalog;
  private readonly camera = new Camera();
  private readonly renderer = new GameRenderer();
  private readonly buildingAnimator = new BuildingAnimator();
  private readonly characterAnimator = new CharacterAnimator();
  private readonly tools: Record<ToolId, Tool>;
  private tool: Tool;
  private session: Session | null = null;
  private clipboard: Fragment | null = null;
  private channel: ProjectChannel | null = null;
  private storageError: string | undefined;

  // DOM
  private root!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private g!: CanvasRenderingContext2D;
  private stage!: HTMLElement;
  private leftSlot!: HTMLElement;
  private rightBody!: HTMLElement;
  private tabButtons = new Map<RightTab, HTMLButtonElement>();
  private rightTab: RightTab = 'inspect';
  private toolButtons = new Map<ToolId, HTMLButtonElement>();
  private titleInput!: HTMLInputElement;
  private stateLabel!: HTMLElement;
  private statusCoords!: HTMLElement;
  private statusZoom!: HTMLElement;
  private statusSelection!: HTMLElement;
  private statusMessage!: HTMLElement;
  private toolOptions!: HTMLElement;
  private walkHud!: HTMLElement;
  private undoButton!: HTMLButtonElement;
  private redoButton!: HTMLButtonElement;
  private fileInput!: HTMLInputElement;
  private dialogs!: Dialogs;

  // runtime
  private running = false;
  private frame = 0;
  private lastTime = 0;
  private dpr = 1;
  private viewW = 1;
  private viewH = 1;
  private readonly cleanups: (() => void)[] = [];
  private autosaveTimer = 0;
  private validateTimer = 0;
  private panelsDirty = true;
  private pointer: PointerInfo | null = null;
  private pointerDown = false;
  private pan: { sx: number; sy: number; cx: number; cy: number } | null = null;
  private spaceHeld = false;
  private walk: Walkthrough | null = null;
  private walkHashBefore: Promise<string> | null = null;
  private diagnostics: Diagnostic[] = [];

  constructor(options: WorldEditorOptions) {
    this.content = options.content;
    this.assets = options.assets;
    this.onExit = options.onExit;
    this.host = options.host ?? document.body;
    this.db = options.db ?? new ProjectDb();
    this.catalog = EditorCatalog.fromContent(this.content);
    const pick = new PickTool(() => this.setTool('place'));
    this.tools = {
      select: new SelectTool(),
      place: new PlaceTool(),
      line: new LineTool(),
      rect: new RectTool(),
      fill: new FillTool(),
      erase: new EraseTool(),
      pick,
      region: new RegionTool(),
    };
    this.tool = this.tools.select;
  }

  // --- lifecycle ------------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.buildLayout();
    this.bindEvents();
    this.channel = new ProjectChannel((id, revision) => this.onForeignSave(id, revision));
    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.frame = requestAnimationFrame(loop);
      const delta = Math.min(100, Math.max(1, now - this.lastTime));
      this.lastTime = now;
      this.tick(delta, now);
    };
    this.frame = requestAnimationFrame(loop);
    this.autosaveTimer = window.setInterval(() => void this.autosave(), AUTOSAVE_MS);
    void this.showPicker(false);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.frame);
    clearInterval(this.autosaveTimer);
    clearTimeout(this.validateTimer);
    this.closeSession();
    for (const c of this.cleanups.splice(0)) c();
    this.channel?.close();
    this.channel = null;
    this.dialogs?.dispose();
    this.db.close();
    this.root?.remove();
  }

  private exit(): void {
    this.stop();
    this.onExit();
  }

  // --- layout ---------------------------------------------------------------------------------

  private buildLayout(): void {
    this.titleInput = h('input', { class: 'we-title', type: 'text', maxlength: 80, 'aria-label': 'Project title' });
    this.titleInput.addEventListener('change', () => {
      const v = this.titleInput.value.trim();
      if (v && this.session) this.session.store.setHeader({ title: v });
    });
    this.stateLabel = h('span', { class: 'we-state', role: 'status' });
    this.undoButton = button('↶', () => this.undo(), { class: 'we-icon', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo' });
    this.redoButton = button('↷', () => this.redo(), { class: 'we-icon', title: 'Redo (Ctrl+Y)', 'aria-label': 'Redo' });
    const tools = h('div', { class: 'we-tools', role: 'toolbar', 'aria-label': 'Tools' });
    for (const tool of Object.values(this.tools)) {
      const b = button(tool.label, () => this.setTool(tool.id), {
        class: 'we-tool',
        title: `${tool.label} (${tool.shortcut.toUpperCase()}) — ${tool.hint}`,
        'aria-pressed': String(tool === this.tool),
      });
      this.toolButtons.set(tool.id, b);
      tools.append(b);
    }
    this.toolOptions = h('div', { class: 'we-toolopts' });
    const menu = h(
      'div',
      { class: 'we-menu' },
      button('Projects', () => void this.showPicker(true), { title: 'New, open or import a project' }),
      button('Save', () => void this.save(), { title: 'Save (Ctrl+S)' }),
      button('Save copy', () => void this.saveCopy(), { title: 'Save as a new project with its own identity' }),
      button('Export', () => this.exportFile(), { title: 'Download the project file' }),
      button('Import', () => this.pickFile('project'), { title: 'Open a .prevast.json project or template file' }),
      button('Legacy map…', () => this.pickFile('legacy'), { title: 'Convert an old !b= map code or .map file' }),
    );
    const top = h(
      'header',
      { class: 'we-top' },
      h('strong', { class: 'we-brand' }, 'World Editor'),
      this.titleInput,
      this.stateLabel,
      menu,
      h('span', { class: 'we-sep' }),
      this.undoButton,
      this.redoButton,
      h('span', { class: 'we-sep' }),
      tools,
      this.toolOptions,
      h('span', { class: 'we-grow' }),
      button('Walk', () => this.toggleWalk(), { class: 'we-primary', title: 'Walk the map offline (P)' }),
      button('Help', () => void this.showHelp(), { title: 'Shortcuts (F1)' }),
      button('Exit', () => void this.requestExit(), { title: 'Back to the start screen' }),
    );
    this.leftSlot = h('aside', { class: 'we-left' });
    this.canvas = h('canvas', { class: 'we-canvas', tabindex: 0, 'aria-label': 'Map canvas' });
    this.g = this.canvas.getContext('2d', { alpha: false })!;
    this.walkHud = h('div', { class: 'we-walk-hud', hidden: true, role: 'status' });
    this.stage = h('main', { class: 'we-stage' }, this.canvas, this.walkHud);
    const tabs = h('div', { class: 'we-tabs', role: 'tablist' });
    for (const [tab, label] of [['inspect', 'Inspect'], ['outline', 'Outline'], ['layers', 'Layers'], ['issues', 'Issues']] as const) {
      const b = button(label, () => this.setRightTab(tab), { role: 'tab', 'aria-selected': String(tab === this.rightTab) });
      this.tabButtons.set(tab, b);
      tabs.append(b);
    }
    this.rightBody = h('div', { class: 'we-right-body' });
    const right = h('aside', { class: 'we-right' }, tabs, this.rightBody);
    this.statusCoords = h('span');
    this.statusZoom = h('span');
    this.statusSelection = h('span');
    this.statusMessage = h('span', { class: 'we-status-msg', 'aria-live': 'polite' });
    const status = h('footer', { class: 'we-status' }, this.statusCoords, this.statusZoom, this.statusSelection, this.statusMessage);
    this.fileInput = h('input', { type: 'file', hidden: true });
    this.root = h('div', { class: 'we-root', 'data-editor': 'world' }, top, this.leftSlot, this.stage, right, status, this.fileInput);
    this.host.append(this.root);
    this.dialogs = new Dialogs(this.root);
    const observer = new ResizeObserver(() => this.resizeCanvas());
    observer.observe(this.stage);
    this.cleanups.push(() => observer.disconnect());
    this.resizeCanvas();
    this.renderToolOptions();
  }

  private resizeCanvas(): void {
    const rect = this.stage.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.viewW = Math.max(1, Math.floor(rect.width));
    this.viewH = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.viewW * this.dpr);
    this.canvas.height = Math.floor(this.viewH * this.dpr);
    this.canvas.style.width = `${this.viewW}px`;
    this.canvas.style.height = `${this.viewH}px`;
    this.camera.setViewport(this.viewW, this.viewH);
  }

  private setRightTab(tab: RightTab): void {
    this.rightTab = tab;
    for (const [t, b] of this.tabButtons) b.setAttribute('aria-selected', String(t === tab));
    this.panelsDirty = true;
    if (tab === 'issues') this.revalidate();
  }

  private renderToolOptions(): void {
    const ctx = this.session?.ctx;
    this.toolOptions.replaceChildren();
    const rot = button(`⟳ ${((ctx?.placeRotation ?? 0) * 90)}°`, () => this.rotate(), { title: 'Rotate (R)', class: 'we-chip' });
    this.toolOptions.append(rot);
    if (this.tool.id === 'rect') {
      const filled = h('input', { type: 'checkbox', checked: ctx?.rectFilled ?? false });
      filled.addEventListener('change', () => ctx && (ctx.rectFilled = filled.checked));
      this.toolOptions.append(h('label', { class: 'we-check' }, filled, 'Filled'));
    }
    if (this.tool.id === 'region' && ctx) {
      for (const shape of ['circle', 'rect', 'polygon'] as const) {
        const b = button(shape === 'rect' ? 'Rectangle' : shape[0]!.toUpperCase() + shape.slice(1), () => {
          ctx.regionShape = shape;
          this.renderToolOptions();
        }, { class: 'we-chip', 'aria-pressed': String(ctx.regionShape === shape) });
        this.toolOptions.append(b);
      }
    }
    const grid = h('input', { type: 'checkbox', checked: ctx?.showGrid ?? true });
    grid.addEventListener('change', () => ctx && (ctx.showGrid = grid.checked));
    const night = h('input', { type: 'checkbox', checked: ctx?.night ?? false });
    night.addEventListener('change', () => ctx && (ctx.night = night.checked));
    this.toolOptions.append(h('label', { class: 'we-check' }, grid, 'Grid'), h('label', { class: 'we-check' }, night, 'Night'));
  }

  // --- sessions -------------------------------------------------------------------------------

  private openDocument(project: ScenarioProject, origin: Session['origin']): void {
    this.closeSession();
    const store = new DocumentStore(project);
    const spatial = new SpatialIndex(store, this.catalog);
    const overview = new OverviewBitmap(store, spatial, this.catalog);
    const scene = new SceneWorld(store, spatial, this.catalog, this.content);
    const selection = new Selection();
    const ctx: EditorContext = {
      store,
      spatial,
      catalog: this.catalog,
      content: this.content,
      assets: this.assets,
      camera: this.camera,
      selection,
      hiddenLayers: new Set(Object.entries(store.editor.layers ?? {}).filter(([, s]) => s.hidden).map(([k]) => k as EditorLayer)),
      lockedLayers: new Set(Object.entries(store.editor.layers ?? {}).filter(([, s]) => s.locked).map(([k]) => k as EditorLayer)),
      activeEntry: null,
      activeTemplate: null,
      placeRotation: 0,
      showGrid: true,
      night: store.header.world.time === 'night',
      rectFilled: false,
      regionShape: 'circle',
      offenders: new Set(),
      status: (m, tone) => this.status(m, tone),
      requestRender: () => {},
      notify: () => (this.panelsDirty = true),
    };
    const library = new LibraryPanel(ctx, {
      pickEntry: (entry) => this.pickEntry(entry),
      pickTemplate: (id) => {
        ctx.activeTemplate = id;
        ctx.activeEntry = null;
        this.setTool('place');
        this.status(`Click the map to place “${store.templates.get(id)?.name}”. R rotates.`);
        library.refresh();
      },
      toggleFavorite: (key) => {
        const favorites = new Set(store.editor.favorites ?? []);
        if (favorites.has(key)) favorites.delete(key);
        else favorites.add(key);
        store.setEditorMeta({ favorites: [...favorites] });
        library.refresh();
      },
      renameTemplate: (id) => void this.renameTemplate(id),
      deleteTemplate: (id) => void this.deleteTemplate(id),
      exportTemplate: (id) => this.exportTemplate(id),
      importStructures: () => this.importStructures(),
    });
    const inspector = new InspectorPanel(ctx, {
      group: (kind) => this.group(kind),
      ungroup: (id) => {
        ungroup(store, id);
        selection.clear();
      },
      saveTemplate: () => void this.saveTemplate(),
      remove: () => void this.deleteSelection(),
      duplicate: () => this.duplicate(),
      replaceWithActive: () => this.replaceWithActive(),
      addEffectArea: () => this.addEffectArea(),
      resize: (x, y, removeOutside) => this.resizeWorld(x, y, removeOutside),
      selectIds: (ids) => this.selectAndFocus(ids),
    });
    const outline = new OutlinePanel(ctx, (ids, additive) => {
      if (additive) selection.add(ids);
      else selection.set(ids);
      this.focusSelection(false);
    });
    const layers = new LayersPanel(ctx, () => {
      store.setEditorMeta({
        layers: Object.fromEntries(
          [...new Set([...ctx.hiddenLayers, ...ctx.lockedLayers])].map((l) => [l, { hidden: ctx.hiddenLayers.has(l) || undefined, locked: ctx.lockedLayers.has(l) || undefined }]),
        ),
      });
      scene.invalidate();
      selection.prune((id) => !!store.kindOf(id));
    });
    const issues = new IssuesPanel((id) => this.selectAndFocus([id]), () => this.revalidate());
    const minimap = new Minimap(this.camera, () => store.header.world, () => {});
    const session: Session = {
      store,
      spatial,
      overview,
      scene,
      ctx,
      library,
      inspector,
      outline,
      layers,
      issues,
      minimap,
      unsubscribe: [],
      origin,
      autosavedVersion: store.version,
      autosaveError: null,
      staleRevision: null,
      groupBounds: new Map(),
      groupBoundsVersion: -1,
    };
    session.unsubscribe.push(
      store.onChange((changes, source) => {
        this.panelsDirty = true;
        if (source !== 'preview') ctx.offenders.clear();
        if (changes.some((c) => c.kind !== 'entity' || !c.after)) selection.prune((id) => !!store.kindOf(id));
        this.scheduleValidation();
      }),
      selection.onChange(() => (this.panelsDirty = true)),
    );
    this.session = session;
    this.leftSlot.replaceChildren(library.root);
    this.stage.append(minimap.canvas);
    const cam = store.editor.camera;
    if (cam) {
      this.camera.x = cam.x;
      this.camera.y = cam.y;
      this.camera.setZoom(cam.zoom);
    } else this.fitMap();
    this.titleInput.value = store.header.title;
    this.renderToolOptions();
    this.panelsDirty = true;
    this.revalidate();
    try {
      localStorage.setItem(LAST_PROJECT_KEY, store.projectId);
    } catch {
      // Remembering the last project is a convenience only.
    }
  }

  private closeSession(): void {
    const s = this.session;
    if (!s) return;
    this.endWalk(false);
    this.tool.cancel?.(s.ctx);
    for (const u of s.unsubscribe) u();
    s.spatial.dispose();
    s.overview.dispose();
    s.minimap.dispose();
    s.minimap.canvas.remove();
    this.session = null;
  }

  private async showPicker(canCancel: boolean): Promise<void> {
    let projects: ProjectSummary[] = [];
    try {
      projects = await this.db.list();
      this.storageError = undefined;
    } catch (e) {
      this.storageError = (e as Error).message;
    }
    if (!this.running) return;
    const result = await this.dialogs.projectPicker(projects, canCancel && !!this.session, this.storageError);
    if (!this.running) return;
    switch (result.type) {
      case 'new': {
        if (this.session?.store.dirty && !(await this.confirmDiscard())) return;
        const project = createProject({ id: newProjectId(), title: result.title, tilesX: result.tilesX, tilesY: result.tilesY });
        this.openDocument(project, 'new');
        this.status(`Created ${result.tilesX}×${result.tilesY} project.`, 'ok');
        return;
      }
      case 'open':
        if (this.session?.store.dirty && this.session.store.projectId !== result.id && !(await this.confirmDiscard())) return;
        await this.openStored(result.id);
        return;
      case 'import':
        this.pickFile('project');
        return;
      default:
        if (!this.session) this.exit();
    }
  }

  private async confirmDiscard(): Promise<boolean> {
    const choice = await this.dialogs.choose(
      'Unsaved changes',
      'The open project has unsaved changes. Its autosaved draft stays recoverable from the project list.',
      [
        { value: 'save', label: 'Save first', tone: 'primary' },
        { value: 'continue', label: 'Continue without saving' },
        { value: 'cancel', label: 'Cancel' },
      ],
      'cancel',
    );
    if (choice === 'save') return (await this.save()) === true;
    if (choice === 'continue') await this.autosave(true);
    return choice === 'continue';
  }

  /** Opens a stored project, offering the autosaved draft when there is one. */
  private async openStored(id: string): Promise<void> {
    let saved;
    let draft;
    try {
      [saved, draft] = await Promise.all([this.db.load(id), this.db.loadDraft(id)]);
    } catch (e) {
      this.status(`Could not read the project: ${(e as Error).message}`, 'error');
      return;
    }
    let use: 'saved' | 'draft' = saved ? 'saved' : 'draft';
    if (saved && draft) {
      const choice = await this.dialogs.choose(
        'Recover unsaved work?',
        `An autosaved draft from ${new Date(draft.updatedAt).toLocaleString()} is newer than saved revision ${saved.revision}${draft.baseRevision !== saved.revision ? ` (the draft continued revision ${draft.baseRevision})` : ''}.`,
        [
          { value: 'draft', label: 'Recover the draft', tone: 'primary' },
          { value: 'saved', label: `Open saved revision ${saved.revision}` },
          { value: 'discard', label: 'Discard the draft', tone: 'danger' },
        ],
        'saved',
      );
      if (choice === 'discard') await this.db.discardDraft(id).catch(() => {});
      use = choice === 'draft' ? 'draft' : 'saved';
    }
    const record = use === 'draft' ? draft?.project : saved?.project;
    if (!record) {
      this.status('That project is no longer stored here.', 'error');
      return;
    }
    const result = parseProjectText(JSON.stringify(record));
    if (!result.project) {
      this.status('The stored project is damaged; see Issues.', 'error');
      this.diagnostics = result.diagnostics;
      return;
    }
    // A recovered draft keeps its base revision so a save still detects conflicts.
    const project: ScenarioProject = use === 'draft' ? { ...result.project, revision: draft!.baseRevision } : result.project;
    this.openDocument(project, use === 'draft' ? 'draft' : 'saved');
    const s = this.session!;
    if (use === 'draft') {
      s.store.savedVersion = -1; // recovered work is unsaved until saved
      if (saved && draft!.baseRevision !== saved.revision) s.staleRevision = saved.revision;
    }
    this.status(use === 'draft' ? 'Recovered the autosaved draft. Save to keep it as a revision.' : `Opened revision ${project.revision}.`, 'ok');
  }

  // --- saving ---------------------------------------------------------------------------------

  private contentManifest(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.content.manifest()).map(([k, v]) => [k, v.hash]));
  }

  /** Saves a new revision; true on success. */
  private async save(): Promise<boolean> {
    const s = this.session;
    if (!s) return false;
    if (s.store.inTransaction) return false;
    this.rememberCamera(s);
    const project = { ...s.store.toProject(), content: this.contentManifest() };
    const outcome = await this.db.save(project, s.store.revision);
    if (outcome.ok) {
      s.store.markSaved(outcome.revision, project.content);
      s.autosavedVersion = s.store.version;
      s.staleRevision = null;
      s.origin = 'saved';
      this.channel?.saved(project.id, outcome.revision);
      this.status(`Saved revision ${outcome.revision}.`, 'ok');
      this.panelsDirty = true;
      return true;
    }
    if (!outcome.conflict) {
      this.status(`Save failed: ${outcome.error}. Your work is still open — export it to keep a copy.`, 'error');
      return false;
    }
    const choice = await this.dialogs.choose(
      'Saved elsewhere',
      `Another tab or window saved revision ${outcome.storedRevision} of this project after you opened it. Saving now would overwrite that work.`,
      [
        { value: 'copy', label: 'Save as a copy', tone: 'primary' },
        { value: 'export', label: 'Export this version' },
        { value: 'cancel', label: 'Keep editing' },
      ],
      'cancel',
    );
    if (choice === 'copy') return this.saveCopy();
    if (choice === 'export') this.exportFile();
    s.staleRevision = outcome.storedRevision;
    return false;
  }

  /** Save a Copy: a new identity (and persistence namespace) for the same content. */
  private async saveCopy(): Promise<boolean> {
    const s = this.session;
    if (!s) return false;
    const title = await this.dialogs.prompt('Save a copy', 'Title of the copy', `${s.store.header.title} (copy)`);
    if (!title) return false;
    const project: ScenarioProject = { ...s.store.toProject(), id: newProjectId(), title, revision: 0 };
    this.openDocument(project, 'new');
    return this.save();
  }

  private async autosave(force = false): Promise<void> {
    const s = this.session;
    if (!s || this.storageError || s.store.inTransaction) return;
    if (!force && (s.store.version === s.autosavedVersion || !s.store.dirty)) return;
    const version = s.store.version;
    this.rememberCamera(s);
    try {
      await this.db.putDraft(s.store.toProject(), s.store.revision);
      s.autosavedVersion = version;
      if (s.autosaveError) {
        s.autosaveError = null;
        this.status('Autosave works again.', 'ok');
      }
    } catch (e) {
      s.autosaveError = (e as Error).message || 'storage full';
      this.status(`Autosave failed (${s.autosaveError}). Your work is still open — export it to keep a copy.`, 'error');
    }
    this.panelsDirty = true;
  }

  private onForeignSave(id: string, revision: number): void {
    const s = this.session;
    if (!s || s.store.projectId !== id || revision <= s.store.revision) return;
    s.staleRevision = revision;
    this.status(`Another tab saved revision ${revision} of this project. Saving here will offer a copy instead of overwriting.`, 'warn');
    this.panelsDirty = true;
  }

  // --- files ----------------------------------------------------------------------------------

  private exportFile(): void {
    const s = this.session;
    if (!s) return;
    this.rememberCamera(s);
    const project = { ...s.store.toProject(), content: this.contentManifest() };
    downloadText(`${slug(project.title)}${SCENARIO_FILE_EXTENSION}`, JSON.stringify(project, null, 1));
    this.status('Exported the project file.', 'ok');
  }

  private pickFile(kind: 'project' | 'legacy'): void {
    this.fileInput.accept = kind === 'project' ? '.json,application/json' : '.map,.txt,text/plain';
    this.fileInput.value = '';
    this.fileInput.onchange = () => {
      const file = this.fileInput.files?.[0];
      if (!file) return;
      void file.text().then(
        (text) => (kind === 'project' ? this.importProjectText(text) : this.importLegacyText(text, file.name.replace(/\.[^.]+$/, ''))),
        (e: Error) => this.status(`Could not read the file: ${e.message}`, 'error'),
      );
    };
    this.fileInput.click();
  }

  private async importProjectText(text: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.status('That file is not JSON.', 'error');
      return;
    }
    const format = raw && typeof raw === 'object' ? (raw as { format?: string }).format : undefined;
    if (format === TEMPLATE_FORMAT || format === LEGACY_TEMPLATE_FORMAT) {
      this.importTemplate(raw as { template?: ScenarioTemplate });
      return;
    }
    const result = parseProjectText(text);
    if (!result.project) {
      // The open document stays exactly as it was.
      this.diagnostics = result.diagnostics;
      this.rightTab = 'issues';
      this.panelsDirty = true;
      this.session?.issues.show(result.diagnostics);
      this.status(`Import refused: ${result.diagnostics[0]?.message ?? 'invalid project'}`, 'error');
      if (!this.session) void this.showPicker(false);
      return;
    }
    if (this.session?.store.dirty && !(await this.confirmDiscard())) return;
    let project = result.project;
    const existing = await this.db.load(project.id).catch(() => undefined);
    if (existing) {
      const choice = await this.dialogs.choose(
        'Project already stored',
        `This browser already has “${existing.title}” (revision ${existing.revision}) with the same identity.`,
        [
          { value: 'copy', label: 'Import as a new copy', tone: 'primary' },
          { value: 'same', label: 'Open with the same identity (saving may conflict)' },
          { value: 'cancel', label: 'Cancel' },
        ],
        'cancel',
      );
      if (choice === 'cancel') return;
      if (choice === 'copy') project = { ...project, id: newProjectId(), revision: 0 };
      else project = { ...project, revision: existing.revision };
    } else project = { ...project, revision: 0 };
    this.openDocument(project, 'import');
    this.session!.store.savedVersion = -1;
    const mismatch = this.compatibility(project);
    this.status(`Imported “${project.title}”.${mismatch ? ` ${mismatch}` : ''}`, mismatch ? 'warn' : 'ok');
  }

  /** Content fingerprint differences between the file's authoring content and this game. */
  private compatibility(project: ScenarioProject): string {
    if (!project.content) return '';
    const here = this.contentManifest();
    const changed = Object.entries(project.content).filter(([k, v]) => here[k] && here[k] !== v).map(([k]) => k);
    return changed.length ? `Authored against different content (${changed.join(', ')}); check Issues for missing pieces.` : '';
  }

  private async importLegacyText(text: string, name: string): Promise<void> {
    const s = this.session;
    if (!s) return;
    const result = convertLegacy(text, this.content, this.catalog);
    if (!result.accepted) {
      this.status(`Nothing to import: ${describeImport(result)}.`, 'error');
      return;
    }
    const choice = await this.dialogs.choose(
      'Convert legacy map',
      `${describeImport(result)}. The old format holds only placements: no groups, overrides or rules are inferred.`,
      [
        { value: 'insert', label: result.header.origin ? `Insert at origin ${result.header.origin.x},${result.header.origin.y}` : 'Insert at the view’s top-left tile', tone: 'primary' },
        { value: 'template', label: 'Save as a template' },
        { value: 'cancel', label: 'Cancel' },
      ],
      'cancel',
    );
    if (choice === 'cancel') return;
    const key = result.header.key ?? name;
    if (choice === 'template') {
      s.store.transact('Import template', () => {
        const id = s.store.allocId('t');
        s.store.put('template', { id, name: key, revision: 1, source: 'legacy-structure', ...result.fragment });
      });
      s.library.refresh();
      this.status(`Saved “${key}” as a template.`, 'ok');
      return;
    }
    const origin = result.header.origin ?? this.viewTopLeftTile();
    s.store.begin(`Import ${key}`);
    const groupId = s.store.allocId('g');
    s.store.put('group', { id: groupId, name: key, kind: 'group', pivot: { x: origin.x * TILE_SIZE, y: origin.y * TILE_SIZE } });
    const inserted = insertFragment(s.store, s.spatial, this.catalog, result.fragment, { x: origin.x * TILE_SIZE, y: origin.y * TILE_SIZE }, { parent: groupId });
    if (!inserted.ok) {
      s.store.cancel();
      s.ctx.offenders = new Set(inserted.offenders);
      this.status(`${inserted.reason} Nothing was imported.`, 'error');
      return;
    }
    s.store.commit();
    s.ctx.selection.set([groupId]);
    this.status(`Imported ${result.accepted} pieces as group “${key}”.`, 'ok');
  }

  private viewTopLeftTile(): { x: number; y: number } {
    const p = this.camera.screenToWorld(0, 0);
    return { x: Math.max(0, tileOf(p.x) + 1), y: Math.max(0, tileOf(p.y) + 1) };
  }

  private importStructures(): void {
    const s = this.session;
    if (!s) return;
    const existing = new Set([...s.store.templates.values()].map((t) => t.name));
    let added = 0;
    s.store.transact('Import game structures', () => {
      for (const { key, result } of legacyStructures(this.content, this.catalog)) {
        if (existing.has(key) || !result.accepted) continue;
        const id = s.store.allocId('t');
        s.store.put('template', { id, name: key, revision: 1, source: 'legacy-structure', ...result.fragment });
        added++;
      }
    });
    s.library.refresh();
    this.status(added ? `Added ${added} game structure template(s).` : 'All game structures are already templates.', 'ok');
  }

  private importTemplate(file: { template?: ScenarioTemplate }): void {
    const s = this.session;
    const t = file.template;
    if (!s || !t) {
      this.status('That template file is empty.', 'error');
      return;
    }
    // Validate by embedding it in a scratch project with the shared rules.
    const scratch = createProject({ id: 'prj-check', title: 'check', tilesX: 10, tilesY: 10 });
    scratch.templates = [t];
    const check = parseProjectText(JSON.stringify(scratch));
    if (!check.project) {
      this.status(`Template refused: ${check.diagnostics[0]?.message ?? 'invalid'}`, 'error');
      return;
    }
    s.store.transact('Import template', () => {
      const id = s.store.allocId('t');
      s.store.put('template', { ...structuredClone(t), id });
    });
    s.library.refresh();
    this.status(`Imported template “${t.name}”.`, 'ok');
  }

  private exportTemplate(id: string): void {
    const t = this.session?.store.templates.get(id);
    if (!t) return;
    downloadText(`${slug(t.name)}.template.json`, JSON.stringify({ format: TEMPLATE_FORMAT, schemaVersion: 1, template: t }, null, 1));
  }

  private async renameTemplate(id: string): Promise<void> {
    const s = this.session;
    const t = s?.store.templates.get(id);
    if (!s || !t) return;
    const name = await this.dialogs.prompt('Rename template', 'Name', t.name);
    if (!name) return;
    s.store.transact('Rename template', () => s.store.put('template', { ...t, name, revision: t.revision + 1 }));
    s.library.refresh();
  }

  private async deleteTemplate(id: string): Promise<void> {
    const s = this.session;
    const t = s?.store.templates.get(id);
    if (!s || !t) return;
    const users = [...s.store.groups.values()].filter((g) => g.template?.id === id);
    const choice = await this.dialogs.choose(
      `Delete template “${t.name}”?`,
      users.length
        ? `${users.length} placed cop${users.length === 1 ? 'y keeps' : 'ies keep'} their pieces but lose the link to this template.`
        : 'No placed copies use it.',
      [
        { value: 'delete', label: 'Delete template', tone: 'danger' },
        { value: 'cancel', label: 'Cancel' },
      ],
      'cancel',
    );
    if (choice !== 'delete') return;
    s.store.transact('Delete template', () => {
      for (const g of users) s.store.put('group', withOptional(g, 'template', undefined));
      s.store.remove('template', id);
    });
    if (s.ctx.activeTemplate === id) s.ctx.activeTemplate = null;
    s.library.refresh();
  }

  // --- commands -------------------------------------------------------------------------------

  private pickEntry(entry: CatalogEntry): void {
    const s = this.session;
    if (!s) return;
    s.ctx.activeEntry = entry;
    s.ctx.activeTemplate = null;
    if (!['place', 'line', 'rect', 'fill'].includes(this.tool.id)) this.setTool('place');
    if (!GRID_KINDS.has(entry.kind) && this.tool.id !== 'place') this.setTool('place');
    s.library.refresh();
    this.status(`Painting with ${entry.name}.${entry.rotatable ? ' R rotates.' : ''}`);
  }

  private setTool(id: ToolId): void {
    const s = this.session;
    if (s) this.tool.cancel?.(s.ctx);
    this.tool = this.tools[id];
    for (const [tid, b] of this.toolButtons) b.setAttribute('aria-pressed', String(tid === id));
    this.renderToolOptions();
    this.status(this.tool.hint);
  }

  private undo(): void {
    const s = this.session;
    if (!s || this.walk) return;
    this.tool.cancel?.(s.ctx);
    if (s.store.undo()) this.status(`Undid ${s.store.redoLabel ?? 'edit'}.`);
  }

  private redo(): void {
    const s = this.session;
    if (!s || this.walk) return;
    if (s.store.redo()) this.status(`Redid ${s.store.undoLabel ?? 'edit'}.`);
  }

  private async deleteSelection(): Promise<void> {
    const s = this.session;
    if (!s || !s.ctx.selection.size) return;
    const ids = topLevel(s.store, s.ctx.selection.values());
    const impact = deletionImpact(s.store, ids);
    if (impact.extra > 0) {
      const choice = await this.dialogs.choose(
        'Delete with dependents?',
        `Deleting the selection also removes ${impact.extra} dependent record(s): group contents and effect areas attached to the deleted pieces.`,
        [
          { value: 'delete', label: `Delete ${impact.total}`, tone: 'danger' },
          { value: 'cancel', label: 'Cancel' },
        ],
        'cancel',
      );
      if (choice !== 'delete') return;
    }
    const removed = removeWithDependents(s.store, ids);
    s.ctx.selection.clear();
    this.status(`Deleted ${removed.length}.`);
  }

  private copy(cut: boolean): void {
    const s = this.session;
    if (!s || !s.ctx.selection.size) return;
    this.clipboard = extractFragment(s.store, topLevel(s.store, s.ctx.selection.values())) ?? null;
    if (cut && this.clipboard) {
      removeWithDependents(s.store, topLevel(s.store, s.ctx.selection.values()));
      s.ctx.selection.clear();
    }
    this.status(`${cut ? 'Cut' : 'Copied'} ${this.clipboard?.entities.length ?? 0} placement(s).`);
  }

  private paste(): void {
    const s = this.session;
    if (!s || !this.clipboard) return;
    const at = this.pointer ? { x: this.pointer.tx * TILE_SIZE, y: this.pointer.ty * TILE_SIZE } : { x: this.viewTopLeftTile().x * TILE_SIZE, y: this.viewTopLeftTile().y * TILE_SIZE };
    const result = insertFragment(s.store, s.spatial, this.catalog, this.clipboard, at);
    if (!result.ok) {
      s.ctx.offenders = new Set(result.offenders);
      this.status(result.reason ?? 'Cannot paste here.', 'error');
      return;
    }
    s.ctx.selection.set(result.ids);
    this.status('Pasted with new identities.', 'ok');
  }

  private duplicate(): void {
    const s = this.session;
    if (!s || !s.ctx.selection.size) return;
    const ids = topLevel(s.store, s.ctx.selection.values());
    const fragment = extractFragment(s.store, ids);
    const bounds = selectionBounds(s.store, ids);
    if (!fragment || !bounds) return;
    const x0 = Math.floor(bounds.x0 / TILE_SIZE) * TILE_SIZE;
    const y0 = Math.floor(bounds.y0 / TILE_SIZE) * TILE_SIZE;
    // Try beside the original: right, below, left, above.
    const w = fragment.size.w * TILE_SIZE;
    const hgt = fragment.size.h * TILE_SIZE;
    for (const [dx, dy] of [[w, 0], [0, hgt], [-w, 0], [0, -hgt]] as const) {
      const result = insertFragment(s.store, s.spatial, this.catalog, fragment, { x: x0 + dx, y: y0 + dy });
      if (result.ok) {
        s.ctx.selection.set(result.ids);
        this.status('Duplicated with new identities.', 'ok');
        return;
      }
    }
    this.status('No free space next to the selection for a duplicate.', 'error');
  }

  private rotate(): void {
    const s = this.session;
    if (!s) return;
    if (this.tool.id === 'select' && s.ctx.selection.size) {
      const ids = topLevel(s.store, s.ctx.selection.values());
      const single = ids.length === 1 ? s.store.groups.get(ids[0]!) : undefined;
      const bounds = selectionBounds(s.store, ids)!;
      const hasGrid = [...expandSelection(s.store, ids)].some((id) => {
        const e = s.store.entities.get(id);
        return e && GRID_KINDS.has(e.kind);
      });
      const centre = { x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2 };
      // An odd-sized footprint turns about a tile centre, an even one about a corner.
      const oddW = Math.round((bounds.x1 - bounds.x0) / TILE_SIZE) % 2 === 1;
      const pivot = single?.pivot ?? (hasGrid ? snapPivot(centre, oddW) : { x: Math.round(centre.x), y: Math.round(centre.y) });
      const result = transformSelection(s.store, s.spatial, this.catalog, ids, { dx: 0, dy: 0, turns: 1, pivot });
      if (!result.ok) {
        s.ctx.offenders = new Set(result.offenders);
        this.status(`${result.reason ?? 'Cannot rotate here.'} Nothing changed.`, 'error');
      }
      return;
    }
    s.ctx.placeRotation = (s.ctx.placeRotation + 1) % 4;
    this.renderToolOptions();
  }

  private nudge(dx: number, dy: number, big: boolean): void {
    const s = this.session;
    if (!s || !s.ctx.selection.size) return;
    const ids = topLevel(s.store, s.ctx.selection.values());
    const hasGrid = [...expandSelection(s.store, ids)].some((id) => {
      const e = s.store.entities.get(id);
      return e && GRID_KINDS.has(e.kind);
    });
    const step = hasGrid ? TILE_SIZE * (big ? 5 : 1) : big ? 50 : 10;
    const result = transformSelection(s.store, s.spatial, this.catalog, ids, { dx: dx * step, dy: dy * step, turns: 0, pivot: { x: 0, y: 0 } });
    if (!result.ok) {
      s.ctx.offenders = new Set(result.offenders);
      this.status(`${result.reason ?? 'Cannot move there.'} Nothing changed.`, 'error');
    }
  }

  private group(kind: 'group' | 'house' | 'city'): void {
    const s = this.session;
    if (!s || !s.ctx.selection.size) return;
    const name = kind === 'city' ? 'City' : kind === 'house' ? 'House' : 'Group';
    const id = groupSelection(s.store, s.ctx.selection.values(), kind, `${name} ${s.store.groups.size + 1}`);
    if (id) {
      s.ctx.selection.set([id]);
      this.status(`Grouped as ${kind}. A label adds no gameplay by itself.`, 'ok');
    }
  }

  private async saveTemplate(): Promise<void> {
    const s = this.session;
    if (!s || !s.ctx.selection.size) return;
    const ids = topLevel(s.store, s.ctx.selection.values());
    const single = ids.length === 1 ? s.store.groups.get(ids[0]!) : undefined;
    const name = await this.dialogs.prompt('Save as template', 'Template name', single?.name ?? 'Template');
    if (!name) return;
    const id = s.store.transact('Save template', () => createTemplate(s.store, ids, name));
    s.library.refresh();
    if (id) this.status(`Saved template “${name}”. Pick it in the library to place copies.`, 'ok');
  }

  private replaceWithActive(): void {
    const s = this.session;
    const entry = s?.ctx.activeEntry;
    if (!s || !entry) return;
    const targets = [...expandSelection(s.store, s.ctx.selection.values())]
      .map((id) => s.store.entities.get(id))
      .filter((e) => e && e.kind === entry.kind && GRID_KINDS.has(e.kind) === GRID_KINDS.has(entry.kind));
    if (!targets.length) {
      this.status(`Nothing selected can become ${entry.name}.`, 'warn');
      return;
    }
    const replaced: string[] = [];
    s.store.transact(`Replace with ${entry.name}`, () => {
      for (const e of targets) {
        const { id: _id, overrides: _o, ...rest } = e!;
        removeWithDependents(s.store, [e!.id]);
        const draft = { ...rest, ref: entry.ref, variant: entry.variant, rotation: entry.rotatable ? e!.rotation : e!.kind === 'object' ? 0 : undefined };
        if (draft.variant === undefined) delete draft.variant;
        if (draft.rotation === undefined) delete draft.rotation;
        replaced.push(...placeEntities(s.store, s.spatial, this.catalog, [draft]));
      }
    });
    s.ctx.selection.set(replaced);
    this.status(`Replaced ${replaced.length} with ${entry.name}.`, 'ok');
  }

  private addEffectArea(): void {
    const s = this.session;
    const id = s?.ctx.selection.values()[0];
    const e = id ? s.store.entities.get(id) : undefined;
    if (!s || !e) return;
    const regionId = s.store.transact('Add effect area', () => {
      const rid = s.store.allocId('r');
      s.store.put('region', {
        id: rid,
        name: `${e.name ?? this.catalog.resolve(e.kind, e.ref, e.variant)?.name ?? e.ref} area`,
        attach: e.id,
        priority: 0,
        shape: { type: 'circle', x: 0, y: 0, r: 300 },
        effects: [{ stat: 'radiation', perMinute: 30, falloff: 'linear' }],
      });
      return rid;
    });
    s.ctx.selection.set([regionId]);
    this.status('Effect area added; it follows the piece. Adjust stat, rate and radius here.', 'ok');
  }

  private resizeWorld(tilesX: number, tilesY: number, removeOutside: boolean): void {
    const s = this.session;
    if (!s) return;
    s.store.transact('Resize map', () => {
      if (removeOutside) {
        const outside = [...s.store.entities.values()].filter((e) => e.x >= tilesX * TILE_SIZE || e.y >= tilesY * TILE_SIZE).map((e) => e.id);
        removeWithDependents(s.store, outside);
      }
      s.store.setHeader({ world: { ...s.store.header.world, tilesX, tilesY } });
    });
    this.status(`Map is now ${tilesX}×${tilesY} tiles.`, 'ok');
  }

  private selectAndFocus(ids: string[]): void {
    const s = this.session;
    if (!s) return;
    s.ctx.selection.set(ids.filter((id) => s.store.kindOf(id)));
    this.focusSelection(false);
    if (ids.length) this.setRightTab('inspect');
  }

  private focusSelection(zoom: boolean): void {
    const s = this.session;
    if (!s) return;
    const b = selectionBounds(s.store, s.ctx.selection.values());
    if (!b) return;
    this.camera.x = (b.x0 + b.x1) / 2;
    this.camera.y = (b.y0 + b.y1) / 2;
    if (zoom) {
      const z = Math.min(this.viewW / Math.max(400, b.x1 - b.x0), this.viewH / Math.max(400, b.y1 - b.y0)) * 0.8;
      this.camera.setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)));
    }
  }

  private fitMap(): void {
    const s = this.session;
    if (!s) return;
    const { tilesX, tilesY } = s.store.header.world;
    this.camera.x = (tilesX * TILE_SIZE) / 2;
    this.camera.y = (tilesY * TILE_SIZE) / 2;
    const z = Math.min(this.viewW / (tilesX * TILE_SIZE), this.viewH / (tilesY * TILE_SIZE)) * 0.92;
    this.camera.setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)));
  }

  private async requestExit(): Promise<void> {
    const s = this.session;
    if (s?.store.dirty) {
      const choice = await this.dialogs.choose(
        'Leave the editor?',
        'You have unsaved changes. Leaving keeps them as an autosaved draft you can recover from the project list.',
        [
          { value: 'save', label: 'Save and leave', tone: 'primary' },
          { value: 'leave', label: 'Leave (keep draft)' },
          { value: 'cancel', label: 'Stay' },
        ],
        'cancel',
      );
      if (choice === 'cancel') return;
      if (choice === 'save' && !(await this.save())) return;
      if (choice === 'leave') await this.autosave(true);
    }
    this.exit();
  }

  private async showHelp(): Promise<void> {
    const rows: [string, string][] = [
      ['V B L U G E I K', 'Select, paint, line, rectangle, fill, erase, eyedropper, region'],
      ['R', 'Rotate the selection (select tool) or the piece to place'],
      ['Wheel / middle drag / Space+drag', 'Zoom to cursor / pan'],
      ['WASD / arrows', 'Pan (nudge the selection with arrows; Shift = 5 tiles)'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo (a whole stroke or group edit is one step)'],
      ['Ctrl+C / X / V / D', 'Copy / cut / paste at cursor / duplicate'],
      ['Ctrl+G / Ctrl+Shift+G', 'Group / ungroup'],
      ['Delete', 'Delete the selection (asks when dependents go too)'],
      ['F / Home', 'Frame the selection / the whole map'],
      ['Ctrl+S', 'Save a revision'],
      ['P', 'Walk the map offline; Esc returns'],
    ];
    await this.dialogs.choose(
      'Shortcuts',
      h('dl', { class: 'we-help' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      [{ value: 'ok', label: 'Close' }],
      'ok',
    );
  }

  // --- walkthrough ----------------------------------------------------------------------------

  private toggleWalk(): void {
    if (this.walk) this.endWalk(true);
    else this.beginWalk();
  }

  private beginWalk(): void {
    const s = this.session;
    if (!s) return;
    this.tool.cancel?.(s.ctx);
    const walk = new Walkthrough(s.ctx);
    const at = this.pointer ? { x: this.pointer.wx, y: this.pointer.wy } : { x: this.camera.x, y: this.camera.y };
    if (!walk.enter(at)) {
      this.status('No free spot to stand near there. Place a player spawn or clear some ground.', 'error');
      return;
    }
    this.walkHashBefore = gameplayHash(s.store.toProject());
    this.walk = walk;
    s.scene.previewDoors = walk.doorState;
    s.scene.placeAvatar(walk.x, walk.y, walk.angle);
    this.root.classList.add('is-walking');
    this.walkHud.hidden = false;
    this.canvas.focus();
    this.status('Walkthrough: nothing you do here changes the project.');
  }

  private endWalk(report: boolean): void {
    const s = this.session;
    const walk = this.walk;
    if (!walk) return;
    this.walk = null;
    this.root.classList.remove('is-walking');
    this.walkHud.hidden = true;
    if (s) {
      s.scene.previewDoors = null;
      s.scene.removeAvatar();
      const before = this.walkHashBefore;
      if (report && before)
        void Promise.all([before, gameplayHash(s.store.toProject())]).then(([a, b]) => {
          if (a !== b) this.status('The project changed during the walkthrough — please report this.', 'error');
          else this.status('Back to editing. The project is unchanged.', 'ok');
        });
    }
    this.walkHashBefore = null;
  }

  private updateWalkHud(walk: Walkthrough): void {
    const here = walk.describeHere();
    this.walkHud.replaceChildren(
      h('strong', {}, 'Offline walkthrough'),
      h('p', {}, 'WASD move · Shift run · E open/close a door (preview only) · C collision ' + (walk.collision ? 'on' : 'OFF') + ' · Esc back to editing'),
      h('p', { class: 'we-muted' }, 'No server: combat, crafting, loot, creature AI, rules and real gauge changes happen only in a server test.'),
      here.length ? h('p', {}, `Here: ${here.join(' · ')}`) : '',
    );
  }

  // --- input ----------------------------------------------------------------------------------

  private bindEvents(): void {
    const c = this.canvas;
    const listen = <E extends Event>(el: EventTarget, type: string, fn: (ev: E) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanups.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    listen<PointerEvent>(c, 'pointerdown', (ev) => this.onPointerDown(ev));
    listen<PointerEvent>(c, 'pointermove', (ev) => this.onPointerMove(ev));
    listen<PointerEvent>(c, 'pointerup', (ev) => this.onPointerUp(ev));
    listen(c, 'pointercancel', () => this.cancelGesture());
    listen(c, 'pointerleave', () => (this.pointer = this.pointerDown ? this.pointer : null));
    listen<WheelEvent>(c, 'wheel', (ev) => this.onWheel(ev), { passive: false });
    listen(c, 'contextmenu', (ev) => ev.preventDefault());
    listen<KeyboardEvent>(window, 'keydown', (ev) => this.onKeyDown(ev));
    listen<KeyboardEvent>(window, 'keyup', (ev) => this.onKeyUp(ev));
    listen(window, 'blur', () => {
      this.spaceHeld = false;
      this.walk?.releaseKeys();
      this.cancelGesture();
    });
    listen(window, 'beforeunload', (ev) => {
      if (this.session?.store.dirty) {
        void this.autosave(true);
        ev.preventDefault();
      }
    });
  }

  private pointerInfo(ev: PointerEvent | WheelEvent): PointerInfo {
    const rect = this.canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const w = this.camera.screenToWorld(sx, sy);
    return {
      sx,
      sy,
      wx: w.x,
      wy: w.y,
      tx: Math.floor(w.x / TILE_SIZE),
      ty: Math.floor(w.y / TILE_SIZE),
      button: ev.button,
      shift: ev.shiftKey,
      ctrl: ev.ctrlKey || ev.metaKey,
      alt: ev.altKey,
    };
  }

  private onPointerDown(ev: PointerEvent): void {
    const s = this.session;
    if (!s) return;
    this.canvas.focus({ preventScroll: true });
    const p = this.pointerInfo(ev);
    this.pointer = p;
    if (ev.button === 1 || (ev.button === 0 && this.spaceHeld)) {
      this.pan = { sx: p.sx, sy: p.sy, cx: this.camera.x, cy: this.camera.y };
      this.canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      return;
    }
    if (this.walk) return;
    this.canvas.setPointerCapture(ev.pointerId);
    this.pointerDown = true;
    this.tool.down?.(s.ctx, p);
  }

  private onPointerMove(ev: PointerEvent): void {
    const s = this.session;
    if (!s) return;
    const p = this.pointerInfo(ev);
    this.pointer = p;
    if (this.pan) {
      this.camera.x = this.pan.cx - (p.sx - this.pan.sx) / this.camera.zoom;
      this.camera.y = this.pan.cy - (p.sy - this.pan.sy) / this.camera.zoom;
      return;
    }
    if (this.walk) {
      this.walk.aim(p.wx, p.wy);
      return;
    }
    this.tool.move?.(s.ctx, p, this.pointerDown);
  }

  private onPointerUp(ev: PointerEvent): void {
    const s = this.session;
    if (this.canvas.hasPointerCapture(ev.pointerId)) this.canvas.releasePointerCapture(ev.pointerId);
    if (this.pan) {
      this.pan = null;
      return;
    }
    if (!s || !this.pointerDown) return;
    this.pointerDown = false;
    this.tool.up?.(s.ctx, this.pointerInfo(ev));
  }

  private cancelGesture(): void {
    this.pan = null;
    if (this.pointerDown && this.session) this.tool.cancel?.(this.session.ctx);
    this.pointerDown = false;
  }

  private onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    if (this.walk) return;
    const p = this.pointerInfo(ev);
    const factor = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015));
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.camera.zoom * factor));
    // Keep the world point under the cursor fixed.
    this.camera.setZoom(zoom);
    const after = this.camera.screenToWorld(p.sx, p.sy);
    this.camera.x += p.wx - after.x;
    this.camera.y += p.wy - after.y;
  }

  private onKeyDown(ev: KeyboardEvent): void {
    const s = this.session;
    if (!s || !this.running) return;
    // Typing in a field, or a dialog being open, never reaches the canvas.
    if (isTextTarget(ev.target) || this.root.querySelector('dialog[open]')) return;
    if (!this.root.contains(ev.target as Node) && ev.target !== document.body) return;
    const key = ev.key.toLowerCase();
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (this.walk) {
      if (key === 'escape' || key === 'p') this.endWalk(true);
      else if (key === 'e') {
        if (this.walk.toggleDoor()) s.scene.invalidate();
      } else if (key === 'c') this.walk.collision = !this.walk.collision;
      else this.walk.keyDown(key);
      ev.preventDefault();
      return;
    }
    if (key === ' ') {
      this.spaceHeld = true;
      ev.preventDefault();
      return;
    }
    if (this.tool.key?.(s.ctx, ev)) {
      ev.preventDefault();
      return;
    }
    const handled = ((): boolean => {
      if (ctrl) {
        switch (key) {
          case 'z':
            if (ev.shiftKey) this.redo();
            else this.undo();
            return true;
          case 'y':
            this.redo();
            return true;
          case 's':
            void this.save();
            return true;
          case 'c':
            this.copy(false);
            return true;
          case 'x':
            this.copy(true);
            return true;
          case 'v':
            this.paste();
            return true;
          case 'd':
            this.duplicate();
            return true;
          case 'a':
            s.ctx.selection.set([...s.store.entities.keys()].filter((id) => !s.store.entities.get(id)!.parent).concat([...s.store.groups.values()].filter((g) => !g.parent).map((g) => g.id)));
            return true;
          case 'g':
            if (ev.shiftKey) {
              for (const id of s.ctx.selection.values()) if (s.store.groups.has(id)) ungroup(s.store, id);
              s.ctx.selection.clear();
            } else this.group('group');
            return true;
          default:
            return false;
        }
      }
      if (key === 'escape') {
        if (this.pointerDown) this.cancelGesture();
        else if (s.ctx.activeTemplate) {
          s.ctx.activeTemplate = null;
          s.library.refresh();
        } else s.ctx.selection.clear();
        this.tool.cancel?.(s.ctx);
        return true;
      }
      if (key === 'delete' || key === 'backspace') {
        void this.deleteSelection();
        return true;
      }
      if (key === 'r') {
        this.rotate();
        return true;
      }
      if (key === 'p') {
        this.toggleWalk();
        return true;
      }
      if (key === 'f') {
        this.focusSelection(true);
        return true;
      }
      if (key === 'home') {
        this.fitMap();
        return true;
      }
      if (key === 'f1' || key === '?') {
        void this.showHelp();
        return true;
      }
      const arrows: Record<string, [number, number]> = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
      if (arrows[key] && s.ctx.selection.size) {
        this.nudge(arrows[key]![0], arrows[key]![1], ev.shiftKey);
        return true;
      }
      const tool = Object.values(this.tools).find((t) => t.shortcut === key);
      if (tool) {
        this.setTool(tool.id);
        return true;
      }
      if (['w', 'a', 's', 'd', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'shift'].includes(key)) {
        this.heldPan.add(key);
        return true;
      }
      return false;
    })();
    if (handled) ev.preventDefault();
  }

  private readonly heldPan = new Set<string>();

  private onKeyUp(ev: KeyboardEvent): void {
    const key = ev.key.toLowerCase();
    if (key === ' ') this.spaceHeld = false;
    this.heldPan.delete(key);
    this.walk?.keyUp(key);
  }

  // --- frame ----------------------------------------------------------------------------------

  private revalidate(): void {
    const s = this.session;
    if (!s) return;
    clearTimeout(this.validateTimer);
    this.diagnostics = validateDocument(s.store.toProject(), this.catalog, s.spatial);
    s.issues.show(this.diagnostics);
    this.panelsDirty = true;
  }

  private scheduleValidation(): void {
    clearTimeout(this.validateTimer);
    // Large projects validate only when asked (Issues tab) or on a quiet moment.
    const delay = (this.session?.store.entities.size ?? 0) > 20000 ? VALIDATE_DEBOUNCE_MS * 8 : VALIDATE_DEBOUNCE_MS;
    this.validateTimer = window.setTimeout(() => this.revalidate(), delay);
  }

  private status(message: string, tone: StatusTone = 'info'): void {
    if (!this.statusMessage) return;
    this.statusMessage.textContent = message;
    this.statusMessage.dataset.tone = tone;
  }

  private tick(delta: number, now: number): void {
    const s = this.session;
    if (!s || document.hidden) return;
    this.applyHeldPan(delta);
    if (this.walk) {
      this.walk.update(delta);
      s.scene.placeAvatar(this.walk.x, this.walk.y, this.walk.angle);
      this.camera.x = this.walk.x;
      this.camera.y = this.walk.y;
      this.camera.setZoom(baseWorldScale(this.viewW, this.viewH));
      this.updateWalkHud(this.walk);
    }
    this.renderFrame(s, delta, now);
    if (this.panelsDirty) this.renderPanels(s);
  }

  private applyHeldPan(delta: number): void {
    if (!this.heldPan.size || this.walk) return;
    const speed = ((this.heldPan.has('shift') ? 2400 : 900) * delta) / 1000 / this.camera.zoom;
    const has = (...k: string[]) => k.some((x) => this.heldPan.has(x));
    const sel = this.session?.ctx.selection.size;
    // Arrows nudge a selection instead of panning (handled on keydown).
    const arrows = !sel;
    if (has('w') || (arrows && has('arrowup'))) this.camera.y -= speed;
    if (has('s') || (arrows && has('arrowdown'))) this.camera.y += speed;
    if (has('a') || (arrows && has('arrowleft'))) this.camera.x -= speed;
    if (has('d') || (arrows && has('arrowright'))) this.camera.x += speed;
  }

  private renderFrame(s: Session, delta: number, now: number): void {
    const g = this.g;
    const cam = this.camera;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const tl = cam.screenToWorld(0, 0);
    const br = cam.screenToWorld(this.viewW, this.viewH);
    const visibleTiles = ((br.x - tl.x) / TILE_SIZE) * ((br.y - tl.y) / TILE_SIZE);
    const detail = visibleTiles <= DETAIL_TILE_LIMIT || !!this.walk;
    const world = s.scene.world;
    world.clock.isNight = s.ctx.night;
    if (detail) {
      s.scene.sync(tl.x, tl.y, br.x, br.y, s.ctx.hiddenLayers);
      this.buildingAnimator.update(world, delta);
      this.characterAnimator.update(world, this.content, delta);
      world.entities.update(delta);
      this.renderer.render({
        ctx: g,
        camera: cam,
        world,
        content: this.content,
        assets: this.assets,
        buildingAnimator: this.buildingAnimator,
        animator: this.characterAnimator,
        timeMs: now,
      });
    } else {
      g.fillStyle = s.ctx.night ? GameRenderer.OUTSIDE_NIGHT_BG : GameRenderer.OUTSIDE_DAY_BG;
      g.fillRect(0, 0, this.viewW, this.viewH);
      g.save();
      cam.applyTransform(g);
      g.imageSmoothingEnabled = false;
      const { tilesX, tilesY } = s.store.header.world;
      g.drawImage(s.overview.bitmap(), 0, 0, tilesX * TILE_SIZE, tilesY * TILE_SIZE);
      g.restore();
    }
    g.save();
    cam.applyTransform(g);
    if (!this.walk) {
      if (detail && s.ctx.showGrid) drawGrid(g, s.ctx, tl.x, tl.y, br.x, br.y);
      drawRegions(g, s.ctx, tl.x, tl.y, br.x, br.y);
      drawSpawns(g, s.ctx, s.spatial.query(tl.x, tl.y, br.x, br.y));
      if (!detail) this.drawFreeDots(g, s, tl.x, tl.y, br.x, br.y);
      drawGroupLabels(g, s.ctx, (id) => this.groupBounds(s, id));
      drawSelection(g, s.ctx);
      this.tool.drawOverlay?.(s.ctx, g);
    } else {
      drawRegions(g, s.ctx, tl.x, tl.y, br.x, br.y);
    }
    g.restore();
    s.minimap.draw(s.overview);
    this.updateStatus(s);
  }

  /** At overview zoom, creatures/NPCs/spawns as dots (grid pieces are in the bitmap). */
  private drawFreeDots(g: CanvasRenderingContext2D, s: Session, x0: number, y0: number, x1: number, y1: number): void {
    const colours: Record<string, string> = { npc: '#ffd166', agent: '#ff6b6b', spawn: '#f2f4f6' };
    const r = 3 / this.camera.zoom;
    for (const id of s.spatial.query(x0, y0, x1, y1)) {
      const e = s.store.entities.get(id);
      if (!e || GRID_KINDS.has(e.kind)) continue;
      g.fillStyle = colours[e.kind] ?? '#fff';
      g.fillRect(e.x - r, e.y - r, r * 2, r * 2);
    }
  }

  private groupBounds(s: Session, id: string) {
    if (s.groupBoundsVersion !== s.store.version) {
      s.groupBounds.clear();
      s.groupBoundsVersion = s.store.version;
    }
    if (!s.groupBounds.has(id)) s.groupBounds.set(id, selectionBounds(s.store, [id]));
    return s.groupBounds.get(id);
  }

  private updateStatus(s: Session): void {
    const p = this.pointer;
    this.statusCoords.textContent = p ? `Tile ${p.tx}, ${p.ty} · ${Math.round(p.wx)}, ${Math.round(p.wy)}` : '—';
    this.statusZoom.textContent = `${Math.round(this.camera.zoom * 100)}%`;
    this.statusSelection.textContent = s.ctx.selection.size ? `${s.ctx.selection.size} selected` : '';
    this.canvas.style.cursor = this.pan ? 'grabbing' : this.spaceHeld ? 'grab' : this.walk ? 'default' : this.tool.cursor(s.ctx);
  }

  private renderPanels(s: Session): void {
    this.panelsDirty = false;
    const store = s.store;
    this.undoButton.disabled = !store.canUndo;
    this.redoButton.disabled = !store.canRedo;
    this.undoButton.title = store.undoLabel ? `Undo ${store.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    this.redoButton.title = store.redoLabel ? `Redo ${store.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
    if (document.activeElement !== this.titleInput) this.titleInput.value = store.header.title;
    const state = s.autosaveError
      ? 'Autosave failed'
      : s.staleRevision
        ? `Revision ${s.staleRevision} saved elsewhere`
        : store.dirty
          ? s.origin === 'draft'
            ? 'Recovered draft · unsaved'
            : 'Unsaved changes'
          : store.revision
            ? `Saved · rev ${store.revision}`
            : 'New · not saved';
    this.stateLabel.textContent = state;
    this.stateLabel.dataset.tone = s.autosaveError || s.staleRevision ? 'warn' : store.dirty ? 'dirty' : 'ok';
    const errors = this.diagnostics.filter((d) => d.severity === 'error').length;
    const issuesTab = this.tabButtons.get('issues');
    if (issuesTab) issuesTab.textContent = errors ? `Issues (${errors})` : 'Issues';
    switch (this.rightTab) {
      case 'inspect':
        s.inspector.render();
        this.rightBody.replaceChildren(s.inspector.root);
        break;
      case 'outline':
        s.outline.render();
        this.rightBody.replaceChildren(s.outline.root);
        break;
      case 'layers':
        s.layers.render();
        this.rightBody.replaceChildren(s.layers.root);
        break;
      default:
        this.rightBody.replaceChildren(s.issues.root);
    }
  }

  /** The view is editor metadata: stored with the project, never part of gameplay. */
  private rememberCamera(s: Session): void {
    s.store.setEditorMeta({
      camera: { x: Math.round(this.camera.x), y: Math.round(this.camera.y), zoom: Math.round(this.camera.zoom * 1000) / 1000 },
    });
  }
}

