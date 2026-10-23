#!/usr/bin/env python3
# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

"""
Draws the grenades' own art into apps/client/public/img (project art, not
original assets). Three pictures per grenade, nothing else:

    day-hand-<kind>-grenade.png     in the hand, in flight and at rest after
                                    landing (projectiles.xml render="tumble")
    day-ground-<kind>-grenade.png   lying on the ground as a pickup
    inv-<kind>-grenade-out.png      inventory / HUD icon

    <kind>: offensive  a stick grenade, steel head with a red band
            frag       a pineapple, olive, cut into segments
            gas        a squat yellow-green canister with a hazard mark
            smoke      a tall pale grey canister

No night pictures: the sprite manifest marks project art that has none and
the client darkens the day one itself (tools/assets/sprite-manifest.ts).

In the game's style, like tools/assets/molotov-art.py: flat fills with a
soft band of light, a thick near-black outline, and on the ground the same
gold pickup ring and shadow the other loot has. Drawn 4x and scaled down.
Sprites are 2x (world size is half the pixel size). The hand sprite keeps the
old 93 x 78 frame with the grenade where the old one was, so equipables.xml
<held x y> still puts it in the fist; the fuse end points at the thrower.

    python tools/assets/grenade-art.py

Needs Pillow.
"""

import math
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "apps", "client", "public", "img")
SS = 4  # supersampling

OUTLINE = (6, 8, 9, 255)
LOOT_RING = (152, 144, 53, 255)

# Hardware every pin grenade shares: fuse, spoon, pull ring.
FUSE = (96, 100, 94, 255)
FUSE_LIGHT = (140, 146, 138, 255)
FUSE_DARK = (66, 70, 66, 255)
SPOON = (164, 168, 148, 255)
SPOON_DARK = (124, 128, 110, 255)
PULL_RING = (204, 204, 192, 255)

KINDS = {
    "frag": {
        "body": (122, 144, 70, 255),
        "light": (166, 188, 104, 255),
        "dark": (92, 112, 52, 255),
        "groove": (62, 78, 36, 255),
    },
    "offensive": {
        "body": (90, 102, 110, 255),
        "light": (138, 152, 160, 255),
        "dark": (64, 74, 82, 255),
        "band": (196, 60, 42, 255),
        "band_dark": (150, 42, 30, 255),
        "wood": (186, 136, 78, 255),
        "wood_light": (216, 172, 112, 255),
        "wood_dark": (146, 100, 56, 255),
        "bead": (236, 232, 218, 255),
    },
    "gas": {
        "body": (176, 186, 62, 255),
        "light": (214, 222, 112, 255),
        "dark": (134, 146, 46, 255),
        "band": (50, 54, 40, 255),
    },
    "smoke": {
        "body": (178, 182, 178, 255),
        "light": (222, 226, 220, 255),
        "dark": (134, 138, 136, 255),
        "band": (72, 76, 76, 255),
        "cap": (236, 236, 230, 255),
    },
}

HAND_W, HAND_H = 93, 78


class Pen:
    """Draws in sprite pixels of the 93 x 78 hand frame, scaled by k and SS, offset by pad."""

    def __init__(self, k=1.0, pad=0):
        self.k = k
        self.pad = pad
        self.w = int((HAND_W * k + pad * 2) * SS)
        self.h = int((HAND_H * k + pad * 2) * SS)
        self.img = Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))
        self.ring = Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))

    def p(self, v):
        return (v * self.k + self.pad) * SS

    def s(self, v):
        """A length (no offset)."""
        return v * self.k * SS

    def box(self, x0, y0, x1, y1):
        return [self.p(x0), self.p(y0), self.p(x1), self.p(y1)]

    def pts(self, points):
        return [(self.p(x), self.p(y)) for x, y in points]

    def mask(self):
        return Image.new("L", (self.w, self.h), 0)

    def draw(self, layer=None):
        return ImageDraw.Draw(layer if layer is not None else self.img)

    def fill(self, mask, color, under=None):
        """Paints `color` through `mask`, optionally only where `under` (another mask) is."""
        if under is not None:
            mask = ImageChops.multiply(mask, under)
        self.img.paste(Image.new("RGBA", (self.w, self.h), color), (0, 0), mask)


def shade_body(pen, body_mask, c, y0, y1, hl_box, hl_radius):
    """Molotov-style shading: a darker underside band and a long highlight along the top."""
    pen.fill(body_mask, c["body"])
    under = pen.mask()
    cy = (y0 + y1) / 2
    ImageDraw.Draw(under).rectangle([0, pen.p(cy + (y1 - y0) * 0.22), pen.w, pen.h], fill=255)
    pen.fill(under, c["dark"], body_mask)
    hl = pen.mask()
    ImageDraw.Draw(hl).rounded_rectangle(pen.box(*hl_box), radius=pen.s(hl_radius), fill=255)
    pen.fill(hl, c["light"], body_mask)


