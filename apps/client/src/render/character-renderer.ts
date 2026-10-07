// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/character-renderer.ts
// Draws players and agents the way the old client's _EntitiePlayer / _Ghoul
// did: one routine per held-item render type (hand, melee, gun, throwable,
// bow, consumable, place), each composing arms, held item and head from the
// animator's clocks -- walk stride, idle breath, attack swing, recoil -- plus
// the hurt / heal / eat overlays and the death fade. Pure reader: all state
// lives in CharacterAnimator and WorldState.

import { skinArmIndex, type AssetLoader } from '../assets/asset-loader';
import { wearableClientFor } from './player-marker';
import type { ContentStore } from '../content/store';
import { EntityType, type WorldEntity } from '../world/entity-types';
import { drugSkinIndex, type WorldState } from '../world/world-state';
import {
  AGENT_HURT_PULSE_MS,
  EAT_PULSE_MS,
  HEAL_PULSE_MS,
  HURT_PULSE_MS,
  PUFF_LIFE_MS,
  easeInOutQuad,
  hitPulse,
  swingValue,
  triangleWave,
  type CharacterAnimState,
  type CharacterAnimator,
} from './character-animator';

export interface CharacterRenderContext {
  ctx: CanvasRenderingContext2D;
  assets: AssetLoader;
  content: ContentStore;
  world: WorldState;
  animator: CharacterAnimator;
  isNight: boolean;
  timeMs: number;
}

interface Limb {
  sprite?: string;
  angle?: number;
  x: number;
  y: number;
  distance?: number;
  rotation?: number;
}

interface Held {
  sprite?: string;
  angle?: number;
  x?: number;
  y?: number;
  rotation?: number;
  x2?: number;
  y2?: number;
}

interface EquipClient {
  render?: string;
  breath?: number;
  move?: number;
  breathWeapon?: number;
  distance?: number;
  recoil?: number;
  recoilHead?: number;
  recoilGun?: number;
  noEffect?: number;
  gunEffect?: 'gun' | 'laser';
  hitAnimMs?: number;
  consumeAnimMs?: number;
  blueprint?: string;
  pencil?: string;
  held?: Held;
  projectileHeld?: Held;
  rightArm?: Limb;
  leftArm?: Limb;
}

interface AgentClient {
  breath?: number;
  armMove?: number;
  head?: string;
  hurt?: string;
  death?: string;
  hitAnimMs?: number;
  rightArm?: Limb;
  leftArm?: Limb;
}

interface WearableClient {
  head?: string;
  leftArm?: string;
  rightArm?: string;
}

// Bare-hands pose (equipables "hand", id 0), used whenever content lookup fails.
const HAND_CLIENT: EquipClient = {
  render: 'hand',
  breath: 0.05,
  move: 3,
  hitAnimMs: 150,
  rightArm: { angle: 0, x: 22, y: 39 },
  leftArm: { angle: 0, x: 22, y: -39 },
};

const BREATH_CYCLE_MS = 1500;
const WALK_CYCLE_MS = 800;
const AGENT_WALK_CYCLE_MS = 1500;
const DEATH_FADE_MS = 400;
const DEATH_SPLAT_HOLD_MS = 500;
const GUN_EFFECT_FRAMES: Record<string, number> = { gun: 3, laser: 5 };
const GUN_EFFECT_FRAME_MS = 30;

function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Rest values shared by every routine: stride and breath amplitudes for this frame. */
interface Motion {
  breath: number;
  breathWeapon: number;
  move: number;
  orient: number;
}

export class CharacterRenderer {
  private ctx!: CanvasRenderingContext2D;
  private assets!: AssetLoader;
  private isNight = false;
  /** When set, the primitives only ask the loader to warm the sprite instead of drawing. */
  private warmOnly = false;

  /**
   * Runs the draw routine for an off-screen creature with drawing disabled,
   * so every sprite it would need (skin, arms, held item, wearable, agent
   * head) is requested before it walks into view. Predictive warm-up.
   */
  warm(rc: CharacterRenderContext, entity: WorldEntity): void {
    this.warmOnly = true;
    try {
      this.draw(rc, entity);
    } finally {
      this.warmOnly = false;
    }
  }

