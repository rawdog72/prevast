// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { NpcAction } from '../../../../shared/typescript/npc-protocol';
import type { ContentStore, LootIndexEntry } from '../content/store';
import type { ObjectEntry } from '../../../../shared/typescript/content-schema';
import type { Camera } from '../core/camera';
import type { KeyboardTracker, GameAction } from '../core/keyboard';
import { distance } from '../core/math2d';
import type { MouseTracker } from '../core/mouse';
import { MouseDirection, MoveMask } from '../net/opcodes';
import type { GameSocket } from '../net/socket';
import { isLootFlying } from '../world/entity-store';
import { EntityType, type WorldEntity } from '../world/entity-types';
import type { InventoryStore } from '../world/inventory-store';
import type { WorldState } from '../world/world-state';

export interface InputManagerDelegates {
  /** Return true when a window consumed the inventory selection. */
  onSelectSlot?: (index: number) => boolean;
  isModalOpen?: () => boolean;
  isPlacing?: () => boolean;
  onRotatePlacement?: () => void;
  onPlaceObject?: () => void;
  onToggleWindow?: (
    name: 'craft' | 'chest' | 'station' | 'team' | 'skills' | 'map' | 'options' | 'quests',
  ) => void;
  onToggleBag?: () => void;
  onToggleChat?: () => void;
  onCloseModal?: () => void;
  onAttack?: () => void;
  onInteract?: (target: InteractTarget) => void;
  /** A click on the game while a window is up (old menuHandled): the window closes. */
  onOutsideClick?: () => void;
  /**
   * Offered every press first: return true to take it (picking a trade
   * partner), and the game sees neither the press nor its release.
   */
  onPickTarget?: () => boolean;
}

export interface InputManagerOptions {
  keyboard: KeyboardTracker;
  mouse: MouseTracker;
  camera: Camera;
  world: WorldState;
  inventory: InventoryStore;
  socket: GameSocket;
  /** Needed to know which buildings can be used and which icon to show for them. */
  content?: ContentStore;
  delegates?: InputManagerDelegates;
}

export interface InteractTarget {
  kind: 'loot' | 'object' | 'npc';
  entity: WorldEntity;
  distance: number;
  /** Badge sprite: `loot` / `loot2` for pickups, the object's `client.interact` icon otherwise. */
  icon: string;
  /** What the pickup is, for drawing it inside the badge. */
  loot?: LootIndexEntry;
}

/** A usable station within E-reach (old client `buildingArea`): a tab in the craft window. */
export interface StationInReach {
  areaId: number;
  entity: WorldEntity;
}

// Server reach checks (definitions.h): per-axis, from the entity's position.
// The server accepts an interaction from this far; the badge is stricter.
const LOOT_PICKUP_RANGE = 200;
const INTERACTION_RANGE = 150;

// Old client handleProximity / _Loots: a building or pickup is offered when
// fastDist (squared) to its centre is under 12000, i.e. within ~110 units --
// you have to stand right by a chest, not a tile and a half away. The
// server's own per-axis range is the outer bound (and never the tighter one).
const REACH_SQ = 12000;

function withinAxes(a: WorldEntity, b: WorldEntity, range: number): boolean {
  return Math.abs(a.x - b.x) <= range && Math.abs(a.y - b.y) <= range;
}

function withinReach(a: WorldEntity, b: WorldEntity, serverRange: number): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy < REACH_SQ && withinAxes(a, b, serverRange);
}

// Old client _Furniture: a piece with nothing else to it but storage (the
// cupboards and pharmacies in the ruins) is "usable" and gets this badge.
const FURNITURE_BADGE = 'e-furniture';

/**
 * Old client _Loots: a pickup is only offered once it has come to rest --
 * never while it glides to its landing spot, and never while it flies to
 * whoever took it (that one is already on its way into a bag).
 */
function isLootAtRest(ent: WorldEntity): boolean {
  return !isLootFlying(ent) && distance(ent.rx, ent.ry, ent.nx, ent.ny) < 1;
}

export class InputManager {
  // Screen pixels the cursor must be from the player's own screen position
  // before its angle to them is trusted for aim/facing; closer than this,
  // atan2 is too noisy to steer by. Measured in screen space (not world
  // units) so it feels the same whether the player is zoomed in or out --
  // a world-unit deadzone shrinks to nothing screen-side when zoomed out and
  // balloons to a dead zone you can't aim inside of when zoomed in.
  private static readonly AIM_DEADZONE_PX = 8;

