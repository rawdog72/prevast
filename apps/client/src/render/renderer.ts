// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { drawNpc } from './npc-renderer';
import { drawQuestMarker } from './quest-marker';
// Pure Canvas 2D Game Renderer.
// The renderer reads world and content state and never changes either.
import type { AssetLoader } from '../assets/asset-loader';
import type { ContentStore } from '../content/store';
import type { Camera } from '../core/camera';
import { distance } from '../core/math2d';
import type { Profiler } from '../core/profiler';
import {
  EntityStore,
  isLootFlying,
  isStructure,
  LOOT_FADE_MS,
  STRUCTURE_FADE_MS,
} from '../world/entity-store';
import { leafBreathScale, leafSway, lootBreathScale } from './breath';
import { EntityType, type WorldEntity } from '../world/entity-types';
import type { WorldState } from '../world/world-state';

import type { BRZone } from '../game/modes/br-zone';
import type { GhoulEffects } from '../game/modes/ghoul-effects';
import { hurtKnock, type BuildingAnimator } from './building-animator';
import { BuildingRenderer, type BuildingRenderContext } from './building-renderer';
import { easeInOutQuad, type CharacterAnimator } from './character-animator';
import { CharacterRenderer, type CharacterRenderContext } from './character-renderer';
import type { ExplosionAnimator } from './explosions';
import { type CanvasFactory, nameplateFor, Nameplates } from './nameplates';
import type { ClanStore } from '../world/clan-store';
import type { ParticleSystem } from './particles/particle-system';
import type { StatusVignette } from './status-vignette';

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  camera: Camera;
  world: WorldState;
  content: ContentStore;
  assets: AssetLoader;
  particles?: ParticleSystem;
  brZone?: BRZone;
  ghoulEffects?: GhoulEffects;
  /** Screen-edge glow for the local player's life / radiation / cold and hits. */
  statusVignette?: StatusVignette;
  animator?: CharacterAnimator;
  buildingAnimator?: BuildingAnimator;
  /** Blast frame animation; without it explosions are not drawn at all. */
  explosions?: ExplosionAnimator;
  /** For the [CLAN] tag on nameplates. */
  clans?: ClanStore;
  /** QUEST_MARKERS: npcs.xml id -> ! or ? over that NPC. */
  questMarkers?: ReadonlyMap<number, number>;
  timeMs?: number;
  profiler?: Profiler;
  /** Drawn in world space on the bare ground, under floors and everything else (the craft grid). */
  groundOverlay?: (ctx: CanvasRenderingContext2D) => void;
  /**
   * Opacity of the night palette over the day palette (nightAt): dusk and
   * dawn are the two cross-fading. Without it the palette follows
   * world.clock.isNight -- the world editor's fixed day / night.
   */
  night?: number;
}

const WARM_EVERY = 15;

/** A flying pickup is drawn at LOOT_ABSORB_MIN of its size once it is on the player, full size LOOT_ABSORB_DIST units out. */
const LOOT_ABSORB_MIN = 0.45;
const LOOT_ABSORB_DIST = 120;

export class GameRenderer {
  // Day / Night palette colors
  static readonly DAY_BG = '#3D5942';
  static readonly NIGHT_BG = '#0B2129';
  static readonly OUTSIDE_DAY_BG = '#243628';
  static readonly OUTSIDE_NIGHT_BG = '#061318';

  private readonly characters = new CharacterRenderer();
  private readonly buildings = new BuildingRenderer();
  private readonly nameplates: Nameplates;
  private visibleCount = 0;
  private explosions?: ExplosionAnimator;
  private frameNo = 0;
  /**
   * Every WARM_EVERY frames the off-screen entities the server already sent
   * get their sprites requested (AssetLoader.warm), so by the time they
   * scroll into view the bitmap is decoded. The server's viewport is far
   * larger than the screen, which gives seconds of lead time.
   */
  private warmPass = false;
  private readonly createCanvas?: CanvasFactory;
  /**
   * Screen-sized layer the night pass is drawn on while the palettes
   * cross-fade; null once a canvas could not be had (then they do not).
   */
  private nightLayer?: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null;