def draw_fuse(pen, x0, x1, cy, half):
    """The fuse head on the body's top end (left): a short metal block and its cap."""
    d = pen.draw()
    d.rounded_rectangle(pen.box(x0, cy - half, x1, cy + half), radius=pen.s(2), fill=FUSE)
    d.rectangle(pen.box(x0, cy + half * 0.35, x1, cy + half), fill=FUSE_DARK)
    d.rectangle(pen.box(x0 + 1, cy - half * 0.7, x1 - 1, cy - half * 0.35), fill=FUSE_LIGHT)
    d.rounded_rectangle(pen.box(x0 - 4, cy - half * 0.75, x0 + 1, cy + half * 0.75), radius=pen.s(1.5), fill=FUSE)
    d.rectangle(pen.box(x0 - 4, cy + half * 0.3, x0 + 1, cy + half * 0.75), fill=FUSE_DARK)


def draw_spoon(pen, points):
    """The lever along the grenade's underside, from the fuse back along the body."""
    d = pen.draw()
    d.line(pen.pts(points), fill=SPOON_DARK, width=int(pen.s(5)), joint="curve")
    d.line(pen.pts([(x, y - 0.8) for x, y in points]), fill=SPOON, width=int(pen.s(3.2)), joint="curve")
    for x, y in (points[0], points[-1]):
        r = pen.s(2.3)
        d.ellipse([pen.p(x) - r, pen.p(y) - r, pen.p(x) + r, pen.p(y) + r], fill=SPOON)


def draw_pull_ring(pen, cx, cy, r):
    """The pull ring, drawn over the outline with a thin rim of its own (as the old one was)."""
    d = pen.draw(pen.ring)
    box = [pen.p(cx - r), pen.p(cy - r), pen.p(cx + r), pen.p(cy + r)]
    d.ellipse(
        [box[0] - pen.s(1.3), box[1] - pen.s(1.3), box[2] + pen.s(1.3), box[3] + pen.s(1.3)],
        outline=OUTLINE,
        width=int(pen.s(5.2)),
    )
    d.ellipse(box, outline=PULL_RING, width=int(pen.s(2.6)))


def draw_frag(pen):
    c = KINDS["frag"]
    x0, y0, x1, y1 = 31, 11, 88, 67
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    w, h = x1 - x0, y1 - y0
    body = pen.mask()
    ImageDraw.Draw(body).ellipse(pen.box(x0, y0, x1, y1), fill=255)
    shade_body(pen, body, c, y0, y1, (x0 + 12, y0 + 5, x1 - 14, y0 + 9), 2)

    # The pineapple: four rows of segments round the axis, three along it,
    # cut by grooves a shade darker than the body, each knob catching light.
    grooves = pen.mask()
    g = ImageDraw.Draw(grooves)
    gw = int(pen.s(2.2))
    g.ellipse(pen.box(cx - w * 0.27, y0 - 2, cx + w * 0.27, y1 + 2), outline=255, width=gw)
    g.line([(pen.p(cx), pen.p(y0)), (pen.p(cx), pen.p(y1))], fill=255, width=gw)
    g.ellipse(pen.box(x0 - 2, cy - h * 0.2, x1 + 2, cy + h * 0.2), outline=255, width=gw)
    pen.fill(grooves, c["groove"], body)
    knobs = pen.mask()
    kd = ImageDraw.Draw(knobs)
    for kx in (-0.36, -0.13, 0.13, 0.36):
        for ky in (-0.34, 0.0):
            px, py = cx + kx * w - 3.5, cy + ky * h - 3.2
            kd.rounded_rectangle(pen.box(px, py, px + 6, py + 3), radius=pen.s(1.4), fill=150)
    pen.fill(knobs, c["light"], body)

    draw_fuse(pen, 19, 34, cy, 8.5)
    draw_spoon(pen, [(15, 32), (19, 48), (30, 60), (46, 67), (62, 68)])
    draw_pull_ring(pen, 23, 55, 8.5)


