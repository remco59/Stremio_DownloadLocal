#!/usr/bin/env python3
"""Draws the web UI's icons (public/*.png, favicon.ico) from the same shapes as public/favicon.svg.
Needs Pillow:  pip install pillow   then   python3 scripts/make-icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public"
ACC, WHITE = (108, 80, 245, 255), (255, 255, 255, 255)
SS = 4  # supersampling for smooth edges


def line(d, a, b, w):
    d.line([a, b], fill=WHITE, width=w)
    for x, y in (a, b):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=WHITE)


def icon(size, rounded=True, scale=1.0):
    """A download arrow into a tray on the accent colour. `scale` shrinks the glyph (maskable icons need a safe zone)."""
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=n * 112 / 512, fill=ACC)
    else:
        d.rectangle([0, 0, n, n], fill=ACC)
    k = n / 512 * scale
    o = n * (1 - scale) / 2
    p = lambda x, y: (o + x * k, o + y * k)
    w = round(40 * k)
    line(d, p(256, 120), p(256, 300), w)
    line(d, p(176, 224), p(256, 304), w)
    line(d, p(336, 224), p(256, 304), w)
    line(d, p(136, 384), p(376, 384), w)
    return img.resize((size, size), Image.LANCZOS)


icon(512).save(OUT / "icon-512.png")
icon(192).save(OUT / "icon-192.png")
icon(512, rounded=False, scale=0.7).save(OUT / "icon-maskable-512.png")
icon(180, rounded=False, scale=0.8).save(OUT / "apple-touch-icon.png")  # iOS rounds the corners itself
icon(256).save(OUT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
