#!/usr/bin/env python3
# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

"""
Draws the molotov's own art into apps/client/public/img (project art, not an
original asset):

    day-hand-molotov.png     night-hand-molotov.png      held, and thrown
    day-ground-molotov.png   night-ground-molotov.png    lying on the ground
    inv-molotov-out.png                                  inventory / HUD icon

In the game's style: flat fills with a soft band of light, a thick near-black
outline, and on the ground the same gold pickup ring and shadow the other
loot has. Everything is drawn 4x and scaled down, so edges are smooth. Sprites
are 2x (world size is half the pixel size), like every other sprite.

    python tools/assets/molotov-art.py

Needs Pillow. The rag's flame is not in the picture: the client draws it live
(equipables.xml <client><flame>), so it flickers.
"""

import math
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "apps", "client", "public", "img")
SS = 4  # supersampling

OUTLINE = (6, 8, 9, 255)
GLASS = (74, 128, 70, 255)
GLASS_DARK = (52, 96, 52, 255)
GLASS_LIGHT = (128, 182, 118, 255)
FUEL = (214, 120, 36, 255)
FUEL_DARK = (176, 86, 26, 255)
LABEL = (226, 212, 170, 255)
LABEL_DARK = (196, 178, 132, 255)
RAG = (222, 206, 168, 255)
RAG_DARK = (176, 156, 116, 255)
SOOT = (92, 80, 62, 255)
RING = (152, 144, 53, 255)


def bottle_layer(length, girth):
    """
    The bottle on its side, base at the left, mouth and rag at the right, at
    SS x scale. Returns (image, rag_tip) where rag_tip is the rag's free end in
    the image's pixels.
    """
    L = int(length * SS)
    G = int(girth * SS)
    pad = int(14 * SS)
    w = L + pad * 2
    h = G + pad * 2
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cy = h / 2

    body_len = L * 0.58
    neck_len = L * 0.22
    x0 = pad
    x_body_end = x0 + body_len
    x_neck_end = x_body_end + neck_len * 0.55 + neck_len * 0.45
    neck_g = G * 0.42
    r = G * 0.32

    # Body: a rounded slab of glass, the fuel showing through its lower part.
    d.rounded_rectangle([x0, cy - G / 2, x_body_end, cy + G / 2], radius=r, fill=GLASS)
    # Shoulder taper into the neck.
    d.polygon(
        [
            (x_body_end - r, cy - G / 2),
            (x_body_end + neck_len * 0.55, cy - neck_g / 2),
            (x_body_end + neck_len * 0.55, cy + neck_g / 2),
            (x_body_end - r, cy + G / 2),
        ],
        fill=GLASS,
    )
    d.rounded_rectangle(
        [x_body_end + neck_len * 0.3, cy - neck_g / 2, x_neck_end, cy + neck_g / 2], radius=neck_g * 0.3, fill=GLASS
    )
    # Fuel: the far side of the bottle, sloshing at an angle.
    fuel = Image.new("L", (w, h), 0)
    fd = ImageDraw.Draw(fuel)
    fd.polygon(
        [(x0, cy + G * 0.02), (x_body_end + neck_len * 0.2, cy + G * 0.14), (x_body_end + neck_len * 0.2, cy + G), (x0, cy + G)],
        fill=255,
    )
    glass_mask = img.getchannel("A")
    fuel = ImageChops.multiply(fuel, glass_mask)
    img.paste(Image.new("RGBA", (w, h), FUEL), (0, 0), fuel)
    shade = Image.new("L", (w, h), 0)
    ImageDraw.Draw(shade).rectangle([0, cy + G * 0.3, w, h], fill=255)
    img.paste(Image.new("RGBA", (w, h), FUEL_DARK), (0, 0), ImageChops.multiply(shade, fuel))
    # Glass shading: a darker underside and a long highlight along the top.
    under = Image.new("L", (w, h), 0)
    ImageDraw.Draw(under).rectangle([0, cy + G * 0.36, w, h], fill=110)
    img.paste(Image.new("RGBA", (w, h), GLASS_DARK), (0, 0), ImageChops.multiply(under, ImageChops.subtract(glass_mask, fuel)))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(
        [x0 + r * 0.6, cy - G * 0.36, x_body_end - r * 0.2, cy - G * 0.22], radius=G * 0.07, fill=GLASS_LIGHT
    )
    d.rounded_rectangle(
        [x_body_end + neck_len * 0.4, cy - neck_g * 0.32, x_neck_end - neck_g * 0.2, cy - neck_g * 0.12],
        radius=neck_g * 0.1,
        fill=GLASS_LIGHT,
    )
    # Label band.
    lx0 = x0 + body_len * 0.28
    lx1 = x0 + body_len * 0.62
    d.rectangle([lx0, cy - G / 2 + SS, lx1, cy + G / 2 - SS], fill=LABEL)
    d.rectangle([lx0, cy + G * 0.18, lx1, cy + G / 2 - SS], fill=LABEL_DARK)
    d.line([(lx0, cy - G / 2 + SS), (lx0, cy + G / 2 - SS)], fill=LABEL_DARK, width=SS)

    # Rag: wrapped round the neck, then stuffed into the mouth and hanging out.
    wrap_x0 = x_body_end + neck_len * 0.45
    wrap_x1 = wrap_x0 + neck_len * 0.38
    d.rounded_rectangle([wrap_x0, cy - neck_g * 0.62, wrap_x1, cy + neck_g * 0.62], radius=neck_g * 0.2, fill=RAG)
    d.rectangle([wrap_x0, cy + neck_g * 0.15, wrap_x1, cy + neck_g * 0.62], fill=RAG_DARK)
    tail_len = L * 0.27
    tx0 = x_neck_end - neck_g * 0.1
    tip = (tx0 + tail_len, cy - G * 0.2)
    # A ragged strip of cloth flopping out of the mouth, two torn ends.
    d.polygon(
        [
            (tx0, cy - neck_g * 0.5),
            (tx0 + tail_len * 0.45, cy - neck_g * 0.9),
            (tip[0], tip[1] - neck_g * 0.55),
            (tip[0] - tail_len * 0.12, tip[1] - neck_g * 0.05),
            (tip[0] + SS, tip[1] + neck_g * 0.35),
            (tx0 + tail_len * 0.55, cy + neck_g * 0.55),
            (tx0, cy + neck_g * 0.5),
        ],
        fill=RAG,
    )
    d.polygon(
        [
            (tx0, cy + neck_g * 0.1),
            (tx0 + tail_len * 0.5, cy + neck_g * 0.1),
            (tip[0] + SS, tip[1] + neck_g * 0.35),
            (tx0 + tail_len * 0.55, cy + neck_g * 0.55),
            (tx0, cy + neck_g * 0.5),
        ],
        fill=RAG_DARK,
    )
    # Its end is scorched where it burns.
    d.polygon(
        [
            (tx0 + tail_len * 0.68, cy - neck_g * 0.78),
            (tip[0], tip[1] - neck_g * 0.55),
            (tip[0] - tail_len * 0.12, tip[1] - neck_g * 0.05),
            (tip[0] + SS, tip[1] + neck_g * 0.35),
            (tx0 + tail_len * 0.7, cy + neck_g * 0.42),
        ],
        fill=SOOT,
    )
    return img, tip


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
    out.paste(Image.new("RGBA", img.size, RING), (0, 0), ring)
    out.alpha_composite(img)
    return out