def draw_gas(pen):
    c = KINDS["gas"]
    x0, y0, x1, y1 = 30, 12, 87, 66
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    body = pen.mask()
    ImageDraw.Draw(body).rounded_rectangle(pen.box(x0, y0, x1, y1), radius=pen.s(13), fill=255)
    shade_body(pen, body, c, y0, y1, (x0 + 9, y0 + 5, x1 - 9, y0 + 11), 3)
    # Two dark bands near the ends.
    bands = pen.mask()
    bd = ImageDraw.Draw(bands)
    for bx in (x0 + 7, x1 - 13):
        bd.rectangle(pen.box(bx, y0, bx + 6, y1), fill=255)
    pen.fill(bands, c["band"], body)
    # The hazard mark: a dark disc with a trefoil of the body colour in it.
    d = pen.draw()
    r = 10.5
    d.ellipse(pen.box(cx - r, cy - r, cx + r, cy + r), fill=c["band"])
    for i in range(3):
        a = -math.pi / 2 + i * 2 * math.pi / 3
        px, py = cx + math.cos(a) * 4.6, cy + math.sin(a) * 4.6
        d.ellipse(pen.box(px - 3.4, py - 3.4, px + 3.4, py + 3.4), fill=c["light"])
    d.ellipse(pen.box(cx - 1.8, cy - 1.8, cx + 1.8, cy + 1.8), fill=c["band"])

    draw_fuse(pen, 18, 33, cy, 8.5)
    draw_spoon(pen, [(14, 32), (18, 48), (28, 62), (44, 67), (62, 67)])
    draw_pull_ring(pen, 22, 55, 8.5)


def draw_smoke(pen):
    c = KINDS["smoke"]
    x0, y0, x1, y1 = 27, 17, 88, 61
    cy = (y0 + y1) / 2
    body = pen.mask()
    ImageDraw.Draw(body).rounded_rectangle(pen.box(x0, y0, x1, y1), radius=pen.s(5), fill=255)
    shade_body(pen, body, c, y0, y1, (x0 + 6, y0 + 4, x1 - 5, y0 + 9), 2.5)
    # The emitter end (by the fuse) is a dark band; a white cap band at the far end.
    m = pen.mask()
    ImageDraw.Draw(m).rectangle(pen.box(x0, y0, x0 + 8, y1), fill=255)
    pen.fill(m, c["band"], body)
    m = pen.mask()
    ImageDraw.Draw(m).rectangle(pen.box(x1 - 9, y0, x1 - 4, y1), fill=255)
    pen.fill(m, c["cap"], body)
    # Its label: three dark stencil strokes.
    d = pen.draw()
    for i, (lx, ln) in enumerate(((44, 18), (44, 12), (44, 15))):
        ly = cy - 6 + i * 6
        d.rounded_rectangle(pen.box(lx, ly, lx + ln, ly + 2.6), radius=pen.s(1.2), fill=c["band"])
    # Emission holes round the dark band.
    for hy in (y0 + 7, cy, y1 - 7):
        d.ellipse(pen.box(x0 + 2.5, hy - 2, x0 + 6, hy + 2), fill=OUTLINE)

    draw_fuse(pen, 15, 28, cy, 7.5)
    draw_spoon(pen, [(11, 33), (15, 47), (24, 60), (42, 64), (64, 64)])
    draw_pull_ring(pen, 19, 54, 8)


def draw_offensive(pen):
    c = KINDS["offensive"]
    # The handle first: a wooden stick into the fist, a metal cap and the pull cord's bead.
    d = pen.draw()
    hy0, hy1 = 32, 46
    d.rectangle(pen.box(10, hy0, 48, hy1), fill=c["wood"])
    d.rectangle(pen.box(10, hy0 + 9, 48, hy1), fill=c["wood_dark"])
    d.rectangle(pen.box(12, hy0 + 2.5, 46, hy0 + 5), fill=c["wood_light"])
    d.line([(pen.p(16), pen.p(hy0 + 7.5)), (pen.p(30), pen.p(hy0 + 7.5))], fill=c["wood_dark"], width=int(pen.s(1.4)))
    d.rounded_rectangle(pen.box(5, hy0 - 2, 13, hy1 + 2), radius=pen.s(2), fill=FUSE)
    d.rectangle(pen.box(5, hy0 + 9, 13, hy1 + 2), fill=FUSE_DARK)
    d.rectangle(pen.box(6, hy0, 12, hy0 + 2.5), fill=FUSE_LIGHT)
    d.line(pen.pts([(9, hy1 + 2), (10, 55), (13, 60)]), fill=SPOON_DARK, width=int(pen.s(2.2)), joint="curve")
    d.ellipse(pen.box(9.5, 57.5, 18.5, 66.5), fill=c["bead"])
    d.ellipse(pen.box(12, 62.5, 18.5, 66.5), fill=SPOON)

    # The head: a steel can with rounded rims and a red band round it.
    x0, y0, x1, y1 = 44, 12, 88, 66
    body = pen.mask()
    ImageDraw.Draw(body).rounded_rectangle(pen.box(x0, y0, x1, y1), radius=pen.s(8), fill=255)
    shade_body(pen, body, c, y0, y1, (x0 + 5, y0 + 5, x1 - 5, y0 + 11), 3)
    m = pen.mask()
    ImageDraw.Draw(m).rectangle(pen.box(x0 + 15, y0, x0 + 24, y1), fill=255)
    pen.fill(m, c["band"], body)
    m = pen.mask()
    ImageDraw.Draw(m).rectangle(pen.box(x0 + 15, (y0 + y1) / 2 + (y1 - y0) * 0.22, x0 + 24, y1), fill=255)
    pen.fill(m, c["band_dark"], body)
    # Rim seams at both ends.
    for sx in (x0 + 4, x1 - 6):
        m = pen.mask()
        ImageDraw.Draw(m).rectangle(pen.box(sx, y0, sx + 2, y1), fill=255)
        pen.fill(m, c["dark"], body)


