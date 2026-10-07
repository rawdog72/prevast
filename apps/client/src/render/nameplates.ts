// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/nameplates.ts
// The old client's _playerName: every player's nickname floats above their
// head as a label rasterised once (GUI.renderText at 2x: 38 px Viga, white
// on a 12 px black outline, padding 16 x 25, max width 400) and drawn at half
// size with its top edge 90 world units above the player, in world space so
// it scales with the zoom like the sprite under it. A clan member gets the
// clan's "[NAME]" label drawn to the left of the nickname.
//
// Labels are cached by text and colour, as the old client kept one canvas per
// player and per team: text is the most expensive thing the 2D canvas draws,
// and stroking + filling 19 px outlined text for every visible player every
// frame is exactly the kind of per-frame raster work the 2-core dev box
// cannot afford.
//
// Improvements over the old look: the outline is rounded instead of mitred,
// clan tags are tinted (green for your own clan, muted for others) so the
// tag reads at a glance, and a camouflaged player (wearable 16) hides their
// name from everyone but themselves and their clan mates, as before.

import type { ClanStore } from '../world/clan-store';
import { EntityType, type WorldEntity } from '../world/entity-types';
import type { PlayerInfo, WorldState } from '../world/world-state';
import { badgesFor, type Badge } from '../ui/badges';
import { clanShieldColor } from '../../../../shared/typescript/account-community';

/** World units from the player's position up to the label's top edge. */
export const NAMEPLATE_OFFSET_Y = 90;

const FONT_PX = 38;
const FONT = `${FONT_PX}px 'Viga', sans-serif`;
const MAX_TEXT_WIDTH = 400;
const PAD_X = 16;
const PAD_Y = 25;
const OUTLINE = 10;
const OUTLINE_COLOR = '#000000';

export const NAME_COLOR = '#ffffff';
export const OWN_CLAN_TAG_COLOR = '#9fe3b3';
export const OTHER_CLAN_TAG_COLOR = '#b7c0cb';

/** Wearable skinId that hides the name (old client: `(player.extra & 255) === 16`). */
const CAMOUFLAGE_SKIN = 16;

const CACHE_LIMIT = 300;

export interface Label {
  canvas: HTMLCanvasElement;
  /** Size on screen at zoom 1 (the canvas is 2x). */
  width: number;
  height: number;
}

export interface NameplateParts {
  name: string;
  nameColor: string;
  tag?: string;
  tagColor?: string;
  badges?: Badge[];
  accountTag?: string;
  shieldColor?: string;
}

/** Whether `p` is in `me`'s clan (same slot and the same uid, so a recycled slot does not match). */
function sameClan(me: PlayerInfo | undefined, p: PlayerInfo): boolean {
  return !!me && me.team !== -1 && me.team === p.team && me.teamUid === p.teamUid;
}

/**
 * What to draw over a player, or null when nothing should be. Pure: the
 * renderer feeds it the entity and stores, the test feeds it fixtures.
 */
export function nameplateFor(
  entity: WorldEntity,
  world: WorldState,
  clans?: ClanStore,
): NameplateParts | null {
  if (entity.type !== EntityType.PLAYER || entity.removed) return null;
  const own = entity.pid === world.ownGuid;
  const info = world.players.get(entity.pid);
  const me = world.players.get(world.ownGuid);
  const mate = !!info && sameClan(me, info);
  if ((entity.extra & 255) === CAMOUFLAGE_SKIN && !own && !mate) return null;

  // A guest may play without a name, and then nothing is drawn in its place.
  const name = info ? info.nickname : own ? 'You' : '';
  const parts: NameplateParts = { name, nameColor: NAME_COLOR };
  if (info && info.team !== -1) {
    const clan = clans?.clan(info.team);
    if (clan && clan.uid === info.teamUid && clan.name) {
      parts.tag = `[${clan.name}]`;
      parts.tagColor = own || mate ? OWN_CLAN_TAG_COLOR : OTHER_CLAN_TAG_COLOR;
    }
  }
  if (info?.accountClan) {
    parts.accountTag = info.accountClan.tag;
    parts.shieldColor = clanShieldColor(info.accountClan.rank);
  }
  const badges = badgesFor(info, world.groups).filter(b => b.key !== 'clan');
  if (badges.length) parts.badges = badges;
  return name || parts.tag || parts.badges ? parts : null;
}

