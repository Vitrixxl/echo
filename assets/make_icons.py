"""Brancard app icons: someone lying on a stretcher, white on red. No red cross (protected emblem).
Run: python3 -I assets/make_icons.py assets/
stretcher() is the one drawing of the mark; promo/make_flyer.py and promo/make_video.py import it."""
import math
import sys

import cairo

RED = (0.898, 0.282, 0.302)


def rrect(cr, x, y, w, h, r):
    cr.new_sub_path()
    for (px, py, a) in ((x + w - r, y + r, -math.pi / 2), (x + w - r, y + h - r, 0), (x + r, y + h - r, math.pi / 2), (x + r, y + r, math.pi)):
        cr.arc(px, py, r, a, a + math.pi / 2)
    cr.close_path()


def stretcher(cr, cx, cy, s, color=(1, 1, 1)):
    """Centered mark, s = overall width: a medical plus above someone lying on a stretcher.
    The plus is white with rounded ends on the red tile, never red on white (Red Cross emblem)."""
    cr.set_source_rgb(*color)
    cy += s * 0.08  # balance the plus above against the legs below
    lw = s * 0.07
    arm, th = s * 0.13, s * 0.085
    px, py = cx + s * 0.08, cy - s * 0.36
    rrect(cr, px - th / 2, py - arm, th, arm * 2, th / 2)
    rrect(cr, px - arm, py - th / 2, arm * 2, th, th / 2)
    cr.fill()
    rrect(cr, cx - s * 0.5, cy + s * 0.08, s, lw, lw / 2)
    for x in (-0.3, 0.3):
        rrect(cr, cx + s * x - lw / 2, cy + s * 0.08, lw, s * 0.2, lw / 2)
    cr.fill()
    cr.arc(cx - s * 0.27, cy - s * 0.05, s * 0.085, 0, 2 * math.pi)
    cr.fill()
    rrect(cr, cx - s * 0.15, cy - s * 0.13, s * 0.47, s * 0.17, s * 0.085)
    cr.fill()


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
        stretcher(cr, size / 2, size / 2, size * mark, color)
    surf.write_to_png(f"{sys.argv[1]}/{name}")


if __name__ == "__main__":
    out = sys.argv[1]
    png("icon.png", 1024, RED, 0.62)
    png("splash-icon.png", 1024, RED, 0.62, radius=0.22)  # red tile: never the mark in red on white
    png("favicon.png", 48, RED, 0.62, radius=0.2)
    png("android-icon-background.png", 512, RED)
    png("android-icon-foreground.png", 512, None, 0.42)  # adaptive icons crop to the inner ~66 %
    png("android-icon-monochrome.png", 432, None, 0.42)
