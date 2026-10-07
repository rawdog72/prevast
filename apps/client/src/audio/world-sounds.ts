// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/audio/world-sounds.ts
// Sounds the world makes, as the old client's renderers played them while
// drawing: a weapon's swing or shot on a creature's attack pulse, the eat sound
// when a player starts consuming, a structure's impact on its hurt pulse and
// its destroy sound when it breaks. The files come from content: an equipable's
// client.sound[] list, a resource's or object's impactSound / destroySound.
//
// Runs each frame before the animators, which clear the pulses it reads.

import type { ContentStore } from '../content/store';
import { EntityType, type WorldEntity } from '../world/entity-types';
import type { WorldState } from '../world/world-state';
import { SOUNDS, isSoundKey } from './sound-registry';

export interface WorldSoundSink {
  playFileAt(
    filename: string,
    sourceX: number,
    sourceY: number,
    listenerX: number,
    listenerY: number,
    maxDistance: number,
    volume: number,
    delaySec?: number,
  ): void;
}

/** The swing clock the character animator keeps (ms left in the current swing). */
interface SwingClock {
  get(entity: WorldEntity): { hit: number } | undefined;
}

// Old AudioUtils.playFx went silent at a scaled distance of 300; each caller
// divided the real distance by its own factor, so these are 300 x factor.
const WEAPON_REACH = 1200; // distance / 4
const AGENT_REACH = 1050; // distance / 3.5
const IMPACT_REACH = 840; // distance / 2.8
const DESTROY_REACH = 750; // distance / 2.5
const AGENT_VOLUME = 0.5;
/** Old _EntitiePlayer: a consuming player's sound restarts at most this often. */
const CONSUME_REPEAT_MS = 800;
/** Agents swing with the bare-hand sounds (old _Ghoul: AudioUtils._fx.shot[0]). */
const HAND_WEAPON_ID = 0;

const STRUCTURE_TYPES = [
  EntityType.BUILD_TOP,
  EntityType.BUILD_DOWN,
  EntityType.BUILD_GROUND,
  EntityType.BUILD_GROUND2,
  EntityType.RES_TOP,
  EntityType.RES_DOWN,
  EntityType.RES_MID,
  EntityType.RES_STOP,
];

interface WeaponSound {
  files: string[];
  volume: number;
  delaySec: number;
}

interface StructureSound {
  impactSound?: string;
  destroySound?: string;
}

interface Consuming {
  active: boolean;
  lastMs: number;
}

function isResource(type: number): boolean {
  return (
    type === EntityType.RES_TOP ||
    type === EntityType.RES_DOWN ||
    type === EntityType.RES_MID ||
    type === EntityType.RES_STOP
  );
}

export class WorldSounds {
  private readonly broken = new WeakSet<WorldEntity>();
  private readonly consuming = new WeakMap<WorldEntity, Consuming>();
  /** Structure sounds already started this frame (old soundLimit). */
  private readonly playedThisFrame = new Set<string>();
  private preloaded = false;

  constructor(
    private readonly sink: WorldSoundSink & { preload?(filenames: Iterable<string>): void },
    private readonly swings?: SwingClock,
  ) {}

  update(
    world: WorldState,
    content: ContentStore,
    listenerX: number,
    listenerY: number,
    nowMs: number,
  ): void {
    if (!this.preloaded) this.preload(content);
    this.playedThisFrame.clear();

    for (const entity of world.entities.getByType(EntityType.PLAYER)) {
      if (entity.removed) continue;
      this.player(entity, content, listenerX, listenerY, nowMs);
    }
    for (const entity of world.entities.getByType(EntityType.AI)) {
      if (entity.removed || !entity.attackPulse) continue;
      if ((this.swings?.get(entity)?.hit ?? 0) > 0) continue;
      const hand = this.weaponSound(content, HAND_WEAPON_ID);
      if (hand) this.playWeapon(hand, entity, listenerX, listenerY, AGENT_REACH, AGENT_VOLUME, 0);
    }
    for (const type of STRUCTURE_TYPES) {
      for (const entity of world.entities.getByType(type)) {
        this.structure(entity, content, listenerX, listenerY);
      }
    }
  }