/** Makes the offscreen canvas a label is drawn on (injectable: jsdom has no 2D context). */
export type CanvasFactory = () => HTMLCanvasElement;

const domCanvas: CanvasFactory = () => document.createElement('canvas');

export class Nameplates {
  private readonly cache = new Map<string, Label>();
  private fontReady = false;

  constructor(private readonly createCanvas: CanvasFactory = domCanvas) {}

  /** Rasterises (or fetches) the label for `text` in `color`. */
  label(text: string, color: string): Label | undefined {
    const key = `${color}|${text}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const label = this.rasterise(text, color);
    if (!label) return undefined;
    // Until Viga is in, a label would bake the fallback font in for good.
    if (this.fontReady) {
      if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
      this.cache.set(key, label);
    }
    return label;
  }

  /** Draws [tag] name badges, centred on world x, top edge at y - NAMEPLATE_OFFSET_Y. */
  draw(ctx: CanvasRenderingContext2D, x: number, y: number, parts: NameplateParts): void {
    const name = this.label(parts.name, parts.nameColor);
    if (!name) return;
    const tag = parts.tag ? this.label(parts.tag, parts.tagColor ?? parts.nameColor) : undefined;
    const accountTag = parts.accountTag ? this.label(parts.accountTag, parts.shieldColor ?? NAME_COLOR) : undefined;
    const shieldWidth = accountTag ? 22 : 0;
    const badges = (parts.badges ?? [])
      .map((badge) => this.label(badge.glyph, badge.color))
      .filter((label): label is Label => label !== undefined);
    const top = y - NAMEPLATE_OFFSET_Y;
    // Old client: the tag sits flush left of the name, the whole row centred on the player.
    const width = (tag?.width ?? 0) + name.width + (accountTag?.width ?? 0) + shieldWidth + badges.reduce((sum, b) => sum + b.width, 0);
    let left = x - width / 2;
    if (accountTag) {
      ctx.save();
      ctx.translate(left + 2, top + 5);
      ctx.beginPath();
      ctx.moveTo(9, 0); ctx.lineTo(18, 3); ctx.lineTo(18, 11);
      ctx.quadraticCurveTo(18, 16, 9, 22); ctx.quadraticCurveTo(0, 16, 0, 11);
      ctx.lineTo(0, 3); ctx.closePath();
      ctx.lineWidth = 3; ctx.strokeStyle = OUTLINE_COLOR; ctx.stroke();
      ctx.fillStyle = parts.shieldColor ?? NAME_COLOR; ctx.fill();
      ctx.restore();
      left += shieldWidth;
    }
    for (const label of [accountTag, tag, name, ...badges]) {
      if (!label) continue;
      ctx.drawImage(label.canvas, left, top, label.width, label.height);
      left += label.width;
    }
  }

  private rasterise(text: string, color: string): Label | undefined {
    const fonts =
      typeof document === 'undefined' ? undefined : (document as { fonts?: FontFaceSet }).fonts;
    this.fontReady = !fonts || fonts.check(FONT);
    const canvas = this.createCanvas();
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.font = FONT;
    const width = Math.min(ctx.measureText(text || ' ').width, MAX_TEXT_WIDTH);
    canvas.width = Math.ceil(width + PAD_X);
    canvas.height = FONT_PX + PAD_Y;
    // Resizing resets the context state.
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = OUTLINE;
    ctx.strokeStyle = OUTLINE_COLOR;
    const tx = Math.floor(PAD_X / 2);
    const ty = Math.floor(PAD_Y / 2) + Math.floor(FONT_PX / 2);
    ctx.strokeText(text, tx, ty, width);
    ctx.fillStyle = color;
    ctx.fillText(text, tx, ty, width);
    return { canvas, width: canvas.width / 2, height: canvas.height / 2 };
  }
}
