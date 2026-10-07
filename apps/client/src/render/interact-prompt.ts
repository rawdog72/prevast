// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/interact-prompt.ts
// The old client's _Interaction overlay: a key badge floating above the
// player's head -- `loot` (E + the item in its box) for a pickup, the
// building's own `e-*` icon for something usable, with a second `loot2` (F)
// badge beside it when both are in reach -- plus the use-timer dial while an
// interaction counts down, the wrong-tool flash at the top of the screen and
// the rotate hint the old placingobj faded in over the head while a rotatable
// building piece was held with nothing else to show there.
// Drawn in screen space after the world so it never sits under a wall.
//
// Sizing: the badges are HUD, not world -- they scale with the window like
// every other HUD element (the old client's base `scaleby`) and NOT with the
// player's zoom, which would otherwise quadruple them between 0.5x and 2x.
// Only the 65 world units up to the head follow the zoom, so the badge stays
// pinned a fixed 60 px above wherever the head is drawn.

import type { AssetLoader } from '../assets/asset-loader';
import { baseWorldScale, type Camera } from '../core/camera';
import type { InteractTarget } from '../game/input-manager';
import type { WorldEntity } from '../world/entity-types';

const WRONG_TOOL_MS = 2000;
const HAND_TOOL_SPRITE = 'hand-tool';
const ROTATE_HINT_SPRITE = 'hint-rotate';
/** Old client: badge bottom = player y - 65 world units - 60 px (base scale). */
const HEAD_UNITS = 65;
const HEAD_GAP_PX = 60;

function easeInQuad(t: number): number {
  return t * t;
}

interface UseTimer {
  remainingMs: number;
  totalMs: number;
}

interface WrongTool {
  sprite: string;
  remainingMs: number;
}

export class InteractPrompt {
  private timer: UseTimer | null = null;
  private wrong: WrongTool | null = null;

  /** START_INTERACTION: the server counts `delayMultiplier * 100` ms before the action lands. */
  startTimer(delayMultiplier: number): void {
    const ms = delayMultiplier * 100;
    this.timer = { remainingMs: ms, totalMs: ms };
  }

  /** INTERRUPT_INTERACTION (or the action completing). */
  interrupt(): void {
    this.timer = null;
  }

  /** A timed interaction (reload, equip, eat, craft, mod change) is running: the server will not let us aim. */
  get busy(): boolean {
    return this.timer !== null;
  }

  /** WRONG_TOOL: `sprite` is the needed tool's loot sprite; missing means "any tool". */
  wrongTool(sprite?: string): void {
    if (this.wrong && this.wrong.remainingMs > 0) return;
    this.wrong = { sprite: sprite ?? HAND_TOOL_SPRITE, remainingMs: WRONG_TOOL_MS };
  }

  update(deltaMs: number): void {
    if (this.timer) {
      this.timer.remainingMs -= deltaMs;
      if (this.timer.remainingMs < 0) this.timer = null;
    }
    if (this.wrong) {
      this.wrong.remainingMs -= deltaMs;
      if (this.wrong.remainingMs <= 0) this.wrong = null;
    }
  }

  render(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    assets: AssetLoader,
    local: WorldEntity | undefined,
    primary: InteractTarget | null,
    secondary: InteractTarget | null,
    /** Opacity of the rotate hint (PlacementEngine.rotateHintAlpha); 0 for none. */
    rotateHintAlpha = 0,
  ): void {
    this.renderWrongTool(ctx, camera, assets);
    if (!local) return;

    const zoom = camera.zoom;
    const ui = baseWorldScale(camera.viewportWidth, camera.viewportHeight);
    const p = camera.worldToScreen(local.x, local.y);
    // Where a badge of height h sits: 65 world units above the player, then 60 HUD px.
    const top = (h: number) =>
      Math.max(10 * ui, p.y - h / 2 - HEAD_UNITS * zoom - HEAD_GAP_PX * ui);

    if (this.timer) {
      this.renderTimer(ctx, assets, p.x, top, ui);
      return;
    }
    if (!primary) {
      if (rotateHintAlpha > 0) this.renderRotateHint(ctx, assets, p.x, top, ui, rotateHintAlpha);
      return;
    }

    const badge = assets.get(primary.icon);
    if (!badge) return;
    const w = (badge.naturalWidth / 2) * ui;
    const h = (badge.naturalHeight / 2) * ui;
    const y = top(h);
    // Two badges: E just left of centre, F just right of it.
    const x = secondary ? p.x - 5 * ui - w : p.x - w / 2;
    ctx.drawImage(badge.image, x, y, w, h);
    this.renderLootInBox(ctx, assets, primary, x, y, ui);

    if (secondary) {
      const badge2 = assets.get(secondary.icon);
      if (!badge2) return;
      const w2 = (badge2.naturalWidth / 2) * ui;
      const h2 = (badge2.naturalHeight / 2) * ui;
      const x2 = x + w + 10 * ui;
      const y2 = top(h2);
      ctx.drawImage(badge2.image, x2, y2, w2, h2);
      this.renderLootInBox(ctx, assets, secondary, x2, y2, ui);
    }
  }