  readonly keyboard: KeyboardTracker;
  readonly mouse: MouseTracker;
  readonly camera: Camera;
  readonly world: WorldState;
  readonly inventory: InventoryStore;
  readonly socket: GameSocket;
  readonly content: ContentStore | undefined;
  readonly delegates: InputManagerDelegates;

  private lastMoveMask = -1;
  private lastAngleDeg = -1;
  private lastMouseDir: MouseDirection | -1 = -1;
  private lastShift = false;
  private lastMouseDown = false;
  /** The held press went to onPickTarget, so its release is not the game's either. */
  private pressTaken = false;

  private moveHeartbeatTimer = 0;
  private angleHeartbeatTimer = 0;
  private readonly unbindAction: () => void;
  private readonly unbindMouse: () => void;
  /** Set by the canvas mousedown event, consumed by the next update (see updateMouseButton). */
  private pressPending = false;

  /** What E uses: the nearest usable building in reach, else the nearest pickup. */
  currentTarget: InteractTarget | null = null;
  /** Old client "extraLoot": a pickup demoted to F because a building took E. */
  lootTarget: InteractTarget | null = null;
  /**
   * Every usable station in reach, nearest per area, in area order -- the
   * craft window's station tabs (the old client kept only the nearest one as
   * `buildingArea`). A station someone has open is not usable, so not here.
   */
  stationsInReach: StationInReach[] = [];

  constructor(options: InputManagerOptions) {
    this.keyboard = options.keyboard;
    this.mouse = options.mouse;
    this.camera = options.camera;
    this.world = options.world;
    this.inventory = options.inventory;
    this.socket = options.socket;
    this.content = options.content;
    this.delegates = options.delegates ?? {};

    this.unbindAction = this.keyboard.onAction((action, ev) => {
      this.handleAction(action, ev);
    });
    this.unbindMouse = this.mouse.onDown((button) => {
      if (button === 0) this.pressPending = true;
    });
  }

  destroy(): void {
    this.unbindAction();
    this.unbindMouse();
  }

  /**
   * The page lost focus or was hidden: let go of everything now. update()
   * would say the same on its next frame, but a hidden tab gets no frames,
   * and the server keeps the last MOVE / SPRINT / ATTACK_START until told
   * otherwise -- the character would run on (or keep swinging) meanwhile.
   */
  releaseAll(): void {
    this.keyboard.releaseKeys();
    this.mouse.releaseButtons();
    this.pressPending = false;
    if (this.lastMoveMask > 0) this.socket.move(MoveMask.NONE);
    if (this.lastMoveMask !== -1) this.lastMoveMask = MoveMask.NONE;
    this.moveHeartbeatTimer = 0;
    if (this.lastShift) {
      this.socket.shift(false);
      this.lastShift = false;
    }
    if (this.lastMouseDown) this.release(this.delegates.isModalOpen?.() ?? false);
  }

  /** Selects a hotbar slot and equips (or throws/stores, via modifiers) its item. */
  selectSlot(slotIndex: number, modifiers?: { alt?: boolean; ctrl?: boolean }): void {
    if (!modifiers?.alt && !modifiers?.ctrl && this.delegates.onSelectSlot?.(slotIndex)) return;
    this.inventory.activeSlot = slotIndex;
    const item = this.inventory.getSlot(slotIndex);
    if (!item || item.iid <= 0) return;

    if (modifiers?.alt) {
      this.socket.throwItem(item.iid, item.uid, item.count, item.ammo);
    } else if (modifiers?.ctrl) {
      this.socket.storeItem(item.iid, item.uid, item.count, item.ammo);
    } else {
      this.socket.equipItem(item.iid, item.uid, item.count, item.ammo);
    }
  }

