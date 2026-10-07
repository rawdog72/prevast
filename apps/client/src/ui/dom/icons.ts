// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/dom/icons.ts
// Small inline SVG icon set for the DOM HUD/windows. Every icon shares a 24x24
// viewBox and draws in `currentColor`, so color is controlled entirely by CSS
// (fill/hover/disabled states) rather than baked into the markup.

export type IconName =
  | 'close'
  | 'sound_on'
  | 'sound_off'
  | 'zoom_in'
  | 'zoom_out'
  | 'particles_on'
  | 'particles_off'
  | 'keyboard'
  | 'leaderboard'
  | 'craft'
  | 'skills'
  | 'clan_shield'
  | 'team'
  | 'heart'
  | 'food'
  | 'warm_blooded'
  | 'lightning'
  | 'radiation'
  | 'cold'
  | 'warning'
  | 'broken_tool'
  | 'tools'
  | 'weapons'
  | 'structures'
  | 'clothing'
  | 'stations'
  | 'plus'
  | 'check'
  | 'unlock'
  | 'lock'
  | 'bag'
  | 'skull'
  | 'lumberjack'
  | 'miner'
  | 'athlete'
  | 'medic'
  | 'fuel'
  | 'map'
  | 'settings'
  | 'plant'
  | 'mineral'
  | 'logic'
  | 'hand'
  | 'verified'
  | 'tutor'
  | 'gamemaster'
  | 'admin'
  | 'refresh'
  | 'swap'
  | 'minus'
  | 'caret_up'
  | 'caret_down'
  | 'quest';

const STROKE =
  'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

