#!/usr/bin/env python3
"""Draws the backdrops of the status screens (assets/scene-*.png): a dark gradient with a soft glow in the state's
colour and a ring icon. Text and the progress bar are added by ffmpeg (statusscreen.js), so the icon centre here
has to match the layout there.
Needs Pillow and numpy:  pip install pillow numpy   then   python3 scripts/make-scenes.py

The fonts in assets/fonts are Inter Regular and SemiBold cut down to Latin, Greek and Cyrillic:
  pip install fonttools
  pyftsubset Inter-<weight>.otf --unicodes="U+0020-007E,U+00A0-024F,U+0370-03FF,U+0400-04FF,U+2010-2027,U+2030,U+2190-2193,U+2212" \\
    --layout-features='kern,liga,calt,case,tnum' --output-file=assets/fonts/Inter-<weight>.otf"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "assets"
W, H = 1920, 1080
SS = 4  # supersampling for smooth icon edges
BG = (15, 17, 21)  # the web UI's --bg
GLOW_RX, GLOW_RY = 620, 490  # radii of the glow
INK = (230, 232, 236)  # --fg
ICON_C, ICON_R = (960, 318), 100

ACCENT = (108, 80, 245)  # --acc
GREEN = (62, 207, 142)  # --ok
RED = (255, 107, 107)  # --err


def backdrop(accent):
    """The web UI's flat background with a soft glow of the accent colour behind the icon. The glow is dithered
    (a smooth 8-bit gradient shows rings on a dark screen); the flat rest stays free of noise, which keeps the video small."""
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    dist = np.hypot((x - ICON_C[0]) / GLOW_RX, (y - ICON_C[1]) / GLOW_RY)  # 0 at the icon, 1 at the glow's edge
    mask = ((1 - dist).clip(0) ** 2.2 * 0.24).astype(np.float32)  # soft falloff, up to 24% accent
    rgb = np.array(BG, dtype=np.float32) + (np.array(accent, dtype=np.float32) - BG) * mask[..., None]
    noise = np.random.default_rng(7).triangular(-1, 0, 1, (H, W, 1)).astype(np.float32)  # same on R, G and B: compresses better
    rgb = rgb + noise * (mask[..., None] > 0.002)
    return Image.fromarray(rgb.round().clip(0, 255).astype(np.uint8), "RGB")


def stroke(d, pts, w, fill=INK):
    d.line(pts, fill=fill, width=w, joint="curve")
    for x, y in (pts[0], pts[-1]):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=fill)


def glyph(name, d, k, c):
    """Icon glyphs drawn around the point `c`; coordinates are in a 200x200 box centred on (0,0), scaled by k."""
    p = lambda x, y: (c + x * k, c + y * k)
    w = round(15 * k)
    if name == "download":  # the add-on's app icon: an arrow into a tray
        s = 0.36
        q = lambda x, y: p((x - 256) * s, (y - 252) * s)
        stroke(d, [q(256, 120), q(256, 300)], w)
        stroke(d, [q(176, 224), q(256, 304), q(336, 224)], w)
        stroke(d, [q(136, 384), q(376, 384)], w)
    elif name == "search":
        r = 27
        cx = cy = -7
        d.ellipse([*p(cx - r, cy - r), *p(cx + r, cy + r)], outline=INK, width=w)
        stroke(d, [p(13, 13), p(35, 35)], w)
    elif name == "ready":  # play triangle, nudged right so it looks centred
        pts = [p(-17, -30), p(-17, 30), p(33, 0)]
        d.polygon(pts, fill=INK)
        for a, b in zip(pts, pts[1:] + pts[:1]):  # round the corners with round-capped edges
            stroke(d, [a, b], round(10 * k))
    elif name == "error":
        stroke(d, [p(0, -34), p(0, 6)], w)
        r = 8.5
        d.ellipse([*p(-r, 32 - r), *p(r, 32 + r)], fill=INK)


def icon_layer(name, accent):
    n = (ICON_R * 2 + 40) * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = n / 2
    r = ICON_R * SS
    d.ellipse([c - r, c - r, c + r, c + r], fill=(*accent, 40))  # soft disc
    d.ellipse([c - r, c - r, c + r, c + r], outline=(*accent, 150), width=3 * SS)  # ring
    glyph(name, d, SS, c)
    return img.resize((n // SS, n // SS), Image.LANCZOS)


def scene(name, glyph_name, accent):
    img = backdrop(accent).convert("RGBA")
    icon = icon_layer(glyph_name, accent)
    img.alpha_composite(icon, (ICON_C[0] - icon.width // 2, ICON_C[1] - icon.height // 2))
    img.convert("RGB").save(OUT / f"scene-{name}.png", optimize=True)


if __name__ == "__main__":
    scene("search", "search", ACCENT)
    scene("download", "download", ACCENT)
    scene("ready", "ready", GREEN)
    scene("error", "error", RED)
    for f in sorted(OUT.glob("scene-*.png")):
        print(f.name, f.stat().st_size, "bytes")
