"""Brancard app icons: a big medical plus in a white disc above someone lying on a stretcher,
white on red. Run: python3 -I assets/make_icons.py assets/
mark() is the one drawing of the logo; promo/make_flyer.py and promo/make_video.py import it."""
import math
import sys

import cairo

RED = (0.898, 0.282, 0.302)
WHITE = (1, 1, 1)


def rrect(cr, x, y, w, h, r):
    cr.new_sub_path()
    for (px, py, a) in ((x + w - r, y + r, -math.pi / 2), (x + w - r, y + h - r, 0), (x + r, y + h - r, math.pi / 2), (x + r, y + r, math.pi)):
        cr.arc(px, py, r, a, a + math.pi / 2)
    cr.close_path()


def plus(cr, px, py, arm, th):
    rrect(cr, px - th / 2, py - arm, th, arm * 2, th / 2)
    rrect(cr, px - arm, py - th / 2, arm * 2, th, th / 2)


def mark(cr, cx, cy, u, ink=WHITE, cut=RED):
    """The logo centred on (cx, cy); u = width of the visible icon it sits in. Plus disc on top,
    stretcher low. The plus is drawn in `cut` (the tile colour), or punched out when cut is None."""
    S = 0.66 * u
    lw = 0.07 * S
    bar = cy + 0.31 * u
    cr.set_source_rgb(*ink)
    rrect(cr, cx - S / 2, bar, S, lw, lw / 2)
    for x in (-0.3, 0.3):
        rrect(cr, cx + S * x - lw / 2, bar, lw, 0.2 * S, lw / 2)
    cr.fill()
    cr.arc(cx - 0.27 * S, bar - 0.13 * S, 0.085 * S, 0, 2 * math.pi)
    cr.fill()
    rrect(cr, cx - 0.15 * S, bar - 0.21 * S, 0.47 * S, 0.17 * S, 0.085 * S)
    cr.fill()
    px, py = cx, cy - 0.19 * u
    cr.arc(px, py, 0.21 * u, 0, 2 * math.pi)
    cr.fill()
    cr.save()
    if cut:
        cr.set_source_rgb(*cut)
    else:
        cr.set_operator(cairo.OPERATOR_CLEAR)
    plus(cr, px, py, 0.15 * u, 0.088 * u)
    cr.fill()
    cr.restore()


def png(name, size, bg=None, u=0.0, radius=0.0, cut=RED):
    # A full square tile has no transparency: save it without alpha (the App Store refuses icons with one).
    surf = cairo.ImageSurface(cairo.FORMAT_RGB24 if bg and not radius else cairo.FORMAT_ARGB32, size, size)
    cr = cairo.Context(surf)
    if bg:
        cr.set_source_rgb(*bg)
        if radius:
            rrect(cr, 0, 0, size, size, size * radius)
            cr.fill()
        else:
            cr.paint()
    if u:
        mark(cr, size / 2, size / 2, size * u, cut=cut)
    surf.write_to_png(f"{sys.argv[1]}/{name}")


if __name__ == "__main__":
    png("icon.png", 1024, RED, 0.86)
    png("splash-icon.png", 1024, RED, 0.86, radius=0.22)
    png("favicon.png", 48, RED, 0.86, radius=0.22)
    png("android-icon-background.png", 512, RED)
    # Adaptive icons show only the inner 2/3 of the layer, sometimes as a circle: keep the mark well inside.
    png("android-icon-foreground.png", 512, None, 0.6, cut=None)
    png("android-icon-monochrome.png", 432, None, 0.6, cut=None)
    png("mark.png", 192, None, 1.0, cut=None)  # the app's welcome screen puts it on a red tile
