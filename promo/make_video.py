"""Brancard TikTok explainer in the app's own look: dark background, rounded dark cards, Inter, the app's
red / green / orange / blue, real app screenshots in rounded frames. Everything moves on smooth eases
(fade + slight rise, no bounce, no tilt); word-by-word captions synced on the voice. 1080x1920, 30 fps,
cairo -> ffmpeg.

Usage: python3 -I make_video.py OUT.mp4 TTS_PYTHON [VOICE]
TTS_PYTHON: a Python with edge-tts installed (runs tts_edge.py; gives word timings for the captions).
VOICE: an edge-tts voice, default fr-FR-RemyMultilingualNeural (e.g. fr-FR-VivienneMultilingualNeural).
Screenshots: store/screenshots-6.9 (iPhone) and promo/trajet-1102.png (route). Font: Inter (fontconfig).
"""
import array
import hashlib
import json
import math
import os
import random
import subprocess
import sys
import tempfile
import wave

import cairo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "assets"))
from make_icons import mark, rrect  # noqa: E402  (the app mark, one drawing everywhere)


def hexrgb(h):
    return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))


W, H, FPS = 1080, 1920, 30
# The app's palette (App.tsx, const C)
BG, CARD, LINE = hexrgb("#0F1115"), hexrgb("#171A21"), hexrgb("#262A33")
TEXT, MUTED, DIM = hexrgb("#F2F4F7"), hexrgb("#9BA1A6"), hexrgb("#4A4F59")
RED, ORANGE, GREEN, BLUE = hexrgb("#E5484D"), hexrgb("#F5A524"), hexrgb("#30A46C"), hexrgb("#3E8EF7")
WHITE = (1, 1, 1)
SANS = "Inter"
CX = W / 2

out, tts_py = sys.argv[1:3]
VOICE_NAME, VOICE_RATE = (sys.argv[3] if len(sys.argv) > 3 else "fr-FR-RemyMultilingualNeural"), "+10%"
STORE = os.path.join(HERE, "..", "store", "screenshots-6.9")
SHOT = {
    "sos": cairo.ImageSurface.create_from_png(os.path.join(STORE, "1-alerte.png")),
    "confirm": cairo.ImageSurface.create_from_png(os.path.join(STORE, "2-envoyer-une-alerte.png")),
    "route": cairo.ImageSurface.create_from_png(os.path.join(HERE, "trajet-1102.png")),
}


# ---------------- helpers ----------------
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease(x):  # ease-out cubic: fast start, soft landing
    x = clamp(x)
    return 1 - (1 - x) ** 3


def smooth(x):  # ease-in-out cubic
    x = clamp(x)
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def mix(a, b, k):
    return tuple(a[i] + (b[i] - a[i]) * k for i in range(3))


def sans(cr, size, bold=True):
    cr.select_font_face(SANS, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD if bold else cairo.FONT_WEIGHT_NORMAL)
    cr.set_font_size(size)


def ctext(cr, s, x, y, color=TEXT):
    """Text centered on (x, y)."""
    e = cr.text_extents(s)
    cr.set_source_rgb(*color)
    cr.move_to(x - e.x_advance / 2 - e.x_bearing, y - e.y_bearing - e.height / 2)
    cr.show_text(s)


def show(cr, p, x, y, fn, rise=36):
    """Draw fn() around (x, y): fades in while rising a little, with progress p (0..1)."""
    if p <= 0:
        return
    k = ease(p)
    cr.save()
    cr.translate(x, y + (1 - k) * rise)
    s = 0.97 + 0.03 * k
    cr.scale(s, s)
    cr.push_group()
    cr.new_path()
    fn()
    cr.pop_group_to_source()
    cr.paint_with_alpha(k)
    cr.restore()


