// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Weapon-mod art for the SMG Tactical. Parts are the author's flat side-view
// sprites from the mp5-io-v1 art pack, with the magazine taken out of the gun
// body and drawn as three swappable magazines.
//
//   node tools/assets/mp5-mod-art.mjs
//     -> apps/client/public/img/mods/*.svg   the Mods window's layers (served as-is)
//     -> build/mod-art/*.svg                 icons and ground sprites to rasterise
//   powershell -File tools/assets/rasterize-mod-art.ps1
//     -> apps/client/public/img/*.png        (needs Inkscape; commit the PNGs)
//
// Placement data lives in content (equipables.xml <modArt>, mods.xml <client>);
// the numbers there are the box and anchor printed next to each part below.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const partsDir = join(root, 'apps/client/public/img/mods');
const rasterDir = join(root, 'build/mod-art');
mkdirSync(partsDir, { recursive: true });
mkdirSync(rasterDir, { recursive: true });

const c = { ink: '#252a32', metal: '#7b838d', polymer: '#48515d', light: '#a9b0b8', glass: '#8bced9' };
const group = (art) =>
  `<g stroke="${c.ink}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${art}</g>`;
const svg = (box, art) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.join(' ')}" width="${box[2]}" height="${box[3]}">${art}</svg>\n`;

// id: [box (minX minY w h), anchor, art]. Coordinates are the pack's drawing units.
const parts = {
  'gun-body': [[176, 34, 322, 180], [0, 0], `
    <path d="M218 106H250L237 149L225 198L193 185Z" fill="${c.polymer}"/>
    <path d="M246 109H309L297 146Q295 152 287 152H241Z" fill="none"/>
    <path d="M278 113Q278 130 268 134" fill="none" stroke-width="4"/>
    <path d="M341 67H487V84H341Z" fill="${c.metal}"/>
    <rect x="462" y="45" width="11" height="48" rx="4" fill="${c.polymer}"/>
    <rect x="479" y="65" width="13" height="21" rx="3" fill="${c.polymer}"/>
    <path d="M203 55H348L355 70V107H304L290 118H245L230 109H190V68Q190 55 203 55Z" fill="${c.metal}"/>
    <rect x="182" y="59" width="14" height="48" rx="4" fill="${c.polymer}"/>
    <path d="M201 87H287" fill="none" stroke-width="4"/>
    <rect x="302" y="67" width="30" height="14" rx="3" fill="${c.polymer}" stroke-width="4"/>
    <path d="M210 54V46H222V54" fill="${c.polymer}"/>
    <path d="M244 54V49H263" fill="none" stroke-width="5"/>`],
  // The pack's original magazine, moved to its own layer (anchor = the mag well at 318,101).
  'mag-30': [[-4, -4, 66, 116], [0, 0], `<path d="M0 0H24L34 50Q40 76 57 97L38 107Q18 80 11 55Z" fill="${c.metal}"/>`],
  'mag-15': [[-4, -4, 49, 67], [0, 0], `<path d="M0 0H24L31 32Q34 44 40 52L21 58Q15 47 11 36Z" fill="${c.metal}"/>`],
  'mag-40': [[-4, -4, 77, 137], [0, 0], `<path d="M0 0H24L36 56Q44 92 68 118L48 128Q22 98 11 60Z" fill="${c.metal}"/>
    <path d="M17 40L29 38M22 70L36 66" fill="none" stroke-width="4"/>`],
  'handguard-standard': [[-4, -4, 117, 47], [0, 0], `<path d="M0 0H104L109 25L9 38Q0 39 0 31Z" fill="${c.polymer}"/>`],
  'handguard-vented': [[-4, -4, 117, 47], [0, 0], `<path d="M0 0H104L109 25L9 38Q0 39 0 31Z" fill="${c.metal}"/>
    <path d="M19 12H29M46 12H56M73 12H83" stroke="${c.ink}" stroke-width="7"/>`],
  'sight-reflex': [[-4, -4, 65, 44], [28, 36], `<path d="M7 30V5H23L32 23H48V30Z" fill="${c.polymer}"/>
    <path d="M14 9H21L25 20H14Z" fill="${c.glass}" stroke="none"/>
    <rect x="0" y="29" width="57" height="7" rx="2" fill="${c.metal}"/>`],
  'sight-tube': [[-4, -4, 71, 43], [31, 35], `<path d="M21 23H43V33H21Z" fill="${c.polymer}"/>
    <rect x="0" y="5" width="63" height="21" rx="6" fill="${c.polymer}"/>
    <path d="M13 7V24M51 7V24" fill="none" stroke-width="4"/>
    <rect x="13" y="29" width="37" height="6" rx="2" fill="${c.metal}"/>`],
  suppressor: [[-4, -4, 128, 38], [0, 15], `<path d="M0 9H14V21H0Z" fill="${c.metal}"/>
    <rect x="10" y="0" width="110" height="30" rx="7" fill="${c.polymer}"/>
    <path d="M29 3V27" fill="none" stroke-width="4"/>`],
  'grip-vertical': [[-4, -4, 44, 72], [18, 0], `<path d="M0 0H36V10H28L25 64H11L8 10H0Z" fill="${c.polymer}"/>
    <path d="M13 43H23" stroke-width="4"/>`],
  'grip-angled': [[-4, -4, 86, 50], [39, 0], `<path d="M0 0H78V11H63L29 42H15L31 11H0Z" fill="${c.polymer}"/>`],
  'stock-solid': [[-4, -4, 158, 82], [150, 20], `<path d="M10 5L55 13H104L132 7H150V32H125L65 57L10 72Z" fill="${c.polymer}"/>
    <path d="M5 4H15V74H5Z" fill="${c.ink}" stroke-width="3"/>`],
  'stock-open': [[-4, -4, 158, 82], [150, 20], `<path d="M13 12H146V29H107L13 70Z M39 27V45L80 27Z" fill="${c.polymer}" fill-rule="evenodd"/>
    <path d="M5 8H15V74H5Z" fill="${c.ink}" stroke-width="3"/>
    <rect x="141" y="7" width="9" height="26" rx="2" fill="${c.metal}"/>`],
};

