// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Attachment containers around the assembled weapon. Inventory hover/drag comes
// from the existing hotbar; every change waits for the authoritative server reply.
import { itemIconUrl } from '../../assets/asset-loader';
import type { ContentStore } from '../../content/store';
import type { NetEventBus } from '../../net/events';
import { StatusKind } from '../../net/opcodes';
import { describeView, effectiveView } from '../../world/aim-view';
import type { InventoryItem, InventoryStore } from '../../world/inventory-store';
import {
  SLOT_LABELS,
  artLayout,
  modByIid,
  resolveWeapon,
  slotForMod,
  slotIndex,
  statRows,
  weaponSlots,
  withMod,
  type ArtLayout,
  type FittedMod,
  type ModSlotName,
  type SlotDef,
  type StatRow,
} from '../../world/weapon-mods';

export interface ModsWindowDeps {
  inventory: InventoryStore;
  content: ContentStore;
  socket: { weaponMod(weaponUid: number, slot: number, modUid: number | null): void };
  onStatus?: (text: string) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
type ItemRef = { uid: number; iid: number };
interface PendingChange {
  weaponUid: number;
  slot: ModSlotName;
  iid: number;
  startedAt: number | null;
  ms: number;
  label: string;
  cancelArrival?: () => void;
}
interface ModDrag {
  slot: ModSlotName;
  iid: number;
  x: number;
  y: number;
  active: boolean;
}
interface Preview {
  slot: ModSlotName;
  iid: number;
  ammo: number;
  label: string;
}

export class ModsWindow {
  weaponUid = -1;
  private selected: ModSlotName | null = null;
  private hover: ModSlotName | null = null;
  private carried: ItemRef | null = null;
  private picked: ItemRef | null = null;
  private pending: PendingChange | null = null;
  private body: HTMLElement | null = null;
  private title: HTMLElement | null = null;
  private deps!: ModsWindowDeps;
  private stage!: HTMLElement;
  private picture!: HTMLElement;
  private connectors!: SVGSVGElement;
  private stats!: HTMLElement;
  private summary!: HTMLElement;
  private status!: HTMLElement;
  private remove!: HTMLButtonElement;
  private progress!: HTMLElement;
  private stageLabel!: HTMLElement;
  private slots = new Map<ModSlotName, HTMLButtonElement>();
  private observer: ResizeObserver | null = null;
  private layoutKey = '';
  private stateKey = '';
  private art: ArtLayout | null = null;
  private drag: ModDrag | null = null;
  private ghost: HTMLElement | null = null;
  private feedback = '';

  open(uid: number): void {
    this.endDrag();
    this.weaponUid = uid;
    this.selected = this.hover = null;
    this.carried = this.picked = null;
    this.feedback = '';
    this.layoutKey = this.stateKey = '';
  }

  weapon(inventory: InventoryStore): InventoryItem | undefined {
    return inventory.slots.find((s) => s.iid > 0 && s.uid === this.weaponUid);
  }

  mount(body: HTMLElement, deps: ModsWindowDeps, chrome?: { title: HTMLElement }): void {
    this.body = body;
    this.title = chrome?.title ?? null;
    this.layoutKey = this.stateKey = '';
    this.refresh(deps);
  }

  unmount(): void {
    this.endDrag();
    this.observer?.disconnect();
    this.observer = null;
    this.body = null;
    this.selected = this.hover = null;
    this.carried = this.picked = null;
  }

  /** Called each frame; identity, rather than an inventory position, pins a preview. */
  previewInventory(inventory: InventoryStore, index: number | null): void {
    const item = index === null ? undefined : inventory.getSlot(index);
    this.carried = item && item.iid > 0 ? { uid: item.uid, iid: item.iid } : null;
  }

  /** Click/touch alternative to dragging from the player's normal inventory. */
  inventoryClick(deps: ModsWindowDeps, index: number): boolean {
    const item = deps.inventory.getSlot(index);
    if (!item) return false;
    if (this.selected && !this.picked) {
      this.dropToInventory(deps, this.selected, index);
      return true;
    }
    const gun = this.weapon(deps.inventory);
    if (!gun || !modByIid(deps.content, item.iid)) return false;
    if (!slotForMod(deps.content, gun.iid, item.iid)) {
      this.notify(deps, "That mod doesn't fit this weapon.");
      return true;
    }
    this.picked = this.picked?.uid === item.uid ? null : { uid: item.uid, iid: item.iid };
    this.selected = null;
    this.refresh(deps);
    return true;
  }