def card(cr, w, h, r=32, fill=CARD, line=LINE):
    """Rounded dark card centered on origin, with a soft shadow."""
    for i in range(4):  # cheap soft shadow
        cr.set_source_rgba(0, 0, 0, 0.10)
        rrect(cr, -w / 2 - 2 * i, -h / 2 + 10 - 2 * i, w + 4 * i, h + 4 * i, r + 2 * i)
        cr.fill()
    cr.set_source_rgb(*fill)
    rrect(cr, -w / 2, -h / 2, w, h, r)
    cr.fill_preserve()
    cr.set_source_rgb(*line)
    cr.set_line_width(2)
    cr.stroke()


def pill(cr, label, color=None, size=34, solid=False, fg=TEXT):
    """The app's chip: dark pill with a coloured dot, or a solid coloured pill. Centered on origin."""
    sans(cr, size)
    e = cr.text_extents(label)
    dot = color is not None and not solid
    w = e.x_advance + size * 1.3 + (size * 0.75 if dot else 0)
    h = size * 1.9
    cr.set_source_rgb(*(color if solid else CARD))
    rrect(cr, -w / 2, -h / 2, w, h, h / 2)
    cr.fill_preserve()
    if not solid:
        cr.set_source_rgb(*LINE)
        cr.set_line_width(2)
        cr.stroke()
    else:
        cr.new_path()
    x = -w / 2 + size * 0.65
    if dot:
        cr.set_source_rgb(*color)
        cr.arc(x + size * 0.22, 0, size * 0.22, 0, 2 * math.pi)
        cr.fill()
        x += size * 0.75
    cr.set_source_rgb(*fg)
    cr.move_to(x - e.x_bearing, -e.y_bearing - e.height / 2)
    cr.show_text(label)


def button(cr, label, w, color=RED, size=40):
    """The app's big action button: full red, rounded, uppercase."""
    h = size * 2.6
    cr.set_source_rgba(*color, 0.25)
    rrect(cr, -w / 2, -h / 2 + 12, w, h, 30)
    cr.fill()
    cr.set_source_rgb(*color)
    rrect(cr, -w / 2, -h / 2, w, h, 30)
    cr.fill()
    sans(cr, size)
    ctext(cr, label, 0, 0, WHITE)


def icon_tile(cr, s):
    """The app icon (red tile, white mark), centered on origin."""
    cr.set_source_rgb(*RED)
    rrect(cr, -s / 2, -s / 2, s, s, s * 0.24)
    cr.fill()
    mark(cr, 0, 0, s, WHITE, RED)


def sos_marker(cr, r=30, halo=1.0):
    """The map's SOS marker: red disc, white "!", soft halo."""
    if halo > 0:
        cr.set_source_rgba(*RED, 0.22 * halo)
        cr.arc(0, 0, r * 1.75, 0, 2 * math.pi)
        cr.fill()
    cr.set_source_rgb(*RED)
    cr.arc(0, 0, r, 0, 2 * math.pi)
    cr.fill()
    cr.set_source_rgb(*WHITE)
    rrect(cr, -r * 0.1, -r * 0.55, r * 0.2, r * 0.68, r * 0.1)
    cr.fill()
    cr.arc(0, r * 0.42, r * 0.12, 0, 2 * math.pi)
    cr.fill()


def medkit(cr, s=1.0, color=GREEN):
    """The app's medic badge: green rounded square, white cross."""
    cr.set_source_rgb(*color)
    rrect(cr, -30 * s, -24 * s, 60 * s, 48 * s, 12 * s)
    cr.fill()
    cr.set_source_rgb(*WHITE)
    rrect(cr, -5 * s, -15 * s, 10 * s, 30 * s, 3 * s)
    cr.fill()
    rrect(cr, -15 * s, -5 * s, 30 * s, 10 * s, 3 * s)
    cr.fill()