// Where each slot's part attaches on the body (the pack's manifest, plus the mag well).
const slots = { magazine: [318, 101], handguard: [350, 65], optic: [289, 55], muzzle: [489, 76], underbarrel: [403, 97], stock: [187, 79] };

// Mod key -> part id (keys are mods.xml's).
const mods = {
  mp5_mag_15: 'mag-15', mp5_mag_30: 'mag-30', mp5_mag_40: 'mag-40',
  reflex_sight: 'sight-reflex', tube_scope: 'sight-tube', suppressor_9mm: 'suppressor',
  grip_vertical: 'grip-vertical', grip_angled: 'grip-angled',
  stock_solid: 'stock-solid', stock_open: 'stock-open',
  handguard_standard: 'handguard-standard', handguard_vented: 'handguard-vented',
};

const art = (id) => group(parts[id][2]);
for (const id of Object.keys(parts)) {
  writeFileSync(join(partsDir, `${id}.svg`), svg(parts[id][0], art(id)));
  const [box, anchor] = parts[id];
  console.log(`${id}.svg  box="${box.join(' ')}"  anchorX="${anchor[0]}" anchorY="${anchor[1]}"`);
}

// A part fitted into `size` px with `pad` px around it; `night` darkens it.
function sprite(box, body, width, height, pad, night) {
  const [x, y, w, h] = box;
  const scale = Math.min((width - 2 * pad) / w, (height - 2 * pad) / h);
  const tx = (width - w * scale) / 2 - x * scale;
  const ty = (height - h * scale) / 2 - y * scale;
  const filter = night
    ? '<defs><filter id="night"><feColorMatrix type="matrix" values="0.55 0 0 0 0 0 0.6 0 0 0 0 0 0.75 0 0 0 0 0 1 0"/></filter></defs>'
    : '';
  const g = `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})"${night ? ' filter="url(#night)"' : ''}>${body}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${filter}${g}</svg>\n`;
}
const placed = (id, slot) => {
  const [, anchor] = parts[id];
  const [sx, sy] = slots[slot];
  return `<g transform="translate(${sx - anchor[0]} ${sy - anchor[1]})">${art(id)}</g>`;
};

for (const [key, id] of Object.entries(mods)) {
  const dashed = key.replaceAll('_', '-');
  const [box] = parts[id];
  writeFileSync(join(rasterDir, `inv-${dashed}-out.svg`), sprite(box, art(id), 112, 112, 10, false));
  const s = 64 / Math.max(box[2], box[3]);
  const gw = Math.max(8, Math.round(box[2] * s)), gh = Math.max(8, Math.round(box[3] * s));
  writeFileSync(join(rasterDir, `day-ground-${dashed}.svg`), sprite(box, art(id), gw, gh, 0, false));
  writeFileSync(join(rasterDir, `night-ground-${dashed}.svg`), sprite(box, art(id), gw, gh, 0, true));
}

// The gun's own icon: body with its default magazine and handguard.
const assembled = placed('mag-30', 'magazine') + art('gun-body') + placed('handguard-standard', 'handguard');
writeFileSync(join(rasterDir, 'inv-mp5-tactical-out.svg'), sprite([172, 30, 330, 188], assembled, 112, 112, 8, false));
console.log(`parts -> ${partsDir}\nraster sources -> ${rasterDir}`);