DRAW = {"offensive": draw_offensive, "frag": draw_frag, "gas": draw_gas, "smoke": draw_smoke}


def outlined(img, width):
    """The picture over a near-black outline `width` (sprite px) thick."""
    k = int(width * SS) * 2 + 1
    mask = img.getchannel("A").point(lambda a: 255 if a > 8 else 0)
    grown = mask.filter(ImageFilter.MaxFilter(k))
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(Image.new("RGBA", img.size, OUTLINE), (0, 0), grown)
    out.alpha_composite(img)
    return out


def loot_ring(img, ring_w=2.2, shadow_w=2.6):
    """The pickup look: a gold ring round the outline and a soft shadow round that."""
    mask = img.getchannel("A").point(lambda a: 255 if a > 8 else 0)
    ring = mask.filter(ImageFilter.MaxFilter(int(ring_w * SS) * 2 + 1))
    shadow = ring.filter(ImageFilter.MaxFilter(int(shadow_w * SS) * 2 + 1)).filter(ImageFilter.GaussianBlur(SS * 1.2))
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(Image.new("RGBA", img.size, (0, 0, 0, 255)), (0, 0), shadow.point(lambda a: a * 50 // 255))
    out.paste(Image.new("RGBA", img.size, LOOT_RING), (0, 0), ring)
    out.alpha_composite(img)
    return out


def crop_to_content(img, margin):
    box = img.getchannel("A").getbbox()
    m = int(margin * SS)
    return img.crop((box[0] - m, box[1] - m, box[2] + m, box[3] + m))


def finish(img):
    """Down from SS x to sprite pixels."""
    return img.resize((max(1, round(img.width / SS)), max(1, round(img.height / SS))), Image.LANCZOS)


def grenade(kind, k=1.0, pad=0, outline=3.2, angle=0.0):
    """The grenade drawn, turned `angle` degrees, outlined, its pull ring on top."""
    pen = Pen(k, pad)
    DRAW[kind](pen)
    body, ring = pen.img, pen.ring
    if angle:
        body = body.rotate(angle, resample=Image.BICUBIC)
        ring = ring.rotate(angle, resample=Image.BICUBIC)
    out = outlined(body, outline * k)
    out.alpha_composite(ring)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    for kind in DRAW:
        name = f"{kind}-grenade"

        # Held, thrown and lying where it landed: the old 93 x 78 frame, unchanged placement.
        hand = finish(grenade(kind))
        assert hand.size == (HAND_W, HAND_H), hand.size
        hand.save(os.path.join(OUT, f"day-hand-{name}.png"), optimize=True)

        # On the ground: tipped over, fuse up and to the left, with the pickup ring.
        ground_src = grenade(kind, pad=16, angle=-38)
        ground = finish(crop_to_content(loot_ring(ground_src), 1))
        ground.save(os.path.join(OUT, f"day-ground-{name}.png"), optimize=True)

        # Inventory icon: frameless (like the other project icons), fuse up, 112 x 112.
        icon_src = crop_to_content(grenade(kind, k=1.5, pad=24, outline=3.4, angle=-62), 1)
        size = 112 * SS
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        scale = min((size - 10 * SS) / icon_src.width, (size - 10 * SS) / icon_src.height)
        icon_src = icon_src.resize((int(icon_src.width * scale), int(icon_src.height * scale)), Image.LANCZOS)
        canvas.alpha_composite(icon_src, ((size - icon_src.width) // 2, (size - icon_src.height) // 2))
        finish(canvas).save(os.path.join(OUT, f"inv-{name}-out.png"), optimize=True)

        print(f"{name}: hand {hand.width}x{hand.height}, ground {ground.width}x{ground.height}, icon 112x112")
    return 0


if __name__ == "__main__":
    sys.exit(main())