  constructor(options: { createCanvas?: CanvasFactory } = {}) {
    this.createCanvas = options.createCanvas;
    this.nameplates = options.createCanvas
      ? new Nameplates(options.createCanvas)
      : new Nameplates();
  }

  render(rc: RenderContext): void {
    const { ctx, camera, world, content } = rc;
    const night = rc.night ?? (world.clock.isNight ? 1 : 0);
    this.visibleCount = 0;
    this.explosions = rc.explosions;
    this.warmPass = this.frameNo++ % WARM_EVERY === 0;

    // 1-4. The world, in one palette or, at dusk and dawn, both. Night is
    // the `night-*` sprite palette plus the darker ground colour and the
    // flame/lamp light sprites drawn in drawTops -- exactly the old client's
    // model. There is deliberately no darkness overlay: the previous one
    // treated every entity's alive bit as "on fire" and haloed every building
    // in orange, and a screen-wide tint dims the lamp and fire glows, which
    // are the same art in both palettes (render/sky.ts).
    this.renderScene(rc, ctx, night >= 1);
    if (night > 0 && night < 1) this.renderNightOver(rc, night);
    else this.releaseNightLayer();

    // Labels and markers go over both palettes, drawn once.
    ctx.save();
    camera.applyTransform(ctx);

    // _playerName: the old client drew every nickname after the tree tops,
    // walls and explosions, so a name is never hidden behind scenery.
    if (rc.animator) {
      rc.profiler?.begin('render.characters');
      this.renderNameplates(ctx, camera, world, rc.clans);
      rc.profiler?.end('render.characters');
    }

    if (content.has('npcs')) for (const npc of world.entities.getByType(EntityType.NPC)) {
      const data = content.byId('npcs', npc.extra);
      if (!npc.removed && data && camera.isVisible(npc.x, npc.y, 120)) {
        this.nameplates.draw(ctx, npc.x, npc.y, { name: data.name, nameColor: data.client.tint ?? '#e3c789', tag: '[NPC]' });
        const marker = rc.questMarkers?.get(npc.extra);
        if (marker) drawQuestMarker(ctx, npc.x, npc.y, marker, rc.timeMs ?? 0);
      }
    }

    // BR storm zone (in world coordinates)
    if (rc.brZone) {
      rc.brZone.renderWorld(ctx, camera, world.worldWidth, world.worldHeight);
    }

    // Ghoul scent trails towards living players (in world coordinates)
    if (rc.ghoulEffects?.isGhoul) {
      const local = world.getLocalEntity();
      if (local) {
        const players = world.entities.getByType(EntityType.PLAYER);
        for (const p of players) {
          if (p.removed || (p.pid === local.pid && p.id === local.id)) continue;
          rc.ghoulEffects.renderScentTrail(ctx, local.x, local.y, p.x, p.y);
        }
      }
    }

    // Restore camera transform
    ctx.restore();

    // 5. Particles (handles its own camera transform)
    rc.profiler?.begin('render.particles');
    if (rc.particles) {
      rc.particles.render(ctx, camera);
    }
    rc.profiler?.end('render.particles');

    // 6. Screen effects (Ghoul vision distortion, heartbeat blood pulse)
    if (rc.ghoulEffects) {
      rc.ghoulEffects.renderScreenEffects(ctx, camera.viewportWidth, camera.viewportHeight);
    }
    rc.statusVignette?.render(ctx, camera.viewportWidth, camera.viewportHeight);
    rc.profiler?.gauge('entities.visible', this.visibleCount + this.buildings.visibleCount);
  }

