"""A4 sheet of 20 square cards (48 mm) to cut out and hand around: icon, one line on what Brancard
does, a QR code to the download page. Vector PDF (crisp QR at any printer) + PNG preview.

Usage: python3 -I make_flyer.py OUT.pdf [URL]      the A4 sheet (+ OUT.png preview)
       python3 -I make_flyer.py --qr URL OUT.png  one QR code with the icon in its centre   (needs bun (auto-installs qrcode for promo/qr.js) and the Inter font)
"""
import json, os, subprocess, sys
import cairo

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets"))
from make_icons import stretcher  # noqa: E402

NAME = "Brancard"
HERE = os.path.dirname(os.path.abspath(__file__))
MM = 72 / 25.4
W, H = 210, 297
CARD, COLS, ROWS = 48, 4, 5
X0, Y0 = (W - COLS * CARD) / 2, (H - ROWS * CARD) / 2
RED = (0xE5 / 255, 0x48 / 255, 0x4D / 255)
INK = (0.07, 0.07, 0.08)



def qrdata(url):
    # Level H (30 % redundancy) so the icon covering the centre doesn't stop phones reading it.
    return json.loads(subprocess.check_output(["bun", "--install=force", os.path.join(HERE, "qr.js"), url, "H"], cwd=HERE))


def rrect(cr, x, y, w, h, r):
    cr.new_sub_path()
    cr.arc(x + w - r, y + r, r, -1.5708, 0)
    cr.arc(x + w - r, y + h - r, r, 0, 1.5708)
    cr.arc(x + r, y + h - r, r, 1.5708, 3.1416)
    cr.arc(x + r, y + r, r, 3.1416, 4.7124)
    cr.close_path()


def icon(cr, x, y, s):
    """The app icon: red rounded square with the mark from assets/make_icons.py."""
    cr.set_source_rgb(*RED)
    rrect(cr, x, y, s, s, s * 0.24)
    cr.fill()
    stretcher(cr, x + s / 2, y + s / 2, s * 0.62)


def text(cr, s, x, y, size, bold=True, color=INK, width=None, lead=1.25):
    """Draws s from baseline y, wrapping at width (mm). Returns the next baseline."""
    cr.select_font_face("Inter", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD if bold else cairo.FONT_WEIGHT_NORMAL)
    cr.set_font_size(size / MM)  # size in pt, user space in mm
    cr.set_source_rgb(*color)
    lines = []
    for para in s.split("\n"):  # explicit breaks first, then wrap what's still too wide
        cur = ""
        for w in para.split(" "):
            t = (cur + " " + w).strip()
            if width and cur and cr.text_extents(t).x_advance > width:
                lines.append(cur)
                cur = w
            else:
                cur = t
        lines.append(cur)
    for ln in lines:
        cr.move_to(x, y)
        cr.show_text(ln)
        cr.new_path()
        y += size / MM * lead
    return y


def qrcode(cr, x, y, s, qr, quiet=1):
    n = qr["size"]
    m = s / (n + 2 * quiet)
    cr.set_source_rgb(*INK)
    for i, on in enumerate(qr["data"]):
        if on:
            cr.rectangle(x + m * (quiet + i % n), y + m * (quiet + i // n), m * 1.02, m * 1.02)
    cr.fill()
    # Icon as a badge on the bottom-right corner (the one without a finder pattern): centred on the
    # corner point, it hides only ~3x3 modules, which level H recovers.
    b = m * 7
    cx, cy = x + m * (quiet + n), y + m * (quiet + n)
    cr.set_source_rgb(1, 1, 1)
    rrect(cr, cx - b / 2, cy - b / 2, b, b, b * 0.26)
    cr.fill()
    icon(cr, cx - b / 2 + m * 0.6, cy - b / 2 + m * 0.6, b - m * 1.2)


def card(cr, x, y):
    p = 3.5
    icon(cr, x + p, y + p, 7)
    text(cr, NAME, x + p + 9, y + p + 5.4, 13)
    text(cr, "Alerte les street medics\nautour de toi,\nmême sans réseau.", x + p, y + 14.2, 8, width=CARD - 2 * p, lead=1.18)
    qrcode(cr, x + p - 0.7, y + 21.8, 22, SITE)
    text(cr, "Installe-la avant la manif", x + 28.5, y + 31, 7.5, width=CARD - 28.5 - p)


def page(surface, k=1):
    cr = cairo.Context(surface)
    cr.scale(MM * k, MM * k)  # work in millimetres
    cr.set_source_rgb(1, 1, 1)
    cr.paint()
    for r in range(ROWS):
        for c in range(COLS):
            card(cr, X0 + c * CARD, Y0 + r * CARD)
    # Cut lines: one straight cut serves two cards, running into the margins.
    cr.set_source_rgb(0.72, 0.72, 0.74)
    cr.set_line_width(0.15)
    cr.set_dash([1.2, 1.2])
    for c in range(COLS + 1):
        cr.move_to(X0 + c * CARD, 4); cr.line_to(X0 + c * CARD, H - 4)
    for r in range(ROWS + 1):
        cr.move_to(4, Y0 + r * CARD); cr.line_to(W - 4, Y0 + r * CARD)
    cr.stroke()
    cr.set_dash([])
    text(cr, "Découper le long des pointillés", X0, Y0 - 6, 7, bold=False, color=(0.55, 0.55, 0.57))


if sys.argv[1] == "--qr":
    url, out = sys.argv[2], sys.argv[3]
    img = cairo.ImageSurface(cairo.FORMAT_RGB24, 1200, 1200)
    cr = cairo.Context(img)
    cr.set_source_rgb(1, 1, 1)
    cr.paint()
    qrcode(cr, 0, 0, 1200, qrdata(url), quiet=4)
    img.write_to_png(out)
    sys.exit()

OUT = sys.argv[1]
SITE = qrdata(sys.argv[2] if len(sys.argv) > 2 else "https://echo.vitrixxl.fr")
pdf = cairo.PDFSurface(OUT, W * MM, H * MM)
page(pdf)
pdf.finish()
png = cairo.ImageSurface(cairo.FORMAT_RGB24, int(W * MM * 3), int(H * MM * 3))
page(png, 3)
png.write_to_png(OUT.rsplit(".", 1)[0] + ".png")