  fitFromInventory(deps: ModsWindowDeps, index: number, target?: string | null): void {
    const gun = this.weapon(deps.inventory),
      item = deps.inventory.getSlot(index);
    if (!gun || !item || item.iid <= 0) return;
    const slot = slotForMod(deps.content, gun.iid, item.iid);
    if (!slot || (target !== undefined && target !== slot)) {
      this.notify(
        deps,
        target === null
          ? 'Drop onto a matching attachment slot.'
          : "That mod doesn't fit this slot.",
      );
      return;
    }
    this.request(deps, slot, item.uid, index);
  }

  /** Server updates can complete an operation even while this window is closed. */
  attachBus(bus: NetEventBus): () => void {
    const offs = [
      bus.on('startInteraction', (e) => {
        if (this.pending && this.pending.startedAt === null) {
          this.pending.startedAt = performance.now();
          this.pending.ms = e.delayMultiplier * 100;
        }
      }),
      bus.on('itemMods', (e) => {
        const p = this.pending;
        if (
          p &&
          e.uid === p.weaponUid &&
          (e.mods.find((m) => m.slot === slotIndex(p.slot))?.iid ?? 0) === p.iid
        )
          this.finish('Modification complete.');
      }),
      bus.on('interruptInteraction', () => {
        if (this.pending) this.finish('Modification interrupted.');
      }),
      bus.on('statusMessage', (e) => {
        // A refusal can follow INTERACTION_CANCELLED in the same server reply.
        if (e.kind === StatusKind.FAILURE && (this.pending || this.body)) this.finish(e.text);
      }),
      bus.on('fullInventory', () => this.finish('')),
      bus.on('playerDie', () => this.finish('')),
    ];
    return () => {
      offs.forEach((off) => off());
      this.finish('');
      this.unmount();
    };
  }

  refresh(deps: ModsWindowDeps): void {
    this.deps = deps;
    if (!this.body) return;
    const gun = this.weapon(deps.inventory);
    if (!gun) {
      this.endDrag();
      return;
    }
    const fitted = deps.inventory.modsOf(gun.uid),
      slots = weaponSlots(deps.content, gun.iid);
    const layoutKey = JSON.stringify([gun.uid, gun.iid, slots]);
    if (layoutKey !== this.layoutKey) {
      this.layoutKey = layoutKey;
      this.stateKey = '';
      this.renderLayout(gun, slots);
    }
    if (this.selected && !this.fittedIn(fitted, this.selected)) this.selected = null;
    if (this.picked && !this.findItem(this.picked)) this.picked = null;
    if (this.drag && this.fittedIn(fitted, this.drag.slot) !== this.drag.iid) this.endDrag();
    const preview = this.preview(gun, fitted);
    const stateKey = JSON.stringify([
      gun.ammo,
      fitted,
      preview,
      this.selected,
      this.picked,
      !!this.pending,
      this.feedback,
    ]);
    if (stateKey !== this.stateKey) {
      this.stateKey = stateKey;
      this.renderState(gun, fitted, preview);
    }
    this.updateProgress();
  }

  private findItem(ref: ItemRef): InventoryItem | undefined {
    return this.deps.inventory.slots.find(
      (s) => s.uid === ref.uid && s.iid === ref.iid && s.iid > 0,
    );
  }

  private fittedIn(fitted: readonly FittedMod[], slot: ModSlotName): number {
    return fitted.find((f) => f.slot === slotIndex(slot))?.iid ?? 0;
  }

  private name(iid: number): string {
    return this.deps.content.byId('items', iid)?.name ?? 'Attachment';
  }

