"""Brancard TikTok explainer, "carnet" style: dotted paper, red margin, hand-drawn pieces that
build up with the voice, word-by-word captions. 1080x1920, 30 fps, cairo -> ffmpeg.

Usage: python3 -I make_video.py SHOTS_DIR OUT.mp4 TTS_PYTHON
TTS_PYTHON: a Python with edge-tts installed (runs tts_edge.py; gives word timings for the captions).
SHOTS_DIR: real app screenshots 02.png (map + SOS button), 03.png (alert sheet), 10.png (route).
Fonts: Inter + Caveat (OFL) must be installed (fontconfig).
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

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets"))
from make_icons import stretcher  # noqa: E402  (the app mark, one drawing everywhere)

W, H, FPS = 1080, 1920, 30
PAPER = (0.988, 0.986, 0.978)
DOT = (0.83, 0.83, 0.83)
MARGIN = (0.89, 0.55, 0.55)
INK = (0.07, 0.07, 0.08)
GREY = (0.78, 0.78, 0.79)
NOTE = (0.45, 0.45, 0.47)
RED = (0.85, 0.27, 0.25)
BLUE = (0.17, 0.25, 0.94)
YELLOW = (1.0, 0.85, 0.27)
GREEN = (0.16, 0.6, 0.38)
ORANGE = (0.96, 0.6, 0.12)
TAPE = (1.0, 0.88, 0.45)
WHITE = (1, 1, 1)
SANS, HAND = "Inter", "Caveat"
MX = 96  # red margin line
CX = W / 2 + MX / 2  # visual center right of the margin

shots_dir, out, tts_py = sys.argv[1:4]
VOICE_NAME, VOICE_RATE = "fr-FR-RemyMultilingualNeural", "+10%"
HERE = os.path.dirname(os.path.abspath(__file__))
SHOT = {k: cairo.ImageSurface.create_from_png(f"{shots_dir}/{k}.png") for k in ("02", "03", "10")}


# ---------------- helpers ----------------
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def back(x):  # ease-out-back: a small overshoot, the "pop"
    x = clamp(x)
    c1 = 1.9
    return 1 + (c1 + 1) * (x - 1) ** 3 + c1 * (x - 1) ** 2


def sans(cr, size):
    cr.select_font_face(SANS, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
    cr.set_font_size(size)


def hand(cr, size):
    cr.select_font_face(HAND, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
    cr.set_font_size(size)


def ctext(cr, s, x, y, color=INK):
    """Text centered on (x, y)."""
    e = cr.text_extents(s)
    cr.set_source_rgb(*color)
    cr.move_to(x - e.x_advance / 2, y - e.y_bearing - e.height / 2)
    cr.show_text(s)


def pop(cr, p, x, y, fn, angle=0.0):
    """Draw fn() around (x, y), popping in with progress p."""
    if p <= 0:
        return
    s = back(p)
    cr.save()
    cr.translate(x, y)
    cr.rotate(angle)
    cr.scale(s, s)
    cr.push_group()
    cr.new_path()  # show_text leaves a current point; without this the next arc draws a stray line
    fn()
    cr.pop_group_to_source()
    cr.paint_with_alpha(clamp(p * 2.5))
    cr.restore()


def stroke(cr, w=5, color=INK):
    cr.set_source_rgb(*color)
    cr.set_line_width(w)
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.set_line_join(cairo.LINE_JOIN_ROUND)
    cr.stroke()


def tag(cr, label, bg, fg=INK, size=38, border=True, arrow=False):
    """Cut-out label (black outline + hard shadow), centered on origin."""
    sans(cr, size)
    e = cr.text_extents(label)
    w, h = e.x_advance + size * 0.9, size * 1.55
    x, y = -w / 2, -h / 2

    def path(dx, dy):
        cr.move_to(x + dx, y + dy)
        cr.line_to(x + w + dx, y + dy)
        if arrow:
            cr.line_to(x + w + h * 0.35 + dx, dy)
        cr.line_to(x + w + dx, y + h + dy)
        cr.line_to(x + dx, y + h + dy)
        cr.close_path()

    if border:
        cr.set_source_rgb(*INK)
        path(6, 6)
        cr.fill()
    cr.set_source_rgb(*bg)
    path(0, 0)
    if border:
        cr.fill_preserve()
        cr.set_source_rgb(*INK)
        cr.set_line_width(4)
        cr.stroke()
    else:
        cr.fill()
    ctext(cr, label, 0, 0, fg)


def stamp(cr, label, color=RED, size=44):
    sans(cr, size)
    e = cr.text_extents(label)
    w, h = e.x_advance + size, size * 1.6
    cr.set_source_rgba(1, 1, 1, 0.92)
    cr.rectangle(-w / 2, -h / 2, w, h)
    cr.fill_preserve()
    cr.set_source_rgb(*color)
    cr.set_line_width(6)
    cr.stroke()
    cr.rectangle(-w / 2 + 9, -h / 2 + 9, w - 18, h - 18)
    cr.set_line_width(2)
    cr.stroke()
    ctext(cr, label, 0, 0, color)


def note(cr, s, size=50, color=INK):
    hand(cr, size)
    ctext(cr, s, 0, 0, color)


def sticky(cr, w, h):
    cr.set_source_rgba(0, 0, 0, 0.12)
    cr.rectangle(-w / 2 + 8, -h / 2 + 10, w, h)
    cr.fill()
    cr.set_source_rgb(*WHITE)
    cr.rectangle(-w / 2, -h / 2, w, h)
    cr.fill_preserve()
    cr.set_source_rgb(0.82, 0.82, 0.82)
    cr.set_line_width(2)
    cr.stroke()


def tape(cr, w, h):
    for sx, a in ((-1, -0.5), (1, 0.5)):
        cr.save()
        cr.translate(sx * (w / 2 - 20), -h / 2 + 4)
        cr.rotate(a)
        cr.set_source_rgba(*TAPE, 0.85)
        cr.rectangle(-55, -20, 110, 40)
        cr.fill()
        cr.restore()


def photo(cr, shot, h):
    sw, sh = shot.get_width(), shot.get_height()
    w = h * sw / sh
    sticky(cr, w + 28, h + 28)
    cr.save()
    cr.rectangle(-w / 2, -h / 2, w, h)
    cr.clip()
    cr.translate(-w / 2, -h / 2)
    cr.scale(w / sw, h / sh)
    cr.set_source_surface(shot, 0, 0)
    cr.get_source().set_filter(cairo.FILTER_GOOD)
    cr.paint()
    cr.restore()
    tape(cr, w + 28, h + 28)


def stick(cr, s=1.0, lying=False, color=INK, phone=False):
    """Stick figure centered on origin (~170 px tall at s=1)."""
    cr.save()
    if lying:
        cr.rotate(-math.pi / 2)
    cr.scale(s, s)
    cr.arc(0, -62, 22, 0, 2 * math.pi)
    stroke(cr, 5, color)
    cr.move_to(0, -40)
    cr.line_to(0, 25)
    cr.move_to(-30, -15)
    cr.line_to(0, -25)
    cr.line_to(30, -5 if phone else -15)
    cr.move_to(0, 25)
    cr.line_to(-22, 80)
    cr.move_to(0, 25)
    cr.line_to(22, 80)
    stroke(cr, 5, color)
    if phone:
        cr.set_source_rgb(*INK)
        cr.rectangle(26, -28, 14, 24)
        cr.fill()
    cr.restore()


def phone(cr, s=1.0, color=INK, fill=WHITE):
    w, h = 70 * s, 120 * s
    cr.set_source_rgb(*fill)
    cr.rectangle(-w / 2, -h / 2, w, h)
    cr.fill_preserve()
    stroke(cr, 5 * s, color)
    cr.move_to(-w / 6, h / 2 - 12 * s)
    cr.line_to(w / 6, h / 2 - 12 * s)
    stroke(cr, 4 * s, color)


def xmark(cr, s, color=RED, p=1.0):
    q1 = clamp(p * 2)
    cr.move_to(-s, -s)
    cr.line_to(-s + 2 * s * q1, -s + 2 * s * q1)
    if p > 0.5:
        q = (p - 0.5) * 2
        cr.move_to(s, -s)
        cr.line_to(s - 2 * s * q, -s + 2 * s * q)
    stroke(cr, 9, color)


def echo_mark(cr, s, color=WHITE):
    """The Brancard logo centered on origin, s = width. Same drawing as assets/make_icons.py."""
    stretcher(cr, 0, 0, s, color)


def medkit(cr, s=1.0, color=GREEN, cross=WHITE):
    cr.set_source_rgb(*color)
    cr.rectangle(-40 * s, -26 * s, 80 * s, 56 * s)
    cr.fill()
    cr.rectangle(-14 * s, -38 * s, 28 * s, 14 * s)
    stroke(cr, 6 * s, color)
    cr.set_source_rgb(*cross)
    cr.rectangle(-5 * s, -16 * s, 10 * s, 36 * s)
    cr.rectangle(-18 * s, -3 * s, 36 * s, 10 * s)
    cr.fill()


def checkbox(cr, label, p_check, size=50):
    """Checkbox at origin (left aligned), label on its right."""
    s = size * 0.9
    cr.rectangle(0, -s / 2, s, s)
    stroke(cr, 5)
    if p_check > 0:
        q = ease(p_check)
        cr.move_to(s * 0.18, 0)
        cr.line_to(s * 0.18 + s * 0.24 * clamp(q * 2), s * 0.28 * clamp(q * 2))
        if q > 0.5:
            r = (q - 0.5) * 2
            cr.line_to(s * 0.42 + s * 0.45 * r, s * 0.28 - s * 0.62 * r)
        stroke(cr, 7, GREEN)
    sans(cr, size * 0.8)
    cr.set_source_rgb(*INK)
    e = cr.text_extents(label)
    cr.move_to(s + 26, -e.y_bearing - e.height / 2)
    cr.show_text(label)


def arrow(cr, x1, y1, x2, y2, p, color=INK, w=5):
    if p <= 0:
        return
    q = ease(p)
    x, y = x1 + (x2 - x1) * q, y1 + (y2 - y1) * q
    cr.move_to(x1, y1)
    cr.line_to(x, y)
    a = math.atan2(y2 - y1, x2 - x1)
    if q > 0.85:
        for d in (2.6, -2.6):
            cr.move_to(x, y)
            cr.line_to(x + 22 * math.cos(a + d), y + 22 * math.sin(a + d))
    stroke(cr, w, color)


def tap(cr, x, y, p):
    if 0 < p < 1:
        cr.set_source_rgba(*BLUE, 0.35 * (1 - p))
        cr.arc(x, y, 26 + 60 * ease(p), 0, 2 * math.pi)
        cr.fill()
        cr.set_source_rgba(*BLUE, 0.8 * (1 - p))
        cr.arc(x, y, 22, 0, 2 * math.pi)
        cr.fill()


# ---------------- scenes ----------------
class L:
    """Scene clock: t = local time, b[k] = local start of beat k, p() = appear progress."""

    def __init__(self, t, b):
        self.t, self.b = t, b

    def p(self, k, off=0.0, dur=0.35):
        return clamp((self.t - self.b[k] - off) / dur)


def sc_intro(cr, l):
    def card():
        sticky(cr, 560, 220)
        tape(cr, 560, 220)
        cr.save()
        cr.translate(-185, 0)
        cr.set_source_rgb(*RED)
        cr.rectangle(-62, -62, 124, 124)
        cr.fill()
        echo_mark(cr, 112)
        cr.restore()
        sans(cr, 80)
        cr.set_source_rgb(*INK)
        cr.move_to(-60, 29)
        cr.show_text("Brancard")

    # injured people first, then the app
    for i, x in enumerate((300, 560, 820)):
        pop(cr, l.p(0, 0.3 + 0.35 * i), x, 450, lambda: stick(cr, 0.9, lying=True))
        pop(cr, l.p(0, 0.5 + 0.35 * i), x, 330, lambda: tag(cr, "!", RED, WHITE, 44))
    pop(cr, l.p(0, 0.8), CX, 620, lambda: note(cr, "de plus en plus de blessés", 60, RED), -0.03)
    pop(cr, l.p(0, 3.0), CX, 900, card, -0.03)


def sc_solution(cr, l):
    xs = [250, 445, 640, 835]
    for i, x in enumerate(xs):
        pop(cr, l.p(1, 0.2 + 0.4 * i), x, 560, lambda i=i: phone(cr, 1.0, RED if i == 0 else INK))
        if i:
            arrow(cr, xs[i - 1] + 50, 560, x - 50, 560, l.p(1, 0.1 + 0.4 * i, 0.4), RED, 6)
    pop(cr, l.p(1, 0.2), 250, 455, lambda: tag(cr, "SOS", RED, WHITE, 30, border=False))
    pop(cr, l.p(0, 0.3), CX, 820, lambda: (tag(cr, "INTERNET", WHITE, INK, 44), xmark(cr, 50, RED, l.p(0, 0.6, 0.4))), -0.04)
    pop(cr, l.p(1, 2.4), CX, 960, lambda: note(cr, "les téléphones à proximité", 56, BLUE), 0.02)


random.seed(11)
NODES = []
while len(NODES) < 15:
    q = (random.uniform(210, 960), random.uniform(380, 1020))
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
    for i, j in EDGES:
        if l.p(0, 0.04 * min(i, j)) <= 0:
            continue
        cr.move_to(*NODES[i])
        cr.line_to(*NODES[j])
        stroke(cr, 3, GREY)
        hi, hj = HOP.get(i, 99), HOP.get(j, 99)
        if abs(hi - hj) == 1:
            u, v = (i, j) if hi < hj else (j, i)
            q = ease(clamp((l.t - start - min(hi, hj) * hop) / hop))
            if q > 0:
                cr.move_to(*NODES[u])
                cr.line_to(NODES[u][0] + (NODES[v][0] - NODES[u][0]) * q, NODES[u][1] + (NODES[v][1] - NODES[u][1]) * q)
                stroke(cr, 6, RED)
    for i, (x, y) in enumerate(NODES):
        got = l.t >= start + HOP.get(i, 99) * hop + (hop if i != SRC else 0)
        med = i in MEDICS
        fill = (0.86, 0.95, 0.89) if med and got else (1, 0.88, 0.87) if got else WHITE

        def draw(med=med, got=got, fill=fill):
            phone(cr, 0.6, GREEN if med else (RED if got else INK), fill)
            if med:
                medkit(cr, 0.33)

        pop(cr, l.p(0, 0.04 * i), x, y, draw)
    x, y = NODES[SRC]
    pop(cr, clamp((l.t - start) / 0.35), x, y - 70, lambda: tag(cr, "SOS", RED, WHITE, 28, border=False))
    pop(cr, l.p(0, 2.4), CX, 1095, lambda: note(cr, "+ de monde = + de portée", 56, RED), 0.02)


SHOTS_POS = ((0, "02", 330, 700, -0.05), (1, "03", 750, 700, 0.05))
PHOTO_H = 600


def sc_civil(cr, l):
    for k, key, x, y, a in SHOTS_POS:
        pop(cr, l.p(k), x, y, lambda key=key: photo(cr, SHOT[key], PHOTO_H), a)
    # taps on the SOS button (shot 02) then the confirm button (shot 03), both at 91.7 % of the height
    for k, t0 in ((0, 3.3), (1, 0.4), (1, 0.75)):  # first tap on the words "bouton rouge"
        _, _, x, y, a = SHOTS_POS[k]
        dy = (0.917 - 0.5) * PHOTO_H
        tap(cr, x - math.sin(a) * dy, y + math.cos(a) * dy, clamp((l.t - l.b[k] - t0) / 0.6))
    pop(cr, l.p(0, 0.1), CX, 315, lambda: tag(cr, "CIVIL", BLUE, WHITE, 40, border=False), -0.03)
    pop(cr, l.p(1, 1.2), CX, 1075, lambda: note(cr, "l'alerte part avec ta position", 52, RED), -0.02)


def sc_medic(cr, l):
    pop(cr, l.p(0), 380, 720, lambda: photo(cr, SHOT["10"], 660), -0.04)
    pop(cr, l.p(0, 0.1), CX, 315, lambda: tag(cr, "MEDIC", GREEN, WHITE, 40, border=False), 0.03)
    pop(cr, l.p(0, 1.4), 790, 420, lambda: note(cr, "le chemin,", 54, BLUE), 0.04)
    pop(cr, l.p(0, 1.7), 790, 480, lambda: note(cr, "même hors-ligne", 54, BLUE), 0.04)
    pop(cr, l.p(1, 0.6), 790, 640, lambda: tag(cr, "EN ROUTE", ORANGE, INK, 38), -0.05)
    pop(cr, l.p(1, 1.6), 790, 760, lambda: tag(cr, "SUR PLACE", GREEN, WHITE, 38), 0.04)
    pop(cr, l.p(2, 0.3), 790, 920, lambda: (medkit(cr, 1.2), cr.translate(0, 95), note(cr, "visible des autres", 46, GREEN)), 0.02)


def sc_before(cr, l):
    pop(cr, l.p(0), CX, 410, lambda: note(cr, "avant la manif :", 76, INK), -0.03)
    for i, (off, label) in enumerate(((1.4, "installer Brancard"), (2.8, "télécharger la carte"))):
        pop(cr, l.p(0, off - 0.6), 190, 590 + i * 140, lambda label=label, off=off: checkbox(cr, label, l.p(0, off, 0.5)))


def sc_share(cr, l):
    xs = [250, 445, 640, 835]
    for i, x in enumerate(xs):
        pop(cr, l.p(0, 0.15 * i), x, 560, lambda: (phone(cr, 1.0), medkit(cr, 0.55, RED)))
        if i:
            arrow(cr, xs[i - 1] + 50, 560, x - 50, 560, l.p(0, 0.1 + 0.15 * i, 0.3), RED, 6)
    pop(cr, l.p(0, 0.6), CX, 780, lambda: note(cr, "faites passer", 80, RED), -0.03)
    pop(cr, l.p(1, 0.3), CX, 960, lambda: tag(cr, "LIEN EN BIO", YELLOW, INK, 46, arrow=True), 0.03)


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
def paper(cr):
    cr.set_source_rgb(*PAPER)
    cr.paint()
    cr.set_source_rgb(*DOT)
    for y in range(24, H, 44):
        for x in range(24, W, 44):
            cr.rectangle(x, y, 3, 3)
    cr.fill()
    cr.set_source_rgb(*MARGIN)
    cr.rectangle(MX, 0, 3, H)
    cr.fill()


def header(cr, right):
    hand(cr, 58)
    cr.set_source_rgb(*RED)
    cr.move_to(MX + 44, 228)
    cr.show_text("brancard")
    if right:
        sans(cr, 40)
        e = cr.text_extents(right)
        cr.move_to(W - 70 - e.x_advance, 226)
        cr.show_text(right)


def caption(cr, t):
    for t0, t1, dur, cap, nt, marks in BEATS:
        if not (t0 - 0.05 <= t < t1):
            continue
        words, hl, on = [], [], False
        for raw in cap.split(" "):
            on = on or raw.startswith("*")
            words.append(raw.replace("*", ""))
            hl.append(on)
            if raw.rstrip(".,:;?!").endswith("*"):
                on = False
        size, lh, maxw = 62, 1.25, 880
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
        if len(marks) == len(real):  # a word turns black when the voice says it
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
        y = 1215
        for line in lines:
            lw = sum(cr.text_extents(words[i]).x_advance for i in line) + space * (len(line) - 1)
            x = CX - lw / 2
            for i in line:
                e = cr.text_extents(words[i])
                said = t >= reveal[i]
                if hl[i] and said:
                    cr.set_source_rgb(*YELLOW)
                    cr.rectangle(x - 8, y - size * 0.86, e.x_advance + 16 + (space if i + 1 in line and hl[i + 1] else 0), size * 1.12)
                    cr.fill()
                cr.set_source_rgb(*(INK if said else GREY))
                cr.move_to(x, y)
                cr.show_text(words[i])
                x += e.x_advance + space
            y += size * lh
        if nt:
            sans(cr, 28)
            cr.set_source_rgb(*NOTE)
            e = cr.text_extents(nt)
            cr.move_to((W - e.x_advance) / 2, H - 34)  # attribution sits at the very bottom
            cr.show_text(nt)
        return


def end_card(cr, p):
    cr.set_source_rgb(*BLUE)
    cr.paint()
    a = ease(p * 2.5)
    cr.save()
    cr.translate(W / 2, 760)
    cr.scale(0.85 + 0.15 * a, 0.85 + 0.15 * a)
    cr.set_source_rgba(1, 1, 1, a)
    cr.rectangle(-90, -90, 180, 180)
    cr.fill()
    cr.push_group()
    echo_mark(cr, 150, RED)
    cr.pop_group_to_source()
    cr.paint_with_alpha(a)
    cr.restore()
    cr.push_group()
    sans(cr, 104)
    ctext(cr, "Brancard", W / 2, 990, WHITE)
    hand(cr, 70)
    ctext(cr, "lien en bio", W / 2, 1110, YELLOW)
    sans(cr, 26)
    ctext(cr, "carte © contributeurs OpenStreetMap", W / 2, H - 44, (0.8, 0.83, 1))
    cr.pop_group_to_source()
    cr.paint_with_alpha(ease((p - 0.1) * 3))


def frame(i):
    t = i / FPS
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    cr = cairo.Context(surf)
    end_at = TOTAL - END_CARD
    if t >= end_at:
        end_card(cr, (t - end_at) / END_CARD)
    else:
        paper(cr)
        for s0, s1, head, fn, starts in SCENES:
            if s0 <= t < s1:  # hard cuts between scenes, like turning a notebook page
                header(cr, head)
                cr.save()
                fn(cr, L(t - s0, starts))
                cr.restore()
        caption(cr, t)
    cr.set_source_rgb(*BLUE if t < end_at else WHITE)
    cr.rectangle(0, 0, W * t / TOTAL, 12)
    cr.fill()
    surf.flush()
    return bytes(surf.get_data())


if __name__ == "__main__":
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