  /** Ground, buildings, resources, loot and creatures in one palette, onto `ctx`. */
  private renderScene(rc: RenderContext, ctx: CanvasRenderingContext2D, isNight: boolean): void {
    const { camera, world, content, assets } = rc;

    // 1. Clear screen with terrain background color
    this.renderBackground(ctx, camera, isNight);

    // 2. Setup Camera world coordinate transform
    ctx.save();
    camera.applyTransform(ctx);

    // 3. World border bounds, then whatever sits on the bare ground (old
    // client: the craft grid was drawn before RenderObjects).
    this.renderWorldBounds(ctx, world, isNight);
    rc.groundOverlay?.(ctx);

    // 4. Render entities in the old client's RenderObjects order: floors,
    // ground resources, low buildings, loot, bullets, mid resources,
    // characters, walls/doors, lights, tree tops, explosions, particles.
    const brc: BuildingRenderContext | undefined = rc.buildingAnimator
      ? { ctx, assets, content, world, animator: rc.buildingAnimator, isNight }
      : undefined;
    const buildingAnim = rc.buildingAnimator;
    const prof = rc.profiler;
    prof?.begin('render.buildings');
    if (brc) {
      this.buildings.beginFrame(brc, camera, this.warmPass);
      this.buildings.drawLayer(brc, EntityType.BUILD_GROUND2);
      this.buildings.drawLayer(brc, EntityType.BUILD_GROUND);
    }
    prof?.end('render.buildings');
    prof?.begin('render.world');
    this.renderLayer(
      ctx,
      camera,
      world.entities.getByType(EntityType.RES_DOWN),
      isNight,
      content,
      assets,
      buildingAnim,
      world.entities,
    );
    prof?.end('render.world');
    prof?.begin('render.buildings');
    if (brc) this.buildings.drawLayer(brc, EntityType.BUILD_DOWN);
    prof?.end('render.buildings');
    prof?.begin('render.world');
    this.renderLayer(
      ctx,
      camera,
      world.entities.getByType(EntityType.LOOT),
      isNight,
      content,
      assets,
      buildingAnim,
      world.entities,
      rc.timeMs ?? 0,
    );
    this.renderLayer(
      ctx,
      camera,
      world.entities.getByType(EntityType.BULLET),
      isNight,
      content,
      assets,
      buildingAnim,
      world.entities,
    );
    this.renderLayer(
      ctx,
      camera,
      world.entities.getByType(EntityType.RES_MID),
      isNight,
      content,
      assets,
      buildingAnim,
      world.entities,
    );
    prof?.end('render.world');

    // Players & AI
    prof?.begin('render.characters');
    this.renderCharacters(
      ctx,
      camera,
      world,
      content,
      assets,
      isNight,
      rc.timeMs ?? 0,
      rc.animator,
    );
    prof?.end('render.characters');

    for (const npc of world.entities.getByType(EntityType.NPC)) {
      if (camera.isVisible(npc.x, npc.y, 120)) {
        drawNpc(ctx, npc, content, assets, isNight, rc.timeMs ?? 0);
        this.visibleCount++;
      }
    }

    // Walls, doors, then the lights that sit above them
    prof?.begin('render.buildings');
    if (brc) {
      this.buildings.drawLayer(brc, EntityType.BUILD_TOP);
      this.buildings.drawTops(brc);
    }
    prof?.end('render.buildings');
    prof?.begin('render.world');
    this.renderLayer(
      ctx,
      camera,
      world.entities.getByType(EntityType.RES_TOP),
      isNight,
      content,
      assets,
      buildingAnim,
      world.entities,
    );
    this.renderLayer(
      ctx,
      camera,
      world.entities.getByType(EntityType.RES_STOP),
      isNight,
      content,
      assets,
      buildingAnim,
      world.entities,
    );
    this.renderLayer(
      ctx,
      camera,
      world.entities.getByType(EntityType.EXPLOSION),
      isNight,
      content,
      assets,
      buildingAnim,
      world.entities,
    );
    this.renderLayer(
      ctx,
      camera,
      world.entities.getByType(EntityType.PARTICLES),
      isNight,
      content,
      assets,
      buildingAnim,
      world.entities,
    );
    prof?.end('render.world');

    ctx.restore();
  }