def phone(cr, s=1.0, ring=LINE, glow=None, fill=CARD):
    """A phone: rounded dark slab, its outline lit in `ring`."""
    w, h = 76 * s, 132 * s
    if glow:
        cr.set_source_rgba(*glow, 0.18)
        rrect(cr, -w / 2 - 14 * s, -h / 2 - 14 * s, w + 28 * s, h + 28 * s, 30 * s)
        cr.fill()
    cr.set_source_rgb(*fill)
    rrect(cr, -w / 2, -h / 2, w, h, 16 * s)
    cr.fill_preserve()
    cr.set_source_rgb(*ring)
    cr.set_line_width(4 * s)
    cr.stroke()
    cr.set_source_rgb(*ring)
    rrect(cr, -w / 6, -h / 2 + 9 * s, w / 3, 6 * s, 3 * s)
    cr.fill()


def screen(cr, shot, h):
    """A real app screenshot in a rounded device frame, centered on origin."""
    sw, sh = shot.get_width(), shot.get_height()
    w = h * sw / sh
    r = w * 0.13
    for i in range(5):
        cr.set_source_rgba(0, 0, 0, 0.12)
        rrect(cr, -w / 2 - 10 - 3 * i, -h / 2 - 10 + 14 - 3 * i, w + 20 + 6 * i, h + 20 + 6 * i, r + 10 + 3 * i)
        cr.fill()
    cr.set_source_rgb(*LINE)
    rrect(cr, -w / 2 - 10, -h / 2 - 10, w + 20, h + 20, r + 10)
    cr.fill()
    cr.save()
    rrect(cr, -w / 2, -h / 2, w, h, r)
    cr.clip()
    cr.translate(-w / 2, -h / 2)
    cr.scale(w / sw, h / sh)
    cr.set_source_surface(shot, 0, 0)
    cr.get_source().set_filter(cairo.FILTER_BEST)
    cr.paint()
    cr.restore()
    return w


def tap(cr, x, y, p):
    """A finger tap: a white ring widening and fading."""
    if 0 < p < 1:
        k = ease(p)
        cr.set_source_rgba(1, 1, 1, 0.35 * (1 - k))
        cr.arc(x, y, 30 + 70 * k, 0, 2 * math.pi)
        cr.fill()
        cr.set_source_rgba(1, 1, 1, 0.9 * (1 - k))
        cr.arc(x, y, 26, 0, 2 * math.pi)
        cr.fill()


def title(cr, s, size=64, color=TEXT):
    sans(cr, size)
    ctext(cr, s, 0, 0, color)


def kicker(cr, s, color=RED, size=30):
    """Small uppercase spaced label, like the site's section kickers."""
    sans(cr, size)
    s = " ".join(s.upper())
    ctext(cr, s, 0, 0, color)


def line_draw(cr, x1, y1, x2, y2, p, color, w=6):
    if p <= 0:
        return
    k = smooth(p)
    cr.move_to(x1, y1)
    cr.line_to(x1 + (x2 - x1) * k, y1 + (y2 - y1) * k)
    cr.set_source_rgb(*color)
    cr.set_line_width(w)
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.stroke()


# ---------------- scenes ----------------
class L:
    """Scene clock: t = local time, b[k] = local start of beat k, p() = appear progress."""

    def __init__(self, t, b):
        self.t, self.b = t, b

    def p(self, k, off=0.0, dur=0.55):
        return clamp((self.t - self.b[k] - off) / dur)


def sc_intro(cr, l):
    # three casualties appear on the dark map, then the app
    for i, (x, y) in enumerate(((300, 470), (560, 400), (800, 500))):
        def m(i=i):
            pulse = 0.5 + 0.5 * math.sin(l.t * 3 + i)
            sos_marker(cr, 34, 0.6 + 0.4 * pulse)
        show(cr, l.p(0, 0.3 + 0.35 * i), x, y, m)
    show(cr, l.p(0, 1.0), CX, 650, lambda: kicker(cr, "de plus en plus de blessés", RED, 32))

    def brand():
        card(cr, 600, 200, 40)
        cr.save()
        cr.translate(-190, 0)
        icon_tile(cr, 120)
        cr.restore()
        sans(cr, 84)
        cr.set_source_rgb(*TEXT)
        cr.move_to(-105, 30)
        cr.show_text("Brancard")
    show(cr, l.p(0, 3.0, 0.7), CX, 900, brand)