  update(delta: number): void {
    const modalOpen = this.delegates.isModalOpen?.() ?? false;
    const textMode = this.keyboard.isTextInputMode();

    // 1. Movement updates. A window being open does not stop the player: the
    // old client's menuHandled only swallowed the click (see updateMouseButton);
    // Keyboard.keydown kept running. Only typing in chat holds movement.
    if (!textMode) {
      const mask = this.keyboard.getMoveMask();
      this.moveHeartbeatTimer += delta;
      if (mask !== this.lastMoveMask || this.moveHeartbeatTimer >= 400) {
        this.socket.move(mask);
        this.lastMoveMask = mask;
        this.moveHeartbeatTimer = 0;
      }

      // Shift / Sprint
      const shift = this.keyboard.isShift();
      if (shift !== this.lastShift) {
        this.socket.shift(shift);
        this.lastShift = shift;
      }
    } else if (this.lastMoveMask !== MoveMask.NONE) {
      this.socket.move(MoveMask.NONE);
      this.lastMoveMask = MoveMask.NONE;
      if (this.lastShift) {
        this.socket.shift(false);
        this.lastShift = false;
      }
    }

    // 2. Rotation & Aim Direction updates. Skipped until the cursor has
    // actually been seen: the tracker's (0,0) placeholder would otherwise
    // point the sprite at the top-left corner on spawn.
    const local = this.world.getLocalEntity();
    if (local) {
      this.updateAim(local, delta);
      // 3. Proximity check for interaction prompt
      this.updateInteractionTarget(local);
    }

    // 4. Mouse click (attack, mine, place)
    this.updateMouseButton(modalOpen);
  }

  private updateAim(local: WorldEntity, delta: number): void {
    if (!this.mouse.hasPosition) return;
    const cursor = this.mouse.getWorldPos(this.camera);
    // atan2 on a near-zero vector is dominated by sub-pixel jitter, so aiming with
    // the cursor close to the player's own position makes the facing angle spin
    // erratically. Below this radius, keep whatever angle we were already facing.
    // The check itself has to happen in screen space: world-space distance scales
    // with zoom, so a fixed world-unit radius shrinks away at low zoom and swallows
    // the whole screen at high zoom.
    const localScreen = this.camera.worldToScreen(local.x, local.y);
    const screenDist = distance(
      localScreen.x,
      localScreen.y,
      this.mouse.screenX,
      this.mouse.screenY,
    );
    const rad =
      screenDist < InputManager.AIM_DEADZONE_PX
        ? this.world.localPlayerAngle
        : Math.atan2(cursor.y - local.y, cursor.x - local.x);
    const deg = Math.round((((rad * 180) / Math.PI) % 360) + 360) % 360;

    this.world.localPlayerAngle = rad;

    this.angleHeartbeatTimer += delta;
    if (Math.abs(deg - this.lastAngleDeg) >= 2 || this.angleHeartbeatTimer >= 200) {
      this.socket.rotation(deg);
      this.lastAngleDeg = deg;
      this.angleHeartbeatTimer = 0;
    }

    // Mouse direction (0 = left, 1 = right)
    const dir = cursor.x >= local.x ? MouseDirection.RIGHT : MouseDirection.LEFT;
    if (dir !== this.lastMouseDir) {
      this.socket.mouseDirection(dir);
      this.lastMouseDir = dir;
    }
  }

  private updateMouseButton(modalOpen: boolean): void {
    // A press latched by the mousedown event counts even when the release
    // came before this frame: a quick click must never fall between frames.
    if (this.pressPending && !this.lastMouseDown) this.press(modalOpen);
    this.pressPending = false;
    const isDown = this.mouse.isLeftDown;
    if (isDown === this.lastMouseDown) return;
    if (isDown) this.press(modalOpen);
    else this.release(modalOpen);
  }

  private press(modalOpen: boolean): void {
    this.lastMouseDown = true;
    this.pressTaken = this.delegates.onPickTarget?.() ?? false;
    if (this.pressTaken) return;
    if (modalOpen) {
      // Old client menuHandled: the press never reaches the game. Only the
      // canvas sees it (the HUD and the window take their own clicks), so
      // a press here is a click outside the window, which closes it.
      this.delegates.onOutsideClick?.();
    } else if (this.delegates.isPlacing?.()) {
      this.delegates.onPlaceObject?.();
    } else {
      this.socket.mouseDown();
      this.delegates.onAttack?.();
    }
  }

  private release(modalOpen: boolean): void {
    this.lastMouseDown = false;
    if (this.pressTaken) {
      this.pressTaken = false;
      return;
    }
    if (modalOpen || !this.delegates.isPlacing?.()) this.socket.mouseUp();
  }