  /**
   * Dusk / dawn: the night pass drawn on its own screen-sized layer and laid
   * over the day pass at `alpha` -- the old client's cross-fade. Per-sprite
   * alpha would not do: overlapping sprites would show through each other.
   */
  private renderNightOver(rc: RenderContext, alpha: number): void {
    const { ctx } = rc;
    const layer = this.nightLayerFor(ctx.canvas);
    if (!layer) return;
    layer.ctx.setTransform(ctx.getTransform());
    const counted = this.visibleCount;
    this.renderScene(rc, layer.ctx, true);
    this.visibleCount = counted;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(layer.canvas, 0, 0);
    ctx.restore();
  }

  private nightLayerFor(screen: HTMLCanvasElement): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
    if (this.nightLayer === undefined) {
      const make = this.createCanvas ?? (typeof document === 'undefined' ? undefined : () => document.createElement('canvas'));
      const canvas = make?.();
      const ctx = canvas?.getContext('2d', { alpha: false });
      this.nightLayer = canvas && ctx ? { canvas, ctx } : null;
    }
    const layer = this.nightLayer;
    if (layer && (layer.canvas.width !== screen.width || layer.canvas.height !== screen.height)) {
      layer.canvas.width = screen.width;
      layer.canvas.height = screen.height;
    }
    return layer;
  }

  /** Outside dusk and dawn the layer holds nothing worth a screen-sized buffer. */
  private releaseNightLayer(): void {
    const layer = this.nightLayer;
    if (!layer || layer.canvas.width === 0) return;
    layer.canvas.width = 0;
    layer.canvas.height = 0;
  }

  private renderBackground(ctx: CanvasRenderingContext2D, camera: Camera, isNight: boolean): void {
    ctx.fillStyle = isNight ? GameRenderer.OUTSIDE_NIGHT_BG : GameRenderer.OUTSIDE_DAY_BG;
    ctx.fillRect(0, 0, camera.viewportWidth, camera.viewportHeight);
  }

  private renderWorldBounds(ctx: CanvasRenderingContext2D, world: WorldState, isNight: boolean): void {
    ctx.fillStyle = isNight ? GameRenderer.NIGHT_BG : GameRenderer.DAY_BG;
    ctx.fillRect(0, 0, world.worldWidth, world.worldHeight);
    ctx.strokeStyle = isNight ? '#030A0D' : '#142017';
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, world.worldWidth, world.worldHeight);
  }

  private renderLayer(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    entities: readonly WorldEntity[],
    isNight: boolean,
    content: ContentStore,
    assets: AssetLoader,
    buildingAnim?: BuildingAnimator,
    store?: EntityStore,
    timeMs = 0,
  ): void {
    for (const entity of entities) {
      const cullRadius = entity.type === EntityType.BULLET ? 250 : 80;
      if (!camera.isVisible(entity.x, entity.y, cullRadius)) {
        if (this.warmPass && !entity.removed) {
          const name = this.resolveEntitySprite(entity, content);
          if (name) assets.warm(name, isNight);
          const top = this.resolveResourceTop(entity, content);
          if (top) assets.warm(top, isNight);
        }
        continue;
      }
      this.visibleCount++;

      // Bullet/projectile landing light effect: frame 2 drawn under landed frame 1
      if (entity.type === EntityType.BULLET && content.has('projectiles')) {
        const proj = content.byId('projectiles', entity.extra);
        const frames = proj?.client?.frame;
        const dx = entity.nx - entity.x;
        const dy = entity.ny - entity.y;
        const fastDist = dx * dx + dy * dy;
        if (fastDist < 400 || entity.removed) {
          const lightSprite = frames?.find((f) => f.index === 2)?.sprite ?? frames?.[2]?.sprite;
          if (lightSprite) {
            const lightImg = assets.get(lightSprite, isNight);
            if (lightImg) {
              const lw = lightImg.naturalWidth / 2;
              const lh = lightImg.naturalHeight / 2;
              const lightAlpha = Math.min(fastDist / 400, 1);
              ctx.save();
              ctx.translate(entity.x, entity.y);
              ctx.rotate(entity.angle);
              if (lightAlpha < 1) ctx.globalAlpha = lightAlpha;
              ctx.drawImage(lightImg.image, -lw / 2, -lh / 2, lw, lh);
              ctx.restore();
            }
          }
        }
      }

      const spriteName = this.resolveEntitySprite(entity, content);
      if (!spriteName) continue;

      const img = assets.get(spriteName, isNight);
      if (!img) continue;

      // HiDPI assets are 2x resolution; world scale is naturalWidth / 2
      let w = img.naturalWidth / 2;
      let h = img.naturalHeight / 2;
      let x = entity.x;
      let y = entity.y;
      let alpha = 1;
      // The felled shrink-and-fade scale, shared by trunk and top.
      let deathScale = 1;

      // Resources knock along the blow and shrink-and-fade when felled; loot
      // fades out on pickup. Both mirror the old _Resources / _Loots passes.
      const anim = buildingAnim && isStructure(entity.type) ? buildingAnim.get(entity) : undefined;
      if (anim) {
        const knock = hurtKnock(anim.hurt);
        x += Math.cos(anim.hurtAngle) * knock;
        y += Math.sin(anim.hurtAngle) * knock;
        if (entity.removed) {
          const value = Math.max(0, 1 - Math.pow(anim.death / STRUCTURE_FADE_MS, 4));
          alpha = value;
          deathScale = Math.min(1 + 0.35 * (1 - value), 1.35);
          w *= deathScale;
          h *= deathScale;
        } else if (entity.retracted) {
          alpha = Math.max(0, easeInOutQuad(anim.reveal / 300));
        }
      } else if (entity.removed) {
        const left = store?.fadeLeft(entity);
        if (entity.type !== EntityType.LOOT || left === undefined) continue;
        // _Loots death: outQuart fade and a slow shrink (scale - death / 2400).
        const death = 1 - left / LOOT_FADE_MS;
        alpha = Math.max(0, 1 - Math.pow(death, 4));
        deathScale = 1 - death / 3;
      }
      if (entity.type === EntityType.LOOT) {
        // _Loots: every pickup pulses on its own beat (the old client seeded
        // `breath` per entity; the id spreads the phases here). A pickup on
        // its way into a player shrinks as it closes in, so it reads as being
        // absorbed rather than sliding under the sprite.
        let scale = lootBreathScale(timeMs + entity.id * 397) * deathScale;
        if (isLootFlying(entity)) {
          const gap = distance(entity.x, entity.y, entity.nx, entity.ny);
          scale *= LOOT_ABSORB_MIN + (1 - LOOT_ABSORB_MIN) * Math.min(1, gap / LOOT_ABSORB_DIST);
        }
        w *= scale;
        h *= scale;
      }

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(entity.angle);
      if (alpha < 1) ctx.globalAlpha = alpha;
      ctx.drawImage(img.image, -w / 2, -h / 2, w, h);
      ctx.restore();

      // _Resources imgTop: the tree's crown over the trunk, breathing (+2.5 %
      // on a 6 s cycle, phase per tree) and swaying for 300 ms after a blow.
      const topName = this.resolveResourceTop(entity, content);
      if (!topName) continue;
      const top = assets.get(topName, isNight);
      if (!top) continue;
      const breath = leafBreathScale((anim?.breath ?? timeMs) + entity.id * 977);
      const tw = (top.naturalWidth / 2) * deathScale * breath;
      const th = (top.naturalHeight / 2) * deathScale * breath;
      let tx = entity.x;
      let ty = entity.y;
      if (anim && anim.hurtTop > 0) {
        const sway = leafSway(anim.hurtTop);
        tx += Math.cos(anim.hurtAngle) * sway;
        ty += Math.sin(anim.hurtAngle) * sway;
      }
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(entity.angle);
      if (alpha < 1) ctx.globalAlpha = alpha;
      ctx.drawImage(top.image, -tw / 2, -th / 2, tw, th);
      ctx.restore();
    }
  }

  private renderCharacters(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    world: WorldState,
    content: ContentStore,
    assets: AssetLoader,
    isNight: boolean,
    timeMs: number,
    animator?: CharacterAnimator,
  ): void {
    const all = [
      ...world.entities.getByType(EntityType.PLAYER),
      ...world.entities.getByType(EntityType.AI),
    ];
    const creatures = all.filter((entity) => camera.isVisible(entity.x, entity.y, 120));
    this.visibleCount += creatures.length;

    if (!animator) return;
    const rc: CharacterRenderContext = { ctx, assets, content, world, animator, isNight, timeMs };

    if (this.warmPass) {
      for (const entity of all) {
        if (!entity.removed && !camera.isVisible(entity.x, entity.y, 120))
          this.characters.warm(rc, entity);
      }
    }

    // Sprint dust and spent shells sit on the ground beneath everyone.
    for (const entity of creatures) this.characters.drawDebris(rc, entity);

    for (const entity of creatures) this.characters.draw(rc, entity);
  }

  /** The nickname label over every visible player (never over agents). */
  private renderNameplates(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    world: WorldState,
    clans?: ClanStore,
  ): void {
    for (const entity of world.entities.getByType(EntityType.PLAYER)) {
      if (!camera.isVisible(entity.x, entity.y, 120)) continue;
      const plate = nameplateFor(entity, world, clans);
      if (plate) this.nameplates.draw(ctx, entity.x, entity.y, plate);
    }
  }

  /** The resource's `client.type[]` entry for this entity (sprite, spriteTop, ...). */
  private resourceType(
    entity: WorldEntity,
    content: ContentStore,
  ): { sprite?: string; spriteTop?: string } | undefined {
    if (!content.has('resources')) return undefined;
    const resId = (entity.extra >> 5) & 31;
    const typeIndex = (entity.extra >> 10) & 7;
    const res = content.byId('resources', resId);
    const types = (res?.client as Record<string, unknown> | undefined)?.type as
      Array<{ sprite?: string; spriteTop?: string }> | undefined;
    return types?.[typeIndex] ?? types?.[0];
  }

  private isResource(type: number): boolean {
    return (
      type === EntityType.RES_TOP ||
      type === EntityType.RES_STOP ||
      type === EntityType.RES_MID ||
      type === EntityType.RES_DOWN
    );
  }

  /** The crown sprite drawn over a tree trunk (old imgTop), if the type has one. */
  private resolveResourceTop(entity: WorldEntity, content: ContentStore): string | undefined {
    if (!this.isResource(entity.type)) return undefined;
    return this.resourceType(entity, content)?.spriteTop;
  }

  private resolveEntitySprite(entity: WorldEntity, content: ContentStore): string | undefined {
    switch (entity.type) {
      case EntityType.RES_TOP:
      case EntityType.RES_STOP:
      case EntityType.RES_MID:
      case EntityType.RES_DOWN: {
        return this.resourceType(entity, content)?.sprite;
      }
      case EntityType.LOOT: {
        if (!content.has('items')) return undefined;
        const loot = content.lootById(entity.extra);
        return loot?.sprite;
      }
      case EntityType.BULLET: {
        if (!content.has('projectiles')) return 'day-bullet1';
        const proj = content.byId('projectiles', entity.extra);
        const frames = proj?.client?.frame;
        if (!frames || frames.length === 0) return 'day-bullet1';
        const dx = entity.nx - entity.x;
        const dy = entity.ny - entity.y;
        const fastDist = dx * dx + dy * dy;
        const frameIndex = fastDist < 400 || entity.removed ? 1 : 0;
        return (
          frames.find((f) => f.index === frameIndex)?.sprite ??
          frames[frameIndex]?.sprite ??
          frames[0]?.sprite ??
          'day-bullet1'
        );
      }
      case EntityType.EXPLOSION: {
        // A transient visual: ten frames at 70 ms, then nothing (old _Explosions).
        const frame = this.explosions?.frame(entity);
        return frame === null || frame === undefined ? undefined : `day-explosion${frame}`;
      }
      default:
        return undefined;
    }
  }
}