def sc_solution(cr, l):
    xs = [240, 440, 640, 840]
    y = 560
    for i, x in enumerate(xs):
        if i:
            line_draw(cr, xs[i - 1] + 50, y, x - 50, y, l.p(1, 0.15 + 0.4 * i, 0.4), RED, 6)
    for i, x in enumerate(xs):
        lit = l.t >= l.b[1] + 0.15 + 0.4 * i + (0.4 if i else 0)
        show(cr, l.p(1, 0.1 + 0.4 * i), x, y, lambda lit=lit: phone(cr, 1.0, RED if lit else LINE, RED if lit else None))
    show(cr, l.p(1, 0.1), 240, y - 120, lambda: pill(cr, "SOS", RED, 28, solid=True, fg=WHITE))

    def no_net():
        pill(cr, "Internet", MUTED, 40)
        k = smooth(l.p(0, 0.7, 0.4))
        if k > 0:
            sans(cr, 40)
            w = cr.text_extents("Internet").x_advance + 40 * 2.05
            cr.move_to(-w / 2 + 12, 0)
            cr.line_to(-w / 2 + 12 + (w - 24) * k, 0)
            cr.set_source_rgb(*RED)
            cr.set_line_width(6)
            cr.set_line_cap(cairo.LINE_CAP_ROUND)
            cr.stroke()
    show(cr, l.p(0, 0.3), CX, 820, no_net)
    show(cr, l.p(1, 2.4), CX, 960, lambda: kicker(cr, "téléphone à téléphone", BLUE, 30))


random.seed(11)
NODES = []
while len(NODES) < 15:
    q = (random.uniform(162, 912), random.uniform(380, 1020))
    if all(math.dist(q, o) > 175 for o in NODES):
        NODES.append(q)
EDGES = [(i, j) for i in range(len(NODES)) for j in range(i + 1, len(NODES)) if math.dist(NODES[i], NODES[j]) < 290]
SRC = min(range(len(NODES)), key=lambda i: NODES[i][0] + NODES[i][1])
HOP = {SRC: 0}
front = [SRC]
while front:
    nxt = []
    for u in front:
        for a, b in EDGES:
            v = b if a == u else a if b == u else None
            if v is not None and v not in HOP:
                HOP[v] = HOP[u] + 1
                nxt.append(v)
    front = nxt