  /** The pickup itself, drawn into the badge's box at the old client's (77, 33) offset. */
  private renderLootInBox(
    ctx: CanvasRenderingContext2D,
    assets: AssetLoader,
    target: InteractTarget,
    badgeX: number,
    badgeY: number,
    ui: number,
  ): void {
    const loot = target.loot;
    if (!loot) return;
    const img = assets.get(loot.sprite);
    if (!img) return;
    const w = (img.naturalWidth / 2) * loot.scale * ui;
    const h = (img.naturalHeight / 2) * loot.scale * ui;
    ctx.save();
    ctx.translate(badgeX + 77 * ui, badgeY + 33 * ui);
    ctx.rotate(loot.angle);
    ctx.drawImage(img.image, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  private renderRotateHint(
    ctx: CanvasRenderingContext2D,
    assets: AssetLoader,
    px: number,
    top: (h: number) => number,
    ui: number,
    alpha: number,
  ): void {
    const hint = assets.get(ROTATE_HINT_SPRITE);
    if (!hint) return;
    const w = (hint.naturalWidth / 2) * ui;
    const h = (hint.naturalHeight / 2) * ui;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * alpha;
    ctx.drawImage(hint.image, px - w / 2, top(h), w, h);
    ctx.globalAlpha = prev;
  }

  private renderTimer(
    ctx: CanvasRenderingContext2D,
    assets: AssetLoader,
    px: number,
    top: (h: number) => number,
    ui: number,
  ): void {
    const t = this.timer!;
    const dial = assets.get('timer');
    const arrow = assets.get('timer-arrow');
    const lights = assets.get('timer-lights');
    if (!dial || !arrow || !lights) return;
    const w = (dial.naturalWidth / 2) * ui;
    const h = (dial.naturalHeight / 2) * ui;
    const x = px - w / 2;
    const y = top(h);
    const elapsed = t.totalMs - t.remainingMs;
    const prev = ctx.globalAlpha;
    if (elapsed < 100) ctx.globalAlpha = prev * (elapsed / 100);
    else if (t.remainingMs < 100) ctx.globalAlpha = prev * (t.remainingMs / 100);
    ctx.drawImage(dial.image, x, y, w, h);
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(-Math.PI * 2 * (t.remainingMs / t.totalMs));
    ctx.drawImage(arrow.image, -w / 2, -h / 2, w, h);
    ctx.restore();
    ctx.drawImage(lights.image, x, y, w, h);
    ctx.globalAlpha = prev;
  }

  private renderWrongTool(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    assets: AssetLoader,
  ): void {
    const wt = this.wrong;
    if (!wt) return;
    const badge = assets.get('wrong-tool');
    if (!badge) return;
    const t = wt.remainingMs;
    const alpha = t < 500 ? easeInQuad(t / 500) : t > 1500 ? easeInQuad(1 - (t - 1500) / 500) : 1;
    const ui = baseWorldScale(camera.viewportWidth, camera.viewportHeight);
    const cx = camera.viewportWidth / 2;
    const cy = 50 * ui;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * alpha;
    const w = (badge.naturalWidth / 2) * ui;
    const h = (badge.naturalHeight / 2) * ui;
    ctx.drawImage(badge.image, cx - w / 2, cy - h / 2, w, h);
    const tool = assets.get(wt.sprite);
    if (tool) {
      const tw = (tool.naturalWidth / 2) * ui;
      const th = (tool.naturalHeight / 2) * ui;
      ctx.drawImage(tool.image, cx - tw / 2, cy - th / 2, tw, th);
    }
    ctx.globalAlpha = prev;
  }
}