def pad_canvas(img, px):
    p = int(px * SS)
    out = Image.new("RGBA", (img.width + p * 2, img.height + p * 2), (0, 0, 0, 0))
    out.paste(img, (p, p))
    return out


def crop_to_content(img, margin):
    box = img.getchannel("A").getbbox()
    m = int(margin * SS)
    return img.crop((box[0] - m, box[1] - m, box[2] + m, box[3] + m))


def finish(img):
    """Down from SS x to sprite pixels."""
    w = max(1, round(img.width / SS))
    h = max(1, round(img.height / SS))
    return img.resize((w, h), Image.LANCZOS)


def night(img, factor, tint=(0, 3, 10)):
    """The night palette: darker, a touch desaturated and blue, alpha kept."""
    px = img.load()
    out = img.copy()
    po = out.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            lum = 0.3 * r + 0.59 * g + 0.11 * b
            r2 = (r * 0.6 + lum * 0.4) * factor + tint[0]
            g2 = (g * 0.6 + lum * 0.4) * factor + tint[1]
            b2 = (b * 0.6 + lum * 0.4) * factor + tint[2]
            po[x, y] = (min(255, int(r2)), min(255, int(g2)), min(255, int(b2)), a)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)

    # Held / thrown: lying along +x (the facing), mouth forward. ~54 x 24 world units.
    bottle, tip = bottle_layer(90, 32)
    hand = crop_to_content(outlined(pad_canvas(bottle, 4), 3.2), 0.5)
    box = outlined(pad_canvas(bottle, 4), 3.2).getchannel("A").getbbox()
    # Where the rag's end lands in the finished sprite, from its centre, in world units.
    tip_px = ((tip[0] + 4 * SS - box[0] + 0.5 * SS), (tip[1] + 4 * SS - box[1] + 0.5 * SS))
    hand_f = finish(hand)
    hand_f.save(os.path.join(OUT, "day-hand-molotov.png"))
    night(hand_f, 0.42).save(os.path.join(OUT, "night-hand-molotov.png"))
    cx = hand.width / 2
    cy = hand.height / 2
    print(
        "hand sprite %dx%d; rag tip from centre: x=%.1f y=%.1f world units"
        % (hand_f.width, hand_f.height, (tip_px[0] - cx) / SS / 2, (tip_px[1] - cy) / SS / 2)
    )

    # On the ground: tipped over at an angle, with the pickup ring.
    ground_src = outlined(pad_canvas(bottle_layer(84, 31)[0], 10), 3.2)
    ground_src = ground_src.rotate(38, resample=Image.BICUBIC, expand=True)
    ground = finish(crop_to_content(loot_ring(pad_canvas(ground_src, 8)), 1))
    ground.save(os.path.join(OUT, "day-ground-molotov.png"))
    night(ground, 0.66, (0, 2, 6)).save(os.path.join(OUT, "night-ground-molotov.png"))
    print("ground sprite %dx%d" % ground.size)

    # Inventory icon: frameless (like the other project icons), upright-ish, 112 x 112.
    icon_src = outlined(pad_canvas(bottle_layer(150, 54)[0], 10), 5)
    icon_src = icon_src.rotate(45, resample=Image.BICUBIC, expand=True)
    icon_src = crop_to_content(icon_src, 1)
    size = 112 * SS
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    scale = min((size - 12 * SS) / icon_src.width, (size - 12 * SS) / icon_src.height)
    icon_src = icon_src.resize((int(icon_src.width * scale), int(icon_src.height * scale)), Image.LANCZOS)
    canvas.alpha_composite(icon_src, ((size - icon_src.width) // 2, (size - icon_src.height) // 2))
    finish(canvas).save(os.path.join(OUT, "inv-molotov-out.png"))
    print("icon 112x112")
    return 0


if __name__ == "__main__":
    sys.exit(main())