  private preview(gun: InventoryItem, fitted: FittedMod[]): Preview | null {
    if (this.pending) return null;
    for (const ref of [this.carried, this.picked]) {
      const item = ref ? this.findItem(ref) : undefined;
      const slot = item ? slotForMod(this.deps.content, gun.iid, item.iid) : null;
      if (item && slot)
        return {
          slot,
          iid: item.iid,
          ammo: item.ammo,
          label: `${this.fittedIn(fitted, slot) ? 'Swap to' : 'Fit'} ${this.name(item.iid)}`,
        };
    }
    const slot = this.drag?.slot ?? this.hover ?? this.selected;
    const iid = slot ? this.fittedIn(fitted, slot) : 0;
    return slot && iid ? { slot, iid: 0, ammo: 0, label: `Without ${this.name(iid)}` } : null;
  }

  private notify(deps: ModsWindowDeps, text: string): void {
    this.feedback = text;
    deps.onStatus?.(text);
    this.refresh(deps);
  }

  private finish(text: string): void {
    this.pending?.cancelArrival?.();
    this.pending = null;
    this.feedback = text;
    this.stateKey = '';
  }

  private request(
    deps: ModsWindowDeps,
    slot: ModSlotName,
    modUid: number | null,
    destination?: number,
  ): void {
    const gun = this.weapon(deps.inventory);
    if (!gun) return;
    if (this.pending) {
      this.notify(deps, 'Finish the current modification first.');
      return;
    }
    const outgoing = this.fittedIn(deps.inventory.modsOf(gun.uid), slot);
    const incoming =
      modUid === null ? null : deps.inventory.slots.find((s) => s.iid > 0 && s.uid === modUid);
    if (modUid !== null && (!incoming || slotForMod(deps.content, gun.iid, incoming.iid) !== slot))
      return;
    if (modUid === null && !outgoing) return;
    if (modUid === null && !deps.inventory.slots.some((s) => s.iid === 0)) {
      this.notify(deps, 'Make room in your inventory before removing this attachment.');
      return;
    }
    const mod = modByIid(deps.content, incoming?.iid ?? outgoing);
    const ms = mod?.installMs ?? 0;
    this.pending = {
      weaponUid: gun.uid,
      slot,
      iid: incoming?.iid ?? 0,
      startedAt: null,
      ms,
      label: `${incoming ? 'Fitting' : 'Removing'} ${this.name(incoming?.iid ?? outgoing)}`,
      cancelArrival:
        outgoing && destination !== undefined
          ? deps.inventory.preferArrival(outgoing, destination, Date.now(), ms + 5000)
          : undefined,
    };
    this.feedback = '';
    this.selected = this.hover = null;
    this.picked = this.carried = null;
    deps.socket.weaponMod(gun.uid, slotIndex(slot), modUid);
    this.refresh(deps);
  }

  private dropToInventory(deps: ModsWindowDeps, slot: ModSlotName, index: number): void {
    const target = deps.inventory.getSlot(index);
    if (!target) return;
    if (target.iid > 0) this.fitFromInventory(deps, index, slot);
    else this.request(deps, slot, null, index);
  }