const PATHS: Record<IconName, string> = {
  clan_shield: '<path d="M12 2 3 5v7c0 5 9 10 9 10s9-5 9-10V5Z" fill="currentColor"/><path d="m7 12 3 3 7-7" fill="none" stroke="#18202a" stroke-width="2"/>',
  close: `<path ${STROKE} d="M6 6l12 12M18 6L6 18"/>`,
  sound_on: `<path ${STROKE} d="M4 9v6h4l5 4V5L8 9H4Z"/><path ${STROKE} d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>`,
  sound_off: `<path ${STROKE} d="M4 9v6h4l5 4V5L8 9H4Z"/><path ${STROKE} d="M15.5 9.5l5 5m0-5l-5 5"/>`,
  zoom_in: `<circle ${STROKE} cx="10.5" cy="10.5" r="6.5"/><path ${STROKE} d="M15.3 15.3 20 20M10.5 7.5v6M7.5 10.5h6"/>`,
  zoom_out: `<circle ${STROKE} cx="10.5" cy="10.5" r="6.5"/><path ${STROKE} d="M15.3 15.3 20 20M7.5 10.5h6"/>`,
  particles_on: `<path ${STROKE} d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="2" fill="currentColor"/>`,
  particles_off: `<path ${STROKE} d="M12 3v3M3 12h3M5.6 5.6l2.1 2.1M18.4 5.6l-2.1 2.1"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path ${STROKE} d="M4 4l16 16"/>`,
  keyboard: `<rect ${STROKE} x="3" y="6" width="18" height="12" rx="2"/><path ${STROKE} d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7 14h10"/>`,
  leaderboard: `<path ${STROKE} d="M5 20V11M12 20V4M19 20v-7"/>`,
  craft: `<path ${STROKE} d="M14.5 6.5 18 3l3 3-3.5 3.5M14.5 6.5 6 15l-3 6 6-3 8.5-8.5M14.5 6.5l3.5 3.5"/>`,
  skills: `<path ${STROKE} d="M12 3.5l2.4 5 5.5.6-4.1 3.8 1.1 5.5L12 15.8l-4.9 2.6 1.1-5.5-4.1-3.8 5.5-.6L12 3.5Z"/>`,
  team: `<circle ${STROKE} cx="9" cy="8.5" r="3"/><circle ${STROKE} cx="17" cy="9.5" r="2.4"/><path ${STROKE} d="M3.5 19c.6-3.2 2.9-5 5.5-5s4.9 1.8 5.5 5M15 15.2c2.2.2 3.9 1.8 4.4 4.3"/>`,
  heart: `<path ${STROKE} d="M12 20s-7-4.35-9.3-8.8C1.2 8 2.7 5 6 5c2 0 3.3 1.1 6 3.9C14.7 6.1 16 5 18 5c3.3 0 4.8 3 3.3 6.2C19 15.65 12 20 12 20Z"/>`,
  food: `<path ${STROKE} d="M6 3v7a2.5 2.5 0 0 0 5 0V3M8.5 10v11M17 3c-1.7 1.4-2.5 3-2.5 5s1 3.4 2.5 4v9"/>`,
  warm_blooded: `<path ${STROKE} d="M12 3c3 3.5 5 6.6 5 9.5a5 5 0 1 1-10 0c0-1.3.5-2.4 1.3-3.4.2 1 .9 1.6 1.7 1.6.9 0 1.3-.9 1-1.9C10.4 6.9 11 5 12 3Z"/>`,
  lightning: `<path ${STROKE} d="M13 3 5 13h5.5L11 21l8-11h-5.5L13 3Z"/>`,
  radiation: `<circle ${STROKE} cx="12" cy="12" r="1.6" fill="currentColor"/><path ${STROKE} d="M12 12 8.3 5.7A8 8 0 0 0 4.3 12h7.7ZM12 12l3.7-6.3A8 8 0 0 1 19.7 12H12ZM12 12l-3.7 6.3M12 12l3.7 6.3"/>`,
  cold: `<path ${STROKE} d="M12 2v20M4.5 6.5l15 11M19.5 6.5l-15 11M8 4l4 3 4-3M8 20l4-3 4 3M2.5 9l3.3 3-3.3 3M21.5 9l-3.3 3 3.3 3"/>`,
  warning: `<path ${STROKE} d="M12 3.5 22 20H2L12 3.5Z"/><path ${STROKE} d="M12 10v4"/><circle cx="12" cy="16.7" r="1" fill="currentColor" stroke="none"/>`,
  broken_tool: `<path ${STROKE} d="M9 3 6 6l3 3M6 6l12 12M15 21l3-3-3-3M18 18l3-3"/>`,
  tools: `<path ${STROKE} d="M14.7 6.3a3.5 3.5 0 0 1-4.6 4.6L4 17l3 3 6.1-6.1a3.5 3.5 0 0 1 4.6-4.6l-2.3 2.3-2-2 2.3-2.3Z"/>`,
  weapons: `<path ${STROKE} d="M4 20 14 10M20 4l-4 1-1 4M14 10l3-3M9 5 4 4l1 5M9 5l10 10M22 20l-4-1-1-4"/>`,
  structures: `<path ${STROKE} d="M4 11 12 4l8 7M6 10v10h12V10M10 20v-6h4v6"/>`,
  clothing: `<path ${STROKE} d="M9 4 5 6v4l2-1v11h10V9l2 1V6l-4-2c0 1.4-1.3 2.5-3 2.5S9 5.4 9 4Z"/>`,
  stations: `<circle ${STROKE} cx="12" cy="12" r="3"/><path ${STROKE} d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.1 5.9l-1.6 1.6M7.5 16.5l-1.6 1.6M18.1 18.1l-1.6-1.6M7.5 7.5 5.9 5.9"/>`,
  plus: `<path ${STROKE} d="M12 5v14M5 12h14"/>`,
  check: `<path ${STROKE} d="M4.5 12.5 9.5 17.5 19.5 6.5"/>`,
  unlock: `<rect ${STROKE} x="5" y="11" width="14" height="9" rx="2"/><path ${STROKE} d="M8 11V8a4 4 0 0 1 7.6-1.8"/>`,
  lock: `<rect ${STROKE} x="5" y="11" width="14" height="9" rx="2"/><path ${STROKE} d="M8 11V8a4 4 0 0 1 8 0v3"/>`,
  bag: `<path ${STROKE} d="M5 8h14l-1 12H6L5 8Z"/><path ${STROKE} d="M9 8V6a3 3 0 0 1 6 0v2"/><path ${STROKE} d="M9 12h6"/>`,
  skull: `<path ${STROKE} d="M12 3c-4.4 0-7.5 3-7.5 7 0 2.6 1.2 4.3 2.5 5.4V18h2v2h2v-2h2v2h2v-2h.5v-2.6c1.3-1.1 2.5-2.8 2.5-5.4 0-4-3.1-7-7.5-7Z"/><circle cx="9.5" cy="11" r="1.2" fill="currentColor" stroke="none"/><circle cx="14.5" cy="11" r="1.2" fill="currentColor" stroke="none"/>`,
  lumberjack: `<path ${STROKE} d="M14 3 4 13v3h3l10-10-3-3Z"/><path ${STROKE} d="M4 16 3 21l5-1"/>`,
  miner: `<path ${STROKE} d="M12 2c3 2 7 5.2 7 9-2-.5-4.2-.4-7 1.4-2.8-1.8-5-1.9-7-1.4 0-3.8 4-7 7-9Z"/><path ${STROKE} d="M12 12.4V22"/>`,
  athlete: `<path ${STROKE} d="M4 19l4-5 3 2 3-6 3 3 3-4"/><circle cx="18" cy="6" r="1.6" fill="currentColor" stroke="none"/>`,
  medic: `<rect ${STROKE} x="3" y="3" width="18" height="18" rx="4"/><path ${STROKE} d="M12 7.5v9M7.5 12h9"/>`,
  fuel: `<path ${STROKE} d="M6 21V7a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v14M6 21h9M6 11h9M17 8l3 2v6.5a1.5 1.5 0 0 1-3 0V13l-2-1.5"/>`,
  // GameUI.icon('map') / ('settings'): the folded map and the cog it drew on canvas.
  map: `<path ${STROKE} d="M3 5l6-2 6 3 6-2v15l-6 2-6-3-6 2V5ZM9 3v15M15 6v15"/>`,
  // Craft window rail: a seedling, a cut gem, a circuit trace, an open hand ("by hand").
  plant: `<path ${STROKE} d="M12 21v-8M12 13c0-4 2.5-7 7-7 0 4-2.5 7-7 7ZM12 15c0-3-2-5.5-5.5-5.5 0 3 2 5.5 5.5 5.5Z"/>`,
  mineral: `<path ${STROKE} d="M7 3h10l4 6-9 12L3 9l4-6ZM3 9h18M9.5 3 8 9l4 12M14.5 3 16 9l-4 12"/>`,
  logic: `<path ${STROKE} d="M4 7h5l3 5h8M4 17h5l3-5"/><circle cx="4" cy="7" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="17" r="1.4" fill="currentColor" stroke="none"/><circle cx="20" cy="12" r="1.4" fill="currentColor" stroke="none"/>`,
  hand: `<path ${STROKE} d="M8 12.5V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5v-5a1.5 1.5 0 0 1 3 0V12M17 11.5V8a1.5 1.5 0 0 1 3 0v6.5c0 3.6-2.7 6.5-6.5 6.5h-1.2c-2 0-3.8-1-4.9-2.6L4.3 14.2a1.5 1.5 0 0 1 2.4-1.8L8 14.5"/>`,
  // Name badges (badges.ts): filled so they read at chat size.
  verified: `<path fill="currentColor" d="M12 2.5l2.3 1.6 2.8-.2.9 2.7 2.3 1.6-.8 2.7.8 2.7-2.3 1.6-.9 2.7-2.8-.2L12 21.5l-2.3-1.6-2.8.2-.9-2.7-2.3-1.6.8-2.7-.8-2.7 2.3-1.6.9-2.7 2.8.2L12 2.5Z"/><path fill="none" stroke="#10151a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M8.3 12.2l2.5 2.5 5-5.4"/>`,
  tutor: `<path fill="currentColor" d="M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5V3Z"/>`,
  gamemaster: `<path fill="currentColor" d="M12 2.5 21.5 12 12 21.5 2.5 12 12 2.5Z"/>`,
  admin: `<path fill="currentColor" d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8Z"/>`,
  refresh: `<path ${STROKE} d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4h-4"/>`,
  swap: `<path ${STROKE} d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>`,
  minus: `<path ${STROKE} d="M5 12h14"/>`,
  caret_up: `<path fill="currentColor" d="M12 6l7 11H5l7-11Z"/>`,
  caret_down: `<path fill="currentColor" d="M12 18 5 7h14l-7 11Z"/>`,
  quest: `<path ${STROKE} d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path ${STROKE} d="M9 8h6M9 12h6M9 16h3"/>`,
  settings: `<circle ${STROKE} cx="12" cy="12" r="6"/><circle ${STROKE} cx="12" cy="12" r="2"/><path ${STROKE} d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M18.4 5.6l-1.5 1.5M7.1 16.9l-1.5 1.5"/>`,
};

/** Inline SVG markup for a HUD icon. Color comes from the surrounding element's `color`. */
export function icon(name: IconName, className = 'dv-icon'): string {
  return `<svg class="${className}" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">${PATHS[name]}</svg>`;
}