  // Old client handleProximity/_Loots: the nearest usable building takes the
  // E badge (with its own icon), and the nearest pickup rides along on F; with
  // no building in reach the pickup has E. Reach mirrors the server's checks
  // so the badge never promises something the server would refuse.
  private updateInteractionTarget(local: WorldEntity): void {
    let loot: InteractTarget | null = null;
    let lootDist = Infinity;
    for (const ent of this.world.entities.getByType(EntityType.LOOT)) {
      if (ent.removed || !isLootAtRest(ent) || !withinReach(local, ent, LOOT_PICKUP_RANGE))
        continue;
      const d = distance(local.x, local.y, ent.x, ent.y);
      if (d < lootDist) {
        lootDist = d;
        loot = {
          kind: 'loot',
          entity: ent,
          distance: d,
          icon: 'loot',
          loot: this.content?.lootById(ent.extra),
        };
      }
    }

    let object: InteractTarget | null = null;
    let objectDist = Infinity;
    const stations = new Map<number, { station: StationInReach; distance: number }>();
    if (this.content?.has('objects')) {
      for (const type of [
        EntityType.BUILD_TOP,
        EntityType.BUILD_DOWN,
        EntityType.BUILD_GROUND,
        EntityType.BUILD_GROUND2,
      ]) {
        for (const ent of this.world.entities.getByType(type)) {
          if (ent.removed || ent.retracted || !withinReach(local, ent, INTERACTION_RANGE)) continue;
          const icon = this.interactIcon(ent);
          if (!icon) continue;
          const d = distance(local.x, local.y, ent.x, ent.y);
          if (d < objectDist) {
            objectDist = d;
            object = { kind: 'object', entity: ent, distance: d, icon };
          }
          const areaId = this.objectOf(ent)?.station?.areaId;
          if (areaId !== undefined) {
            const known = stations.get(areaId);
            if (!known || d < known.distance)
              stations.set(areaId, { station: { areaId, entity: ent }, distance: d });
          }
        }
      }
    }
    if (this.content?.has('npcs'))
      for (const ent of this.world.entities.getByType(EntityType.NPC)) {
        const data = this.content.byId('npcs', ent.extra);
        const range = (data?.rangeTiles ?? 2) * 100;
        if (!data || ent.removed || !withinAxes(local, ent, range)) continue;
        const d = distance(local.x, local.y, ent.x, ent.y);
        if (d < objectDist) {
          objectDist = d;
          object = { kind: 'npc', entity: ent, distance: d, icon: 'e-npc' };
        }
      }
    this.stationsInReach = Array.from(stations.values())
      .map((s) => s.station)
      .sort((a, b) => a.areaId - b.areaId);

    if (object) {
      this.currentTarget = object;
      this.lootTarget = loot ? { ...loot, icon: 'loot2' } : null;
    } else {
      this.currentTarget = loot;
      this.lootTarget = null;
    }
  }

  /**
   * The E-badge icon for a building, or undefined when it cannot be used.
   * Usable = it has an interaction rule (doors, stations, switches, chests)
   * or storage alone (the server opens anything with storage slots as a
   * chest; the old _Furniture `usable`). Doors flip to their close icon
   * while open; a chest or station someone has open (state bit 4) offers
   * nothing, as the old _Workbench / _Furniture passes skipped handleProximity
   * while `inuse`. Switches keep bit 4 for their own state, so they always show.
   */
  /** The content entry behind a building entity (item id in `extra`, subtype in `state`). */
  private objectOf(ent: WorldEntity): ObjectEntry | undefined {
    const content = this.content!;
    const itemId = ent.extra >> 7;
    return content.objectForItem(itemId, (ent.state >> 5) & 63) ?? content.objectForItem(itemId, 0);
  }

  /**
   * What a Ctrl+right-click on a building offers besides Look, and whether it is in
   * reach: exactly what E would do with it (a door opens or closes, a switch
   * flips, storage and stations open). Null when E would do nothing.
   */
  useAction(ent: WorldEntity): { label: string; inReach: boolean } | null {
    if (!this.content?.has('objects') || ent.removed || ent.retracted || !this.interactIcon(ent))
      return null;
    const kind = (this.objectOf(ent)?.interaction as { type?: string } | undefined)?.type;
    const label =
      kind === 'door' ? (ent.state & 16 ? 'Close' : 'Open') : kind === 'switch' ? 'Use' : 'Open';
    const local = this.world.getLocalEntity();
    return { label, inReach: !!local && withinReach(local, ent, INTERACTION_RANGE) };
  }