  /** Sprint dust and spent shells, drawn in world space beneath the creature. */
  drawDebris(rc: CharacterRenderContext, entity: WorldEntity): void {
    const anim = rc.animator.get(entity);
    if (!anim) return;
    const { ctx } = rc;

    const puffImg = anim.puffs.length ? rc.assets.get('day-run-effect', rc.isNight) : undefined;
    if (puffImg) {
      for (const puff of anim.puffs) {
        const value = easeOutQuart(clamp01(puff.delay / PUFF_LIFE_MS));
        const w = ((puff.size + 1) * value * puffImg.naturalWidth) / 7;
        ctx.save();
        ctx.translate(puff.x, puff.y);
        ctx.rotate(puff.angle);
        ctx.globalAlpha = clamp01(value * value);
        ctx.drawImage(puffImg.image, -w / 2, -w / 2, w, w);
        ctx.restore();
      }
    }

    for (const shell of anim.cartridges) {
      const img = rc.assets.get(shell.sprite, rc.isNight);
      if (!img) continue;
      const w = img.naturalWidth / 2;
      const h = img.naturalHeight / 2;
      ctx.save();
      ctx.translate(shell.x, shell.y);
      ctx.rotate(shell.delay * 0.007);
      if (shell.delay < 200) ctx.globalAlpha = clamp01(shell.delay / 200) * (2 - shell.delay / 200);
      ctx.drawImage(img.image, -w / 2, -h / 2, w, h);
      ctx.restore();
    }
  }

