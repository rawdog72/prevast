// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Weapon swings and shots are not listed here: each equipable names its own
// files in content (client.sound[].file), played by WorldSounds.
export const SOUNDS = {
  // Structure hits and breaks. The keys are the content's impactSound /
  // destroySound names (the old client's SOUNDID), the files its SOUND table.
  wood_impact: 'wood-impact.mp3',
  stone_impact: 'stone-impact2.mp3',
  stone_impact_2: 'stone-impact.mp3',
  steel_impact: 'metal-impact2.mp3',
  pillow_impact: 'pillow-impact-impact.mp3',
  wood_destroy: 'wood-destroy3.mp3',
  stone_destroy: 'stone-destroy.mp3',
  steel_destroy: 'metal-destroy2.mp3',
  pillow_destroy: 'pillow-impact-destroy.mp3',

  explosion: 'explosion.mp3',

  // UI & Actions
  open: 'open.mp3',
  craft: 'craft.mp3',
  levelup: 'levelup.mp3',
  skill: 'skill.mp3',
  drag: 'drag.mp3',
  button: 'button.mp3',
  play: 'play.mp3',
  end: 'end.mp3',
  geiger: 'geiger.mp3',
  throw_loot: 'throwLoot.mp3',
  eat: 'eat-1s-0.mp3',
  zipper_on: 'zipper-on.mp3',
  zipper_off: 'zipper-off.mp3',

  // Music & Ambiance
  title: 'title.mp3',
  ambient1: 'ambient1.mp3',
  ambient2: 'ambient2.mp3',
  ambient3: 'ambient3.mp3',
  ambient4: 'ambient4.mp3',
  ambient5: 'ambient5.mp3',
  ambient6: 'ambient6.mp3',
  ambient7: 'ambient7.mp3',
  ambient8: 'ambient8.mp3',
} as const;

export type SoundKey = keyof typeof SOUNDS;

export function isSoundKey(name: string): name is SoundKey {
  return Object.hasOwn(SOUNDS, name);
}
