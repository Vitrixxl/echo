#!/usr/bin/env python
"""Word timings for a wav + its text, via faster-whisper (CPU).

usage: align.py audio.wav "text"   -> prints JSON [[start_seconds, word], ...]

Words are the whitespace-split tokens of the text; punctuation-only tokens
(":", "?", "—") are dropped. Recognised words are mapped to text words by a
character-level diff, so splits/merges ("MedicMesh" vs "Medic Mesh") still map.
"""
import difflib
import json
import sys
import unicodedata

_model = None


def words(text):
    return [w for w in text.split() if any(c.isalnum() for c in w)]


def _norm(s):
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in s if c.isalnum())


def map_times(text_words, rec):
    """rec: [(start, end, word)] from the recogniser -> [[start, text_word], ...]."""
    tc, ti = [], []  # text chars and owning text-word index
    for i, w in enumerate(text_words):
        n = _norm(w) or "_"
        tc += n
        ti += [i] * len(n)
    rc, rt = [], []  # recognised chars and their interpolated time
    for s, e, w in rec:
        n = _norm(w)
        for k in range(len(n)):
            rc.append(n[k])
            rt.append(s + (e - s) * k / len(n))
    first = [None] * len(text_words)
    sm = difflib.SequenceMatcher(None, tc, rc, autojunk=False)
    for a, b, size in sm.get_matching_blocks():
        for k in range(size):
            i = ti[a + k]
            if first[i] is None:
                first[i] = rt[b + k]
    # unmatched words: interpolate between known neighbours (or clamp to edges)
    known = [i for i, t in enumerate(first) if t is not None]
    if not known:
        return [[0.0, w] for w in text_words]
    for i, t in enumerate(first):
        if t is None:
            lo = max((k for k in known if k < i), default=None)
            hi = min((k for k in known if k > i), default=None)
            if lo is None:
                first[i] = first[hi]
            elif hi is None:
                first[i] = first[lo]
            else:
                first[i] = first[lo] + (first[hi] - first[lo]) * (i - lo) / (hi - lo)
    for i in range(1, len(first)):  # keep monotonic
        first[i] = max(first[i], first[i - 1])
    return [[round(t, 3), w] for t, w in zip(first, text_words)]


def transcribe(wav, prompt=None, language="fr"):
    """[(start, end, word)] recognised in the wav file."""
    global _model
    import sphn
    from faster_whisper import WhisperModel

    if _model is None:
        _model = WhisperModel("small", device="cpu", compute_type="int8")
    pcm, _ = sphn.read(wav, sample_rate=16000)  # numpy input avoids PyAV version issues
    segs, _ = _model.transcribe(pcm[0], language=language, word_timestamps=True,
                                initial_prompt=prompt)
    return [(w.start, w.end, w.word) for s in segs for w in s.words]


def similarity(text, rec):
    """0..1 char-level match between the text and recognised words (catches repeats/drops)."""
    return difflib.SequenceMatcher(None, _norm(text), _norm("".join(w for _, _, w in rec)),
                                   autojunk=False).ratio()


def align(wav, text, language="fr"):
    return map_times(words(text), transcribe(wav, prompt=text, language=language))


if __name__ == "__main__":
    if sys.argv[1:] == ["--test"]:
        r = map_times(words("Il existe une application pour ça : MedicMesh."),
                      [(0.0, 0.2, " Il"), (0.2, 0.5, " existe"), (0.5, 0.6, " une"),
                       (0.6, 1.2, " application"), (1.2, 1.4, " pour"), (1.4, 1.6, " ça"),
                       (1.8, 2.1, " Medic"), (2.1, 2.5, " Mesh.")])
        assert [w for _, w in r] == ["Il", "existe", "une", "application", "pour", "ça", "MedicMesh."], r
        assert r[-1][0] == 1.8 and r[3][0] == 0.6, r
        r = map_times(["a", "zzz", "b"], [(0, 1, "a"), (2, 3, "b")])
        assert r == [[0, "a"], [1.0, "zzz"], [2, "b"]], r
        print("ok")
    else:
        print(json.dumps(align(sys.argv[1], sys.argv[2]), ensure_ascii=False))
