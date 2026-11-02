"""Brancard app icons: a dot with echo waves, white on red. No red cross (protected emblem).
Run: python3 -I assets/make_icons.py assets/"""
import math
import sys

import cairo

RED = (0.898, 0.282, 0.302)
out = sys.argv[1]


def waves(cr, cx, cy, s, color=(1, 1, 1)):
    """Centered mark, s = overall width."""
    cr.set_source_rgb(*color)
    cr.arc(cx, cy, s * 0.085, 0, 2 * math.pi)
    cr.fill()
    cr.set_line_width(s * 0.07)
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    for r in (0.24, 0.4):
        for a0 in (-0.75, math.pi - 0.75):
            cr.new_sub_path()
            cr.arc(cx, cy, s * r, a0, a0 + 1.5)
    cr.stroke()


def png(name, size, bg=None, mark=0.0, color=(1, 1, 1), radius=0.0):
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, size, size)
    cr = cairo.Context(surf)
    if bg:
        cr.set_source_rgb(*bg)
        if radius:
            r = size * radius
            cr.new_sub_path()
            for (x, y, a) in ((size - r, r, -math.pi / 2), (size - r, size - r, 0), (r, size - r, math.pi / 2), (r, r, math.pi)):
                cr.arc(x, y, r, a, a + math.pi / 2)
            cr.close_path()
            cr.fill()
        else:
            cr.paint()
    if mark:
        waves(cr, size / 2, size / 2, size * mark, color)
    surf.write_to_png(f"{out}/{name}")


png("icon.png", 1024, RED, 0.62)
png("splash-icon.png", 1024, None, 0.5, RED)
png("favicon.png", 48, RED, 0.62, radius=0.2)
png("android-icon-background.png", 512, RED)
png("android-icon-foreground.png", 512, None, 0.42)  # adaptive icons crop to the inner ~66 %
png("android-icon-monochrome.png", 432, None, 0.42)