ORDER = sorted(HOP, key=HOP.get)
MEDICS = {ORDER[-1], ORDER[len(ORDER) // 2 + 1]}


def sc_mesh(cr, l):
    start, hop = 0.9, 0.5
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    for i, j in EDGES:
        a = ease(l.p(0, 0.04 * min(i, j)))
        if a <= 0:
            continue
        cr.move_to(*NODES[i])
        cr.line_to(*NODES[j])
        cr.set_source_rgba(*LINE, a)
        cr.set_line_width(3)
        cr.stroke()
        hi, hj = HOP.get(i, 99), HOP.get(j, 99)
        if abs(hi - hj) == 1:
            u, v = (i, j) if hi < hj else (j, i)
            line_draw(cr, *NODES[u], *NODES[v], (l.t - start - min(hi, hj) * hop) / hop, RED, 5)
    for i, (x, y) in enumerate(NODES):
        at = start + HOP.get(i, 99) * hop + (hop if i != SRC else 0)
        got = l.t >= at
        med = i in MEDICS
        # a ring widens once when the alert lands on this phone
        k = (l.t - at) / 0.8
        if 0 < k < 1 and l.p(0, 0.04 * i) >= 1:
            cr.set_source_rgba(*(GREEN if med else RED), 0.45 * (1 - ease(k)))
            cr.set_line_width(4)
            cr.arc(x, y, 30 + 60 * ease(k), 0, 2 * math.pi)
            cr.stroke()

        def draw(med=med, got=got):
            col = GREEN if med and got else RED if got else LINE
            phone(cr, 0.55, col, col if got else None)
            if med:
                medkit(cr, 0.5)
        show(cr, l.p(0, 0.04 * i), x, y, draw, rise=20)
    x, y = NODES[SRC]
    show(cr, clamp((l.t - start) / 0.4), x, y - 72, lambda: pill(cr, "SOS", RED, 24, solid=True, fg=WHITE), rise=12)
    show(cr, l.p(0, 2.4), CX, 1110, lambda: kicker(cr, "plus de monde, plus de portée", RED, 30))


SHOT_H = 760


def sc_civil(cr, l):
    pos = ((0, "sos", CX - 205), (1, "confirm", CX + 205))
    for k, key, x in pos:
        show(cr, l.p(k), x, 730, lambda key=key: screen(cr, SHOT[key], SHOT_H))
    # taps on "APPELER UN MEDIC" then "CONFIRMER L'ALERTE", both at 91.4 % of the screen height
    dy = (0.914 - 0.5) * SHOT_H
    for k, t0 in ((0, 3.3), (1, 0.4), (1, 0.75)):  # first tap on the words "bouton rouge"
        tap(cr, pos[k][2], 730 + dy, clamp((l.t - l.b[k] - t0) / 0.6))
    show(cr, l.p(0, 0.1), CX, 300, lambda: pill(cr, "Civil", BLUE, 34))


def sc_medic(cr, l):
    show(cr, l.p(0), 350, 730, lambda: screen(cr, SHOT["route"], SHOT_H))
    show(cr, l.p(0, 0.1), CX, 300, lambda: pill(cr, "Medic", GREEN, 34))
    rx = 790

    def route():
        card(cr, 330, 150, 28)
        sans(cr, 34)
        ctext(cr, "Le chemin", 0, -22, TEXT)
        sans(cr, 28, bold=False)
        ctext(cr, "même hors-ligne", 0, 26, MUTED)
    show(cr, l.p(0, 1.4), rx, 470, route)
    show(cr, l.p(1, 0.6), rx, 640, lambda: pill(cr, "En route", ORANGE, 34))
    show(cr, l.p(1, 1.6), rx, 750, lambda: pill(cr, "Sur place", GREEN, 34))

    def seen():
        card(cr, 330, 190, 28)
        cr.save()
        cr.translate(0, -30)
        medkit(cr, 1.0)
        cr.restore()
        sans(cr, 28, bold=False)
        ctext(cr, "visible des autres", 0, 52, MUTED)
    show(cr, l.p(2, 0.3), rx, 930, seen)


def sc_before(cr, l):
    show(cr, l.p(0), CX, 420, lambda: kicker(cr, "avant la manif", RED, 34))
    for i, (off, label) in enumerate(((1.4, "Installer Brancard"), (2.8, "Télécharger la carte"))):
        def row(label=label, off=off):
            card(cr, 760, 130, 32)
            k = ease(l.p(0, off, 0.5))
            cx = -380 + 75
            cr.set_source_rgb(*mix(LINE, GREEN, k))
            cr.arc(cx, 0, 30, 0, 2 * math.pi)
            cr.fill()
            if k > 0:
                cr.move_to(cx - 13, 1)
                cr.line_to(cx - 13 + 9 * clamp(k * 2), 1 + 10 * clamp(k * 2))
                if k > 0.5:
                    q = (k - 0.5) * 2
                    cr.line_to(cx - 4 + 18 * q, 11 - 22 * q)
                cr.set_source_rgb(*WHITE)
                cr.set_line_width(6)
                cr.set_line_cap(cairo.LINE_CAP_ROUND)
                cr.set_line_join(cairo.LINE_JOIN_ROUND)
                cr.stroke()
            sans(cr, 42)
            e = cr.text_extents(label)
            cr.set_source_rgb(*TEXT)
            cr.move_to(cx + 60, -e.y_bearing - e.height / 2)
            cr.show_text(label)
        show(cr, l.p(0, off - 0.6), CX, 600 + i * 170, row)


def sc_share(cr, l):
    xs = [240, 440, 640, 840]
    y = 560
    for i, x in enumerate(xs):
        if i:
            line_draw(cr, xs[i - 1] + 50, y, x - 50, y, l.p(0, 0.1 + 0.15 * i, 0.4), RED, 6)
    for i, x in enumerate(xs):
        show(cr, l.p(0, 0.15 * i), x, y, lambda: (phone(cr, 1.0, RED, RED), medkit(cr, 0.7, RED)))
    show(cr, l.p(0, 0.6), CX, 780, lambda: title(cr, "Faites passer", 84))
    show(cr, l.p(1, 0.3), CX, 950, lambda: button(cr, "LIEN EN BIO", 520))


# (right header, scene, [(caption with *highlights*, phonetic text for the voice or None, small note or None)])
OSM = "carte © contributeurs OpenStreetMap"
HEAD = "novembre 2026"
SCRIPT = [
    (HEAD, sc_intro, [
        ("Avec l'augmentation des *blessés* dans les manifestations, j'ai décidé de créer une application.", None, None),
    ]),
    (HEAD, sc_solution, [
        ("Elle permet d'envoyer une alerte à tous les street medics autour de vous, *sans internet*.", "Elle permet d'envoyer une alerte à tous les strit médics autour de vous, sans internet.", None),
        ("Elle se connecte aux téléphones à *proximité* qui ont l'application, et l'alerte passe de l'un à l'autre.", None, None),
    ]),
    (HEAD, sc_mesh, [
        ("C'est pour ça qu'il est important de la *partager* : chaque téléphone qui l'a relaie l'alerte.", None, None),
        ("C'est ce qui permet aux medics de s'organiser et d'arriver *vite* auprès des blessés.", "C'est ce qui permet aux médics de s'organiser et d'arriver vite auprès des blessés.", None),
    ]),
    (HEAD, sc_civil, [
        ("Si vous êtes blessé, ou si quelqu'un l'est près de vous, vous appuyez sur le *bouton rouge*,", None, OSM),
        ("vous confirmez, et l'alerte part avec votre position.", None, OSM),
    ]),
    (HEAD, sc_medic, [
        ("Si vous êtes medic, vous recevez l'alerte et le *chemin* pour y aller.", "Si vous êtes médic, vous recevez l'alerte et le chemin pour y aller.", OSM),
        ("Vous voyez qui est déjà *en route*, et qui est *sur place*.", None, OSM),
        ("Et votre position s'affiche sur la carte des autres.", None, OSM),
    ]),
    (HEAD, sc_before, [
        ("Avant la manif, installez l'application et téléchargez la *carte* de votre ville.", None, None),
    ]),
    (HEAD, sc_share, [
        ("Faites passer le message.", None, None),
        ("Le lien pour la télécharger est dans la *bio*.", None, None),
        ("Et partagez cette vidéo à toutes les personnes que vous connaissez qui iront en *manif*.", None, None),
    ]),
]
END_CARD = 2.4
LEAD, GAP, RATE = 0.15, 0.12, 24000


# ---------------- timeline + voice ----------------
def build():
    tmp = tempfile.mkdtemp()
    beats, scenes, clips, t = [], [], [], 0.0
    for si, (head, fn, lines) in enumerate(SCRIPT):
        s0, starts = t, []
        t += LEAD
        for bi, (cap, say, nt) in enumerate(lines):
            spoken = say or cap.replace("*", "")
            key = hashlib.sha1(f"{VOICE_NAME}|{VOICE_RATE}|{spoken}".encode()).hexdigest()[:16]
            cache = os.path.join(HERE, ".tts_cache")
            os.makedirs(cache, exist_ok=True)
            path, js = os.path.join(cache, key + ".wav"), os.path.join(cache, key + ".json")
            if not os.path.exists(js):
                subprocess.run([tts_py, os.path.join(HERE, "tts_edge.py"), VOICE_NAME, VOICE_RATE, spoken, path, js], check=True)
            marks = json.load(open(js))
            with wave.open(path) as w:
                assert w.getframerate() == RATE and w.getsampwidth() == 2 and w.getnchannels() == 1
                pcm = array.array("h", w.readframes(w.getnframes()))
            end = len(pcm)  # drop the silence the TTS leaves after each line (keeps the pace tight)
            while end > 0 and abs(pcm[end - 1]) < 400:
                end -= 1
            pcm = pcm[:min(len(pcm), end + int(0.06 * RATE))]
            dur = len(pcm) / RATE
            clips.append((t, pcm))
            beats.append((t, t + dur + GAP, dur, cap, nt, [t + m[0] for m in marks]))
            starts.append(t - s0)
            t += dur + GAP
        t += 0.25  # breath before the cut
        scenes.append((s0, t, head, fn, starts))
    total = t + END_CARD
    track = array.array("h", bytes(2 * int((total + 0.2) * RATE)))
    for at, pcm in clips:
        o = int(at * RATE)
        track[o:o + len(pcm)] = pcm
    path = os.path.join(tmp, "voice.wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(track.tobytes())
    return scenes, beats, total, path


SCENES, BEATS, TOTAL, VOICE = build()


# ---------------- frame ----------------
FADE = 0.3  # scenes cross-fade instead of hard cuts


def background(cr):
    cr.set_source_rgb(*BG)
    cr.paint()
    # a faint red glow behind the content, like a street lit by the alert
    g = cairo.RadialGradient(CX, 700, 0, CX, 700, 900)
    g.add_color_stop_rgba(0, *RED, 0.07)
    g.add_color_stop_rgba(1, *RED, 0)
    cr.set_source(g)
    cr.paint()


def header(cr, right):
    cr.save()
    cr.translate(110, 200)
    icon_tile(cr, 72)
    cr.restore()
    sans(cr, 44)
    cr.set_source_rgb(*TEXT)
    cr.move_to(166, 216)
    cr.show_text("Brancard")
    if right:
        cr.save()
        sans(cr, 28)
        w = cr.text_extents(right).x_advance + 28 * 1.3
        cr.translate(W - 74 - w / 2, 200)
        pill(cr, right, None, 28, fg=MUTED)
        cr.restore()


def caption(cr, t):
    for t0, t1, dur, cap, nt, marks in BEATS:
        if not (t0 - 0.05 <= t < t1):
            continue
        a = ease((t - t0 + 0.05) / 0.25) * clamp((t1 - t) / 0.12)  # the line fades in, and out at its end
        words, hl, on = [], [], False
        for raw in cap.split(" "):
            on = on or raw.startswith("*")
            words.append(raw.replace("*", ""))
            hl.append(on)
            if raw.rstrip(".,:;?!").endswith("*"):
                on = False
        size, lh, maxw = 60, 1.28, 880
        sans(cr, size)
        lines, cur = [], []
        for i in range(len(words)):
            if cur and cr.text_extents(" ".join(words[j] for j in cur + [i])).x_advance > maxw:
                lines.append(cur)
                cur = [i]
            else:
                cur.append(i)
        lines.append(cur)
        real = [i for i, w in enumerate(words) if w.strip(".,:;?!")]  # a lone "?" isn't spoken
        if len(marks) == len(real):  # a word lights up when the voice says it
            reveal, k = [], -1
            for i in range(len(words)):
                k += i in real
                reveal.append(marks[max(k, 0)])
        else:  # char-proportional estimate
            total_chars = sum(len(w) + 1 for w in words)
            reveal, acc = [], 0
            for wd in words:
                reveal.append(t0 + dur * 0.92 * acc / total_chars)
                acc += len(wd) + 1
        space = cr.text_extents("a a").x_advance - cr.text_extents("aa").x_advance
        y = 1230
        cr.push_group()
        for line in lines:
            lw = sum(cr.text_extents(words[i]).x_advance for i in line) + space * (len(line) - 1)
            x = CX - lw / 2
            for i in line:
                e = cr.text_extents(words[i])
                k = smooth((t - reveal[i] + 0.04) / 0.16)  # dim -> lit, smoothly
                cr.set_source_rgb(*mix(DIM, RED if hl[i] else TEXT, k))
                cr.move_to(x, y)
                cr.show_text(words[i])
                x += e.x_advance + space
            y += size * lh
        if nt:
            sans(cr, 26, bold=False)
            cr.set_source_rgb(*MUTED)
            e = cr.text_extents(nt)
            cr.move_to((W - e.x_advance) / 2, H - 34)  # attribution sits at the very bottom
            cr.show_text(nt)
        cr.pop_group_to_source()
        cr.paint_with_alpha(a)
        return


def end_card(cr, p):
    background(cr)
    a = ease(p * 2.2)
    cr.save()
    cr.translate(W / 2, 760 + (1 - a) * 30)
    cr.push_group()
    icon_tile(cr, 200)
    cr.pop_group_to_source()
    cr.paint_with_alpha(a)
    cr.restore()
    b = ease((p - 0.12) * 2.5)
    cr.save()
    cr.translate(0, (1 - b) * 30)
    cr.push_group()
    sans(cr, 110)
    ctext(cr, "Brancard", W / 2, 990, TEXT)
    sans(cr, 34, bold=False)
    ctext(cr, "Alertes medic sans réseau", W / 2, 1075, MUTED)
    cr.save()
    cr.translate(W / 2, 1230)
    button(cr, "LIEN EN BIO", 520)
    cr.restore()
    sans(cr, 24, bold=False)
    ctext(cr, "carte © contributeurs OpenStreetMap", W / 2, H - 44, DIM)
    cr.pop_group_to_source()
    cr.paint_with_alpha(b)
    cr.restore()


def frame(i):
    t = i / FPS
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    cr = cairo.Context(surf)
    end_at = TOTAL - END_CARD
    if t >= end_at - FADE:
        end_card(cr, (t - end_at + FADE) / END_CARD)
    if t < end_at:
        cr.push_group()
        background(cr)
        header(cr, SCENES[0][2])
        for s0, s1, head, fn, starts in SCENES:
            if s0 <= t < s1:
                fade = clamp((s1 - t) / FADE) if s1 < end_at else 1.0
                cr.push_group()
                fn(cr, L(t - s0, starts))
                cr.pop_group_to_source()
                cr.paint_with_alpha(smooth(fade))
        caption(cr, t)
        cr.pop_group_to_source()
        cr.paint_with_alpha(1 - smooth((t - end_at + FADE) / FADE))
    # progress: a thin red line at the top
    cr.set_source_rgb(*RED)
    rrect(cr, 0, 0, max(6, W * t / TOTAL), 8, 4)
    cr.fill()
    surf.flush()
    return bytes(surf.get_data())


if __name__ == "__main__":
    if os.environ.get("STILLS"):  # STILLS="3.5 12 30": PNG frames to check the layout, no video
        for s in os.environ["STILLS"].split():
            fr = frame(int(float(s) * FPS))
            img = cairo.ImageSurface.create_for_data(bytearray(fr), cairo.FORMAT_ARGB32, W, H)
            img.write_to_png(f"{out}-{s}.png")
        sys.exit(0)
    n = int(TOTAL * FPS)
    ff = subprocess.Popen([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "bgra", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
        "-i", VOICE, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100", "-ac", "2",
        "-shortest", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
        "-profile:v", "high", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "128k", out,
    ], stdin=subprocess.PIPE)
    for i in range(n):
        ff.stdin.write(frame(i))
        if i % 300 == 0:
            print(f"{i}/{n}", flush=True)
    ff.stdin.close()
    sys.exit(ff.wait())