  private renderLayout(gun: InventoryItem, definitions: SlotDef[]): void {
    this.endDrag();
    this.observer?.disconnect();
    this.slots.clear();
    if (this.title) this.title.textContent = `${this.name(gun.iid)} — modifications`;
    const root = el('div', 'dv-mods');
    this.stage = el('div', 'dv-mods-stage');
    this.stageLabel = el('div', 'dv-mods-stage-label');
    this.connectors = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.connectors.classList.add('dv-mods-connectors');
    this.connectors.setAttribute('aria-hidden', 'true');
    this.picture = el('div', 'dv-mods-picture');
    this.picture.setAttribute('role', 'img');
    this.stage.append(this.stageLabel, this.connectors, this.picture);
    const upper: ModSlotName[] = ['stock', 'optic', 'side', 'muzzle'];
    for (const def of definitions) {
      const slot = def.type;
      const button = el('button', 'dv-mods-slot');
      button.type = 'button';
      button.dataset.modSlot = slot;
      const top = upper.includes(slot);
      const order: ModSlotName[] = top ? upper : ['magazine', 'underbarrel', 'handguard'];
      const peers = order.filter((s) => definitions.some((d) => d.type === s));
      const index = peers.indexOf(slot);
      button.style.left = `${peers.length === 1 ? 50 : 13 + (index * 74) / (peers.length - 1)}%`;
      button.classList.toggle('is-upper', top);
      button.append(
        el('span', 'dv-mods-slot-label', SLOT_LABELS[slot]),
        el('span', 'dv-mods-slot-well'),
        el('strong', 'dv-mods-slot-name'),
      );
      button.addEventListener('pointerenter', () => {
        this.hover = slot;
        this.refresh(this.deps);
      });
      button.addEventListener('pointerleave', () => {
        this.hover = null;
        this.refresh(this.deps);
      });
      button.addEventListener('focus', () => {
        this.hover = slot;
        this.refresh(this.deps);
      });
      button.addEventListener('blur', () => {
        this.hover = null;
        this.refresh(this.deps);
      });
      button.addEventListener('pointerdown', (e) => this.startDrag(e, slot));
      button.addEventListener('pointermove', (e) => this.moveDrag(e));
      button.addEventListener('pointerup', (e) => this.dropDrag(e));
      button.addEventListener('pointercancel', () => {
        this.endDrag();
        this.hover = null;
        this.refresh(this.deps);
      });
      button.addEventListener('click', (e) => {
        if (this.suppressClick) {
          this.suppressClick = false;
          e.preventDefault();
          return;
        }
        if (this.pending) return;
        const picked = this.picked ? this.findItem(this.picked) : undefined;
        if (picked)
          this.fitFromInventory(this.deps, this.deps.inventory.slots.indexOf(picked), slot);
        else {
          this.selected = this.selected === slot ? null : slot;
          this.refresh(this.deps);
        }
      });
      button.addEventListener('keydown', (e) => {
        if (e.key === 'Delete') {
          e.preventDefault();
          this.request(this.deps, slot, null);
        }
        if (e.key === 'Escape') {
          e.stopPropagation();
          this.selected = this.hover = null;
          this.picked = null;
          button.blur();
          this.refresh(this.deps);
        }
      });
      this.slots.set(slot, button);
      this.stage.append(button);
    }
    const side = el('div', 'dv-mods-side');
    this.summary = el('div', 'dv-mods-summary');
    this.stats = el('div', 'dv-mods-stats');
    side.append(el('h3', '', 'Weapon stats'), this.summary, this.stats);
    const footer = el('div', 'dv-mods-footer');
    this.status = el('div', 'dv-mods-status');
    this.status.setAttribute('role', 'status');
    this.remove = el('button', 'dv-btn is-small', 'Remove selected');
    this.remove.type = 'button';
    this.remove.addEventListener('click', () => {
      if (this.selected) this.request(this.deps, this.selected, null);
    });
    footer.append(this.status, this.remove);
    this.progress = el('div', 'dv-mods-progress');
    this.progress.setAttribute('role', 'progressbar');
    this.progress.setAttribute('aria-label', 'Mod installation');
    this.progress.append(el('span'));
    root.append(this.stage, side, footer, this.progress);
    this.body!.replaceChildren(root);
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.drawConnections());
      this.observer.observe(this.stage);
      this.observer.observe(this.picture);
    }
  }

  private renderState(gun: InventoryItem, fitted: FittedMod[], preview: Preview | null): void {
    const { content } = this.deps;
    for (const [slot, button] of this.slots) {
      const iid = this.fittedIn(fitted, slot),
        mod = modByIid(content, iid);
      const key = `${iid}:${slot === 'magazine' ? gun.ammo : ''}`;
      if (button.dataset.item !== key) {
        button.dataset.item = key;
        const well = button.querySelector<HTMLElement>('.dv-mods-slot-well')!;
        well.replaceChildren();
        if (iid) {
          const icon = content.byId('items', iid)?.client?.icon;
          if (mod?.client?.art || icon) {
            const img = el('img');
            img.src = mod?.client?.art ? `/img/${mod.client.art}` : itemIconUrl(icon!);
            img.alt = '';
            img.draggable = false;
            well.append(img);
          }
          if (slot === 'magazine')
            well.append(el('span', 'dv-mods-ammo', `${gun.ammo}/${mod?.capacity ?? 0}`));
        } else well.append(el('span', 'dv-mods-empty', 'Empty'));
        button.querySelector('strong')!.textContent = iid ? this.name(iid) : 'Empty';
        button.setAttribute(
          'aria-label',
          `${SLOT_LABELS[slot]}: ${iid ? this.name(iid) : 'empty'}`,
        );
        button.title = iid
          ? `${this.name(iid)} · ${seconds(mod?.installMs ?? 0)} to remove`
          : `${SLOT_LABELS[slot]} · drag a compatible mod here`;
      }
      button.classList.toggle('is-empty', !iid);
      button.classList.toggle('is-preview', preview?.slot === slot);
      button.classList.toggle('is-compatible', preview?.slot === slot && preview.iid > 0);
      button.setAttribute('aria-pressed', String(this.selected === slot));
      button.setAttribute('aria-disabled', String(!!this.pending));
    }
    const projected = preview ? withMod(fitted, slotIndex(preview.slot), preview.iid) : fitted;
    this.art = artLayout(content, gun.iid, projected);
    this.picture.replaceChildren();
    this.picture.setAttribute(
      'aria-label',
      `${this.name(gun.iid)}${preview ? `: ${preview.label}` : ', fitted build'}`,
    );
    if (this.art) {
      this.picture.style.aspectRatio = String(this.art.aspect);
      this.picture.style.setProperty('--dv-mods-aspect', String(this.art.aspect));
      for (const layer of this.art.layers) {
        const img = el('img');
        img.src = layer.src;
        img.alt = '';
        img.draggable = false;
        Object.assign(img.style, {
          left: `${layer.left}%`,
          top: `${layer.top}%`,
          width: `${layer.width}%`,
          height: `${layer.height}%`,
        });
        this.picture.append(img);
      }
    } else {
      this.picture.style.aspectRatio = '2';
      this.picture.style.setProperty('--dv-mods-aspect', '2');
      const icon = content.byId('items', gun.iid)?.client?.icon;
      if (icon) {
        const img = el('img', 'dv-mods-fallback');
        img.src = itemIconUrl(icon);
        img.alt = '';
        this.picture.append(img);
      }
    }
    this.stageLabel.textContent = preview
      ? preview.label
      : `Assembled weapon · ${fitted.length}/${this.slots.size} slots`;
    this.summary.textContent = preview
      ? `${preview.label}. Hover ± compares with the fitted build.`
      : 'Total ± shows all fitted mods compared with the bare weapon.';
    const current = resolveWeapon(content, gun.iid, fitted),
      base = resolveWeapon(content, gun.iid, []);
    const shown = resolveWeapon(content, gun.iid, projected);
    this.stats.replaceChildren();
    if (current && base && shown) {
      const ammo = preview?.slot === 'magazine' ? preview.ammo : gun.ammo;
      const values = statRows(shown, undefined, ammo),
        totals = statRows(base, shown),
        changes = statRows(current, shown);
      const table = el('table', 'dv-mods-table');
      const head = el('thead'),
        headers = el('tr');
      for (const title of ['Stat', 'Value', 'Total ±', 'Hover ±']) {
        const th = el('th', '', title);
        th.scope = 'col';
        headers.append(th);
      }
      head.append(headers);
      table.append(head);
      const tbody = el('tbody');
      values.forEach((row, index) => {
        const tr = el('tr');
        tr.dataset.stat = row.key;
        tr.classList.toggle('is-affected', !!preview && !!changes[index]?.delta);
        tr.append(
          el('td', '', row.label),
          el('td', 'dv-mods-value', row.value),
          this.deltaCell(totals[index]!, 'dv-mods-total'),
          this.deltaCell(preview ? changes[index] : undefined, 'dv-mods-delta'),
        );
        tbody.append(tr);
      });
      table.append(tbody);
      this.stats.append(table);
      const view = effectiveView(content, gun.iid, projected);
      if (shown.aim) this.stats.append(el('p', 'dv-mods-view', describeView(view)));
    }
    const selectedIid = this.selected ? this.fittedIn(fitted, this.selected) : 0;
    this.remove.hidden = !selectedIid;
    this.remove.disabled = !!this.pending;
    if (selectedIid)
      this.remove.textContent = `Remove · ${seconds(modByIid(content, selectedIid)?.installMs ?? 0)}`;
    this.status.textContent =
      this.feedback ||
      (preview?.slot === 'magazine'
        ? `Magazines keep their own rounds.${preview.iid ? ` Incoming: ${preview.ammo}/${modByIid(content, preview.iid)?.capacity ?? 0}.` : ''}`
        : 'Drag mods between these slots and your inventory. Click a carried mod, then its slot to fit.');
    this.drawConnections();
  }

  private deltaCell(row: StatRow | undefined, className: string): HTMLTableCellElement {
    const cell = el('td', className, row?.delta ?? '—');
    if (row?.delta) cell.classList.add(row.better ? 'is-better' : 'is-worse');
    return cell;
  }

  private drawConnections(): void {
    if (!this.body || !this.art) {
      this.connectors?.replaceChildren();
      return;
    }
    const stage = this.stage.getBoundingClientRect(),
      picture = this.picture.getBoundingClientRect();
    if (!stage.width || !stage.height) return;
    this.connectors.setAttribute('viewBox', `0 0 ${stage.width} ${stage.height}`);
    this.connectors.replaceChildren();
    for (const spot of this.art.spots) {
      const button = this.slots.get(spot.slot);
      if (!button) continue;
      const rect = button.querySelector('.dv-mods-slot-well')!.getBoundingClientRect();
      const x = rect.left + rect.width / 2 - stage.left;
      const y = (button.classList.contains('is-upper') ? rect.bottom : rect.top) - stage.top;
      const tx = picture.left - stage.left + (picture.width * spot.left) / 100;
      const ty = picture.top - stage.top + (picture.height * spot.top) / 100;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${x} ${y} V${(y + ty) / 2} H${tx} V${ty}`);
      path.classList.toggle('is-preview', button.classList.contains('is-preview'));
      this.connectors.append(path);
    }
  }

  private updateProgress(): void {
    const p = this.pending;
    this.progress.hidden = !p;
    if (!p) return;
    const elapsed = p.startedAt === null ? 0 : performance.now() - p.startedAt;
    const fraction = p.ms > 0 ? Math.min(1, elapsed / p.ms) : 1;
    (this.progress.firstElementChild as HTMLElement).style.width = `${fraction * 100}%`;
    this.progress.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    const text =
      p.startedAt === null
        ? `${p.label} · waiting for server…`
        : elapsed >= p.ms
          ? `${p.label} · confirming…`
          : `${p.label} · ${seconds(p.ms - elapsed)}`;
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  private suppressClick = false;
  private startDrag(e: PointerEvent, slot: ModSlotName): void {
    this.suppressClick = false;
    if (e.button !== 0 || this.pending) return;
    const gun = this.weapon(this.deps.inventory);
    const iid = gun ? this.fittedIn(this.deps.inventory.modsOf(gun.uid), slot) : 0;
    if (!iid) return;
    this.drag = { slot, iid, x: e.clientX, y: e.clientY, active: false };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* Synthetic pointer. */
    }
  }

  private moveDrag(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) <= 4) return;
      drag.active = true;
      this.ghost = el('div', 'hud-drag-ghost');
      const mod = modByIid(this.deps.content, drag.iid),
        icon = this.deps.content.byId('items', drag.iid)?.client?.icon;
      const src = mod?.client?.art ? `/img/${mod.client.art}` : icon ? itemIconUrl(icon) : '';
      if (src) this.ghost.style.backgroundImage = `url(${src})`;
      document.body.append(this.ghost);
    }
    if (this.ghost) {
      this.ghost.style.left = `${e.clientX}px`;
      this.ghost.style.top = `${e.clientY}px`;
    }
  }

  private dropDrag(e: PointerEvent): void {
    const drag = this.drag;
    this.endDrag();
    if (!drag?.active) return;
    this.suppressClick = true;
    const gun = this.weapon(this.deps.inventory);
    if (!gun || this.fittedIn(this.deps.inventory.modsOf(gun.uid), drag.slot) !== drag.iid) return;
    const under =
      typeof document.elementFromPoint === 'function'
        ? document.elementFromPoint(e.clientX, e.clientY)
        : null;
    const index = under?.closest<HTMLElement>('.hud-slot')?.dataset.index;
    if (index !== undefined && Number.isInteger(Number(index)))
      this.dropToInventory(this.deps, drag.slot, Number(index));
  }

  private endDrag(): void {
    this.drag = null;
    this.ghost?.remove();
    this.ghost = null;
  }
}
