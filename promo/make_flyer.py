"""A4 sheet of 20 square cards (48 mm) to cut out and hand around: logo, what Brancard does, a QR
code to the download page. Vector PDF (crisp QR at any printer) + PNG preview.
Every line break is set by hand and every block sized to fit its column: nothing wraps by accident.

Usage: python3 -I make_flyer.py OUT.pdf [URL]      the A4 sheet (+ OUT.png preview)
       python3 -I make_flyer.py --qr URL OUT.png  one QR code, plain
Needs bun (auto-installs qrcode for promo/qr.js) and the Inter font.
"""
import json, os, subprocess, sys
import cairo

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets"))
from make_icons import mark  # noqa: E402

NAME = "Brancard"
HERE = os.path.dirname(os.path.abspath(__file__))
MM = 72 / 25.4
W, H = 210, 297
CARD, COLS, ROWS = 48, 4, 5
X0, Y0 = (W - COLS * CARD) / 2, (H - ROWS * CARD) / 2
RED = (0xE5 / 255, 0x48 / 255, 0x4D / 255)
INK = (0.07, 0.07, 0.08)



def qrdata(url):
    # Level M: nothing covers the code, so bigger modules beat extra redundancy.
    return json.loads(subprocess.check_output(["bun", "--install=force", os.path.join(HERE, "qr.js"), url, "M"], cwd=HERE))


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
    mark(cr, x + s / 2, y + s / 2, s * 0.86)


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


def font(cr, size, bold=True):
    cr.select_font_face("Inter", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD if bold else cairo.FONT_WEIGHT_NORMAL)
    cr.set_font_size(size / MM)


def fit(cr, lines, width, size, bold=True):
    """Largest size (pt, down from `size`) at which every line fits `width` mm."""
    while size > 5:
        font(cr, size, bold)
        if max(cr.text_extents(ln).x_advance for ln in lines) <= width:
            return size
        size -= 0.1
    return size


def block(cr, lines, x, y, size, color=INK, bold=True, lead=1.2):
    """Hand-broken lines from baseline y. Returns the last baseline."""
    font(cr, size, bold)
    cr.set_source_rgb(*color)
    for k, ln in enumerate(lines):
        cr.move_to(x, y + k * size / MM * lead)
        cr.show_text(ln)
        cr.new_path()
    return y + (len(lines) - 1) * size / MM * lead


P = 4  # card margin, also the QR code's quiet zone on its free sides
MESSAGE = ["Alerte les street medics", "autour de toi, sans réseau."]
CTA = ["Installe-la", "avant", "la manif."]


def card(cr, x, y):
    inner = CARD - 2 * P
    # Brand: logo tile, name centred on it (Inter cap height = 0.727 em).
    icon(cr, x + P, y + P, 8)
    block(cr, [NAME], x + P + 10.5, y + P + 4 + 14 / MM * 0.727 / 2, 14)
    # Message: two lines set to the full measure.
    m = fit(cr, MESSAGE, inner, 9)
    last = block(cr, MESSAGE, x + P, y + 16.8, m)
    # Action: the code at the bottom-left, the call to action stacked beside it, bottoms aligned.
    q = CARD - P - (last + 3.2 - y)  # same 2.5 mm gap under the message as above it
    qrcode(cr, x + P, y + CARD - P - q, q, SITE, quiet=0)
    col = inner - q - 3
    c = fit(cr, CTA, col, 10.5)
    block(cr, CTA, x + P + q + 3, y + CARD - P - 0.2 - (len(CTA) - 1) * c / MM * 1.12, c, color=RED, lead=1.12)


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