  private player(
    entity: WorldEntity,
    content: ContentStore,
    listenerX: number,
    listenerY: number,
    nowMs: number,
  ): void {
    const weapon = this.weaponSound(content, (entity.extra >> 8) & 255);

    if (entity.attackPulse && weapon) {
      this.playWeapon(
        weapon,
        entity,
        listenerX,
        listenerY,
        WEAPON_REACH,
        weapon.volume,
        weapon.delaySec,
      );
    }

    // Consuming is held, not pulsed: sound on the start of a bout.
    let c = this.consuming.get(entity);
    if (!c) {
      c = { active: false, lastMs: -Infinity };
      this.consuming.set(entity, c);
    }
    const eating = (entity.state & 254) === 4;
    if (eating && !c.active && weapon && nowMs - c.lastMs > CONSUME_REPEAT_MS) {
      c.lastMs = nowMs;
      this.playWeapon(
        weapon,
        entity,
        listenerX,
        listenerY,
        WEAPON_REACH,
        weapon.volume,
        weapon.delaySec,
      );
    }
    c.active = eating;
  }

  private structure(
    entity: WorldEntity,
    content: ContentStore,
    listenerX: number,
    listenerY: number,
  ): void {
    // Leaving view (retracted) is silent; only a real removal breaks.
    if (entity.removed) {
      if (this.broken.has(entity)) return;
      this.broken.add(entity);
      const destroy = this.structureSound(entity, content)?.destroySound;
      if (destroy) this.playStructure(destroy, entity, listenerX, listenerY, DESTROY_REACH);
      return;
    }
    if (entity.hurtPulse && !entity.retracted) {
      const impact = this.structureSound(entity, content)?.impactSound;
      if (impact) this.playStructure(impact, entity, listenerX, listenerY, IMPACT_REACH);
    }
  }

  private playWeapon(
    weapon: WeaponSound,
    entity: WorldEntity,
    listenerX: number,
    listenerY: number,
    reach: number,
    volume: number,
    delaySec: number,
  ): void {
    const file = weapon.files[Math.floor(Math.random() * weapon.files.length)];
    this.sink.playFileAt(file, entity.x, entity.y, listenerX, listenerY, reach, volume, delaySec);
  }

  private playStructure(
    name: string,
    entity: WorldEntity,
    listenerX: number,
    listenerY: number,
    reach: number,
  ): void {
    if (!isSoundKey(name) || this.playedThisFrame.has(name)) return;
    this.playedThisFrame.add(name);
    this.sink.playFileAt(SOUNDS[name], entity.x, entity.y, listenerX, listenerY, reach, 1, 0);
  }

  private weaponSound(content: ContentStore, weaponId: number): WeaponSound | undefined {
    if (!content.has('equipables')) return undefined;
    const client = content.byId('equipables', weaponId)?.client as
      { sound?: { file: string }[]; soundVolume?: number; soundDelay?: number } | undefined;
    if (!client?.sound?.length) return undefined;
    return {
      files: client.sound.map((s) => `${s.file}.mp3`),
      volume: client.soundVolume ?? 1,
      delaySec: client.soundDelay ?? 0,
    };
  }

  private structureSound(entity: WorldEntity, content: ContentStore): StructureSound | undefined {
    if (isResource(entity.type)) {
      if (!content.has('resources')) return undefined;
      return content.byId('resources', (entity.extra >> 5) & 31)?.client as
        StructureSound | undefined;
    }
    const itemId = entity.extra >> 7;
    // Variant objects (furniture) carry their subtype in state bits 5-10.
    const object =
      content.objectForItem(itemId, (entity.state >> 5) & 63) ?? content.objectForItem(itemId, 0);
    return object?.client as StructureSound | undefined;
  }

  /** Every weapon and structure sound in content, fetched before it is first needed. */
  private preload(content: ContentStore): void {
    if (!this.sink.preload || !content.has('equipables')) return;
    this.preloaded = true;
    const files = new Set<string>(
      Object.keys(SOUNDS)
        .filter((k) => k.endsWith('_impact') || k.endsWith('_impact_2') || k.endsWith('_destroy'))
        .map((k) => SOUNDS[k as keyof typeof SOUNDS]),
    );
    for (const entry of Object.values(content.table('equipables'))) {
      const sounds = (entry.client as { sound?: { file: string }[] } | undefined)?.sound;
      for (const s of sounds ?? []) files.add(`${s.file}.mp3`);
    }
    this.sink.preload(files);
  }
}