  /** Draws one player or agent at its world position. */
  draw(rc: CharacterRenderContext, entity: WorldEntity): void {
    const anim = rc.animator.get(entity);
    if (!anim) return;
    this.ctx = rc.ctx;
    this.assets = rc.assets;
    this.isNight = rc.isNight;

    const playerInfo =
      entity.type === EntityType.PLAYER ? rc.world.players.get(entity.pid) : undefined;
    // Ghoul-mode players are drawn as the agent their `ghoul` number names.
    const agentId =
      entity.type === EntityType.AI ? entity.extra & 15 : (playerInfo?.ghoul ?? 0) - 1;
    const agent =
      agentId >= 0 && rc.content.has('agents') ? rc.content.byId('agents', agentId) : undefined;
    const agentClient = agent?.client as AgentClient | undefined;

    const ctx = rc.ctx;
    ctx.save();
    ctx.translate(entity.x, entity.y);

    // Death: the splat fades in under the body, which swells and fades out.
    let scale = 1;
    if (entity.removed) {
      const splat = agentClient?.death ?? 'day-dead-player';
      ctx.globalAlpha = clamp01(
        easeOutQuart(1 - (anim.death - DEATH_SPLAT_HOLD_MS) / DEATH_FADE_MS),
      );
      this.part(splat, entity.angle, 0, 0, 1);
      const value = easeOutQuart(1 - anim.death / DEATH_FADE_MS);
      scale = Math.min(1 + 0.5 * (1 - value), 1.5);
      ctx.globalAlpha = Math.max(0, value);
    }

    if (agentClient) {
      this.drawAgent(entity, anim, agentClient, scale);
    } else {
      // Base skin = drug state (old client skinType); PLAYER_INFO.skin is the
      // wearable id and is only ever a cosmetic overlay (extra & 255 below).
      const skinId = playerInfo ? drugSkinIndex(playerInfo) : 0;
      const weaponId = (entity.extra >> 8) & 255;
      const equipable = rc.content.has('equipables')
        ? rc.content.byId('equipables', weaponId)
        : undefined;
      const client = (equipable?.client as EquipClient | undefined) ?? HAND_CLIENT;
      const wearable = this.wearableFor(rc.content, entity.extra & 255);
      this.drawPlayer(entity, anim, client, skinId, wearable, scale);
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private wearableFor(content: ContentStore, skinId: number): WearableClient | undefined {
    return wearableClientFor(content, skinId);
  }

  // ---- drawing primitives (old client drawImageHd / drawImageHd2) ----------

  /** Draws `sprite` centred on the creature, rotated by `angle`, offset (x, y) in the rotated frame. */
  private part(sprite: string, angle: number, x: number, y: number, scale: number): void {
    if (this.warmOnly) {
      this.assets.warm(sprite, this.isNight);
      return;
    }
    const img = this.assets.get(sprite, this.isNight);
    if (!img) return;
    const w = (img.naturalWidth / 2) * scale;
    const h = (img.naturalHeight / 2) * scale;
    const ctx = this.ctx;
    ctx.save();
    ctx.rotate(angle);
    ctx.drawImage(img.image, -w / 2 + x * scale, -h / 2 + y * scale, w, h);
    ctx.restore();
  }

  /** As `part`, then a second rotation about a pivot (x2, y2) -- the tool swing. */
  private partPivot(
    sprite: string,
    angle: number,
    x: number,
    y: number,
    scale: number,
    rotation: number,
    x2: number,
    y2: number,
  ): void {
    if (this.warmOnly) {
      this.assets.warm(sprite, this.isNight);
      return;
    }
    const img = this.assets.get(sprite, this.isNight);
    if (!img) return;
    const w = (img.naturalWidth / 2) * scale;
    const h = (img.naturalHeight / 2) * scale;
    const ctx = this.ctx;
    ctx.save();
    ctx.rotate(angle);
    ctx.translate(x * scale, y * scale);
    ctx.rotate(rotation);
    ctx.drawImage(img.image, -w / 2 + x2 * scale, -h / 2 + y2 * scale, w, h);
    ctx.restore();
  }

  /** Hurt / heal / eat overlays: a pulse-faded sprite drawn just under the head. */
  private overlay(
    sprite: string,
    remaining: number,
    total: number,
    angle: number,
    x: number,
  ): void {
    if (remaining <= 0) return;
    const pulse = hitPulse(remaining, total);
    const ctx = this.ctx;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * pulse.alpha;
    this.part(sprite, angle, x, 0, pulse.scale);
    ctx.globalAlpha = prev;
  }

  /** Shifts the origin along the hit direction (head + overlays lurch away from the blow). */
  private hurtShift(anim: CharacterAnimState, total: number, distance: number): void {
    if (anim.hurt <= 0) return;
    const value = hitPulse(anim.hurt, total).alpha;
    this.ctx.translate(
      Math.cos(anim.hurtAngle) * value * distance,
      Math.sin(anim.hurtAngle) * value * distance,
    );
  }

  private motion(
    anim: CharacterAnimState,
    breathAmp: number,
    moveAmp: number,
    breathWeaponAmp: number,
    cycle: number,
  ): Motion {
    const breathT = triangleWave(anim.breath, BREATH_CYCLE_MS);
    return {
      breath: breathAmp * breathT,
      breathWeapon: breathWeaponAmp * breathT,
      move: moveAmp * triangleWave(anim.move, cycle),
      orient: anim.orientation,
    };
  }

  // ---- players ------------------------------------------------------------

  private drawPlayer(
    entity: WorldEntity,
    anim: CharacterAnimState,
    client: EquipClient,
    skinId: number,
    wearable: WearableClient | undefined,
    scale: number,
  ): void {
    const armIndex = skinArmIndex(skinId);
    const skin = {
      head: `day-skin${skinId}`,
      rightArm: wearable?.rightArm ?? `day-right-arm${armIndex}`,
      leftArm: wearable?.leftArm ?? `day-left-arm${armIndex}`,
      cosmeticHead: wearable?.head,
    };
    const rightArm = client.rightArm ?? HAND_CLIENT.rightArm!;
    const leftArm = client.leftArm ?? HAND_CLIENT.leftArm!;
    const m = this.motion(
      anim,
      client.breath ?? 0,
      client.move ?? 0,
      client.breathWeapon ?? 0,
      WALK_CYCLE_MS,
    );
    const A = entity.angle;
    const impactMs = client.hitAnimMs ?? 150;

    switch (client.render) {
      case 'melee':
        this.drawMelee(entity, anim, client, skin, rightArm, leftArm, m, A, impactMs, scale);
        break;
      case 'gun':
        this.drawGun(entity, anim, client, skin, rightArm, leftArm, m, A, scale);
        break;
      case 'throwable':
        this.drawThrowable(entity, anim, client, skin, rightArm, leftArm, m, A, impactMs, scale);
        break;
      case 'bow':
        this.drawBow(entity, anim, client, skin, rightArm, leftArm, m, A, impactMs, scale);
        break;
      case 'consumable':
        this.drawConsumable(entity, anim, client, skin, rightArm, leftArm, m, A, scale);
        break;
      case 'place':
        this.drawPlace(entity, anim, client, skin, rightArm, leftArm, m, A, scale);
        break;
      default:
        this.drawHand(entity, anim, skin, rightArm, leftArm, m, A, impactMs, scale);
    }
  }

  private drawHead(
    skin: { head: string; cosmeticHead?: string },
    anim: CharacterAnimState,
    angle: number,
    x: number,
    scale: number,
    withFood: boolean,
  ): void {
    if (withFood) this.overlay('food-player', anim.food, EAT_PULSE_MS, angle, x);
    this.hurtShift(anim, HURT_PULSE_MS, 3);
    this.overlay('hurt-player', anim.hurt, HURT_PULSE_MS, angle, x);
    this.overlay('heal-player', anim.heal, HEAL_PULSE_MS, angle, x);
    this.part(skin.head, angle, x, 0, scale);
    if (skin.cosmeticHead) this.part(skin.cosmeticHead, angle, x, 0, scale);
  }

  // Bare hands: alternating punches, arms swing opposite ways while walking.
  private drawHand(
    _entity: WorldEntity,
    anim: CharacterAnimState,
    skin: { head: string; rightArm: string; leftArm: string; cosmeticHead?: string },
    rightArm: Limb,
    leftArm: Limb,
    m: Motion,
    A: number,
    impactMs: number,
    scale: number,
  ): void {
    const value = swingValue(anim.hit, anim.hitMax, impactMs);
    const animRotation = anim.punch * easeInOutQuad(value) * 0.55;
    const headX = value * 3;
    const leftX = anim.punch === 1 ? value * 25 : 0;
    const rightX = anim.punch === 1 ? 0 : value * 25;

    this.part(
      skin.rightArm,
      (rightArm.angle ?? 0) + A + m.breath + animRotation,
      rightArm.x + m.move * m.orient + rightX,
      rightArm.y,
      scale,
    );
    this.part(
      skin.leftArm,
      -(leftArm.angle ?? 0) + A - m.breath + animRotation,
      leftArm.x - m.move * m.orient + leftX,
      leftArm.y,
      scale,
    );
    this.drawHead(skin, anim, A + animRotation / 1.5, headX, scale, true);
  }

  // Tools and axes: the item pivots about its handle, arms follow with their own rotation/distance.
  private drawMelee(
    _entity: WorldEntity,
    anim: CharacterAnimState,
    client: EquipClient,
    skin: { head: string; rightArm: string; leftArm: string; cosmeticHead?: string },
    rightArm: Limb,
    leftArm: Limb,
    m: Motion,
    A: number,
    impactMs: number,
    scale: number,
  ): void {
    const value = swingValue(anim.hit, anim.hitMax, impactMs);
    const animRotation = -easeInOutQuad(value) * 0.4;
    const headX = value * 3;
    const leftX = value * (leftArm.distance ?? 0);
    const rightX = value * (rightArm.distance ?? 0);
    const held = client.held;

    if (held?.sprite) {
      this.partPivot(
        held.sprite,
        (held.angle ?? 0) + A + m.breath,
        (held.x ?? 0) + m.move * m.orient,
        held.y ?? 0,
        scale,
        animRotation * (held.rotation ?? 0),
        held.x2 ?? 0,
        held.y2 ?? 0,
      );
    }
    this.part(
      skin.rightArm,
      (rightArm.angle ?? 0) + A + m.breath + animRotation * (rightArm.rotation ?? 0),
      rightArm.x + m.move * m.orient + rightX,
      rightArm.y,
      scale,
    );
    this.part(
      skin.leftArm,
      -(leftArm.angle ?? 0) + A + m.breath + animRotation * (leftArm.rotation ?? 0),
      leftArm.x + m.move * m.orient + leftX,
      leftArm.y,
      scale,
    );
    this.drawHead(skin, anim, A + animRotation / 1.5, headX, scale, false);
  }

  // Guns: the shot kicks the gun, arms and head back, then everything recovers.
  private drawGun(
    _entity: WorldEntity,
    anim: CharacterAnimState,
    client: EquipClient,
    skin: { head: string; rightArm: string; leftArm: string; cosmeticHead?: string },
    rightArm: Limb,
    leftArm: Limb,
    m: Motion,
    A: number,
    scale: number,
  ): void {
    let recoil = 0;
    let recoilGun = 0;
    let recoilHead = 0;
    let effect = -1;
    if (anim.hit > 0) {
      // Old client: a fixed 180ms recover curve regardless of the weapon's cadence.
      const value = anim.hit > 80 ? 1 - (anim.hit - 80) / 100 : anim.hit / 80;
      recoil = value * (client.recoil ?? 0);
      recoilGun = value * (client.recoilGun ?? 0);
      recoilHead = value * (client.recoilHead ?? 0);
      if (!client.noEffect) {
        const frames = GUN_EFFECT_FRAMES[client.gunEffect ?? 'gun'] ?? 0;
        for (let i = 0; i < frames; i++) {
          if (anim.hit > anim.hitMax - GUN_EFFECT_FRAME_MS * (i + 1)) {
            effect = i;
            break;
          }
        }
      }
    }

    this.part(
      skin.rightArm,
      (rightArm.angle ?? 0) + A,
      rightArm.x + m.move * m.orient + recoil + m.breath,
      rightArm.y,
      scale,
    );
    this.part(
      skin.leftArm,
      -(leftArm.angle ?? 0) + A,
      leftArm.x + m.move * m.orient + recoil + m.breath,
      leftArm.y,
      scale,
    );
    const held = client.held;
    if (held?.sprite) {
      const gunX = (held.x ?? 0) + m.move * m.orient + m.breath + recoilGun;
      if (effect >= 0) {
        this.part(
          `day-${client.gunEffect ?? 'gun'}-effect${effect}`,
          A,
          gunX + (client.distance ?? 0),
          held.y ?? 0,
          scale,
        );
      }
      this.part(held.sprite, A, gunX, held.y ?? 0, scale);
    }
    this.drawHead(skin, anim, A, recoilHead, scale, false);
  }

  // Spears / grenades: wound up in the right hand, which is drawn over the head.
  private drawThrowable(
    _entity: WorldEntity,
    anim: CharacterAnimState,
    client: EquipClient,
    skin: { head: string; rightArm: string; leftArm: string; cosmeticHead?: string },
    rightArm: Limb,
    leftArm: Limb,
    m: Motion,
    A: number,
    impactMs: number,
    scale: number,
  ): void {
    const value = swingValue(anim.hit, anim.hitMax, impactMs);
    const animRotation = -easeInOutQuad(value) * 0.55;
    const headX = value * 3;
    const rightX = -value * 25;
    const leftX = value * 10;

    this.part(
      skin.leftArm,
      -(leftArm.angle ?? 0) + A - m.breath - animRotation,
      leftArm.x - m.move * m.orient + leftX,
      leftArm.y,
      scale,
    );
    this.drawHead(skin, anim, A - animRotation / 1.5, headX, scale, false);
    this.part(
      skin.rightArm,
      (rightArm.angle ?? 0) + A,
      rightArm.x + m.move * m.orient + rightX + m.breathWeapon,
      rightArm.y,
      scale,
    );
    const held = client.held;
    if (held?.sprite) {
      this.part(
        held.sprite,
        (held.angle ?? 0) + A,
        (held.x ?? 0) + m.move * m.orient + m.breathWeapon + rightX,
        held.y ?? 0,
        scale,
      );
    }
  }

  // Bow: the right hand draws the string (and the nocked arrow) back, the left holds the bow.
  private drawBow(
    _entity: WorldEntity,
    anim: CharacterAnimState,
    client: EquipClient,
    skin: { head: string; rightArm: string; leftArm: string; cosmeticHead?: string },
    rightArm: Limb,
    leftArm: Limb,
    m: Motion,
    A: number,
    impactMs: number,
    scale: number,
  ): void {
    const value = swingValue(anim.hit, anim.hitMax, impactMs);
    const animRotation = -easeInOutQuad(value) * 0.35;
    const headX = value * 3;
    const rightX = -value * 20;
    const leftX = value * 3;

    this.part(
      skin.rightArm,
      (rightArm.angle ?? 0) + A - animRotation,
      rightArm.x - m.move * m.orient + rightX + m.breathWeapon,
      rightArm.y,
      scale,
    );
    const arrow = client.projectileHeld;
    if (anim.hit > 0 && arrow?.sprite) {
      this.part(
        arrow.sprite,
        A,
        (arrow.x ?? 0) - m.move * m.orient + m.breathWeapon + rightX,
        arrow.y ?? 0,
        scale,
      );
    }
    const held = client.held;
    if (held?.sprite) {
      this.part(
        held.sprite,
        (held.angle ?? 0) + A,
        (held.x ?? 0) + m.move * m.orient + m.breath + leftX,
        held.y ?? 0,
        scale,
      );
    }
    this.part(
      skin.leftArm,
      -(leftArm.angle ?? 0) + A,
      leftArm.x + m.move * m.orient + leftX + m.breath,
      leftArm.y,
      scale,
    );
    this.drawHead(skin, anim, A - animRotation / 1.5, headX, scale, false);
  }

  // Food and drugs: both hands bob the item to the mouth while consuming.
  private drawConsumable(
    _entity: WorldEntity,
    anim: CharacterAnimState,
    client: EquipClient,
    skin: { head: string; rightArm: string; leftArm: string; cosmeticHead?: string },
    rightArm: Limb,
    leftArm: Limb,
    m: Motion,
    A: number,
    scale: number,
  ): void {
    const span = client.consumeAnimMs ?? 0;
    const recoil = span > 0 ? (anim.consume / span) * (client.recoil ?? 0) : 0;

    this.part(
      skin.rightArm,
      (rightArm.angle ?? 0) + A,
      rightArm.x + m.move * m.orient + recoil + m.breath,
      rightArm.y,
      scale,
    );
    this.part(
      skin.leftArm,
      -(leftArm.angle ?? 0) + A,
      leftArm.x + m.move * m.orient + recoil + m.breath,
      leftArm.y,
      scale,
    );
    const held = client.held;
    if (held?.sprite) {
      // The old consumable draw used player.angle alone and ignored the
      // item's own angle (the steaks and chips declare 1, which would swing
      // them out past the right hand).
      this.part(
        held.sprite,
        A,
        (held.x ?? 0) + m.move * m.orient + m.breath + recoil,
        held.y ?? 0,
        scale,
      );
    }
    this.drawHead(skin, anim, A, 0, scale, true);
  }

  // Building: blueprint in the left hand, pencil drawn over the head.
  private drawPlace(
    _entity: WorldEntity,
    anim: CharacterAnimState,
    client: EquipClient,
    skin: { head: string; rightArm: string; leftArm: string; cosmeticHead?: string },
    rightArm: Limb,
    leftArm: Limb,
    m: Motion,
    A: number,
    scale: number,
  ): void {
    this.part(
      skin.rightArm,
      (rightArm.angle ?? 0) + A + m.breath,
      rightArm.x + m.move * m.orient,
      rightArm.y,
      scale,
    );
    const leftAngle = -(leftArm.angle ?? 0) + A - m.breath;
    const leftX = leftArm.x - m.move * m.orient;
    this.part(skin.leftArm, leftAngle, leftX, leftArm.y, scale);
    if (client.blueprint)
      this.part(client.blueprint, leftAngle + Math.PI / 3, leftX - 40, leftArm.y - 15, scale);
    this.drawHead(skin, anim, A, 0, scale, false);
    if (client.pencil) this.part(client.pencil, A, 0, 0, scale);
  }

  // ---- agents (and ghoul-mode players) -------------------------------------

  private drawAgent(
    entity: WorldEntity,
    anim: CharacterAnimState,
    client: AgentClient,
    scale: number,
  ): void {
    const rightArm = client.rightArm ?? { x: 28, y: 50 };
    const leftArm = client.leftArm ?? { x: 28, y: -50 };
    const m = this.motion(anim, client.breath ?? 0, client.armMove ?? 0, 0, AGENT_WALK_CYCLE_MS);
    const A = entity.angle;
    const value = swingValue(anim.hit, anim.hitMax, client.hitAnimMs ?? 150);
    const animRotation = anim.punch * easeInOutQuad(value) * 0.55;
    const headX = value * 6;
    const leftX = anim.punch === 1 ? value * 25 : 0;
    const rightX = anim.punch === 1 ? 0 : value * 25;

    if (rightArm.sprite) {
      this.part(
        rightArm.sprite,
        (rightArm.angle ?? 0) + A + m.breath + animRotation,
        rightArm.x + m.move * m.orient + rightX,
        rightArm.y,
        scale,
      );
    }
    if (leftArm.sprite) {
      this.part(
        leftArm.sprite,
        -(leftArm.angle ?? 0) + A - m.breath + animRotation,
        leftArm.x - m.move * m.orient + leftX,
        leftArm.y,
        scale,
      );
    }
    const headAngle = A + animRotation / 1.5;
    this.hurtShift(anim, AGENT_HURT_PULSE_MS, 10);
    if (client.hurt) this.overlay(client.hurt, anim.hurt, AGENT_HURT_PULSE_MS, headAngle, headX);
    if (client.head) this.part(client.head, headAngle, headX, 0, scale);
  }
}