  /**
   * Half the footprint a building covers, turned by its rotation -- the same
   * box the server collides with (Object::getCollisionRect). Never less than
   * its own tile, so thin walls and round pieces stay easy to click.
   */
  objectHalfSize(ent: WorldEntity): { x: number; y: number } {
    const t = this.content?.has('objects') ? this.objectOf(ent)?.transform : undefined;
    const w = t?.width ?? (t?.radius ?? 0) * 2;
    const h = t?.height ?? (t?.radius ?? 0) * 2;
    // A building's placement rotation rides in `extra` (bits 5-6), not `rotation`.
    const turned = ((ent.extra >> 5) & 1) === 1;
    return { x: Math.max(50, (turned ? h : w) / 2), y: Math.max(50, (turned ? w : h) / 2) };
  }

  /** Use a building the way E does (see handleAction's 'interact'). */
  use(ent: WorldEntity): void {
    this.socket.interact(ent.id, ent.pid);
  }

  /** Is this NPC within its talking range, as the E badge measures it? */
  npcInReach(ent: WorldEntity): boolean {
    const local = this.world.getLocalEntity();
    const data = this.content?.has('npcs') ? this.content.byId('npcs', ent.extra) : undefined;
    return !!local && !!data && withinAxes(local, ent, (data.rangeTiles ?? 2) * 100);
  }

  private interactIcon(ent: WorldEntity): string | undefined {
    const object = this.objectOf(ent);
    if (!object) return undefined;
    const client = object.client as { interact?: string; interactClose?: string } | undefined;
    const kind = (object.interaction as { type?: string } | undefined)?.type;
    const storage = (object.storage as { slots?: number } | undefined)?.slots ?? 0;
    if (!kind && storage <= 0) return undefined;
    const icon = client?.interact ?? (storage > 0 ? FURNITURE_BADGE : undefined);
    if (!icon) return undefined;
    const bit4 = (ent.state & 16) !== 0;
    if (kind === 'door') return bit4 && client?.interactClose ? client.interactClose : icon;
    if (kind === 'switch') return icon;
    return bit4 ? undefined : icon;
  }

  private handleAction(action: GameAction, _event: KeyboardEvent): void {
    const modalOpen = this.delegates.isModalOpen?.() ?? false;

    // Handle modal close or chat toggle first
    if (action === 'cancel') {
      if (modalOpen) {
        this.delegates.onCloseModal?.();
      }
      return;
    }

    if (action === 'chat') {
      this.delegates.onToggleChat?.();
      return;
    }

    // Every other hotkey works with a window open, as the old processKeyboard
    // did (E / F / R / slots / C / T / M with a box up).

    // Hotbar selection slots (1..9, 0)
    if (action.startsWith('slot_')) {
      const slotIndex = parseInt(action.slice(5), 10);
      this.selectSlot(slotIndex, { alt: this.keyboard.isAlt(), ctrl: this.keyboard.isCtrl() });
      return;
    }

    switch (action) {
      case 'interact': {
        const t = this.currentTarget;
        if (t) {
          if (t.kind === 'npc') {
            this.socket.npcAction({
              session: 0,
              revision: 0,
              request: 0,
              action: NpcAction.OPEN,
              target: t.entity.id,
            });
          } else if (t.kind === 'loot') {
            this.socket.takeLoot(t.entity.id);
          } else {
            // One opcode, INTERACT, serves doors, containers, stations and switches.
            this.socket.interact(t.entity.id, t.entity.pid);
          }
          this.delegates.onInteract?.(t);
        }
        break;
      }
      case 'extra_interact': {
        const t =
          this.lootTarget ?? (this.currentTarget?.kind === 'loot' ? this.currentTarget : null);
        if (t) {
          this.socket.takeLoot(t.entity.id);
          this.delegates.onInteract?.(t);
        }
        break;
      }
      case 'reload_rotate': {
        if (this.delegates.isPlacing?.()) {
          this.delegates.onRotatePlacement?.();
        } else {
          this.socket.reload();
        }
        break;
      }
      case 'toggle_craft':
        this.delegates.onToggleWindow?.('craft');
        break;
      case 'toggle_team':
        this.delegates.onToggleWindow?.('team');
        break;
      case 'toggle_quests':
        this.delegates.onToggleWindow?.('quests');
        break;
      case 'toggle_skills':
        this.delegates.onToggleWindow?.('skills');
        break;
      case 'toggle_inventory':
        this.delegates.onToggleBag?.();
        break;
      case 'toggle_map':
        // Old processKeyboard: M opens the big map (closing any box) or closes it.
        this.delegates.onToggleWindow?.('map');
        break;
    }
  }
}
