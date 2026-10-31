#!/usr/bin/env python
"""French voice-over: text -> 24 kHz mono 16-bit wav + word timings JSON.

  .venv-kyutai/bin/python     say.py --engine kyutai     --voice fr-2114 --speed 1.0 "text" out.wav out.json
  .venv-chatterbox/bin/python say.py --engine chatterbox --voice fr-2114 --speed 1.15 "text" out.wav out.json

Several "text out.wav out.json" triples may follow, so the model loads once.
JSON is [[start_seconds, word], ...] over the whitespace-split words of the
original text (punctuation-only tokens dropped). Kyutai gives native word
timestamps; chatterbox is aligned with faster-whisper (align.py).
--voice: an alias below or any wav path inside the HF repo kyutai/tts-voices.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from align import map_times, transcribe, words  # noqa: E402

SR = 24000
VOICE_REPO = "kyutai/tts-voices"
# French male voices from CML-TTS (CC-BY-4.0, https://openslr.org/146/), via kyutai/tts-voices
VOICES = {
    "fr-2114": "cml-tts/fr/2114_1656_000053-0001_enhanced.wav",
    "fr-4193": "cml-tts/fr/4193_3103_000004-0001_enhanced.wav",
    "fr-7601": "cml-tts/fr/7601_7727_000062-0001_enhanced.wav",
    "fr-9834": "cml-tts/fr/9834_9697_000150-0003_enhanced.wav",
    "fr-5476": "cml-tts/fr/5476_3103_000072-0001_enhanced.wav",
    "fr-1770": "cml-tts/fr/1770_1028_000036-0002_enhanced.wav",
    "fr-577": "cml-tts/fr/577_394_000070-0001_enhanced.wav",
    "fr-928": "cml-tts/fr/928_486_000075-0001_enhanced.wav",
}
# Spelling sent to the model for a caption word (case-insensitive, trailing punctuation kept).
RESPELL = {
    "medicmesh": "Médic Mèche",
}


def groups(text, plu=False):
    """[(caption_word, spoken_text)] -- one entry per caption word.
    plu: respell "plus" -> "plu" before another word (chatterbox says "pluss"; kyutai gets it right)."""
    out = []
    toks = text.split()
    for i, tok in enumerate(toks):
        if not any(c.isalnum() for c in tok):  # standalone ":" etc -> short pause on previous word
            if out:
                out[-1] = (out[-1][0], out[-1][1] + ",")
            continue
        m = re.fullmatch(r"(\W*)(.*?)(\W*)", tok)
        pre, core, post = m.groups()
        say = RESPELL.get(core.lower(), core)
        if plu and core.lower() == "plus" and i + 1 < len(toks) and not post:
            say = core[:-1]
        out.append((tok, pre + say + post))
    assert [w for w, _ in out] == words(text)
    return out


def trim(pcm, db=-40, pre=0.03, post=0.08):
    """Cut leading/trailing silence; returns (pcm, offset_seconds)."""
    hop = SR // 100
    rms = np.sqrt(np.mean(pcm[: len(pcm) // hop * hop].reshape(-1, hop) ** 2, axis=1) + 1e-12)
    loud = np.nonzero(rms > rms.max() * 10 ** (db / 20))[0]
    a = max(0, loud[0] * hop - int(pre * SR))
    b = min(len(pcm), (loud[-1] + 1) * hop + int(post * SR))
    return pcm[a:b], a / SR


def finish(pcm, times, text, speed, out_wav, out_json):
    """pcm float32 @24k, times = [seconds into pcm for each caption word]."""
    pcm, t0 = trim(np.asarray(pcm, dtype=np.float32))
    pcm = pcm / max(1.0, np.abs(pcm).max() / 0.97)
    with tempfile.NamedTemporaryFile(suffix=".f32") as f:
        pcm.tofile(f.name)
        af = f"atempo={speed}" if abs(speed - 1) > 1e-3 else "anull"  # atempo keeps pitch
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1",
                        "-i", f.name, "-af", af, "-ar", str(SR), "-ac", "1", "-c:a", "pcm_s16le",
                        out_wav], check=True)
    res = [[round(max(0.0, (t - t0) / speed), 3), w] for t, w in zip(times, words(text))]
    with open(out_json, "w") as f:
        json.dump(res, f, ensure_ascii=False)
    return res


def kyutai(jobs, voice, speed, pb):
    import torch
    from moshi.models.loaders import CheckpointInfo
    from moshi.models.tts import TTSModel

    tts = TTSModel.from_checkpoint_info(CheckpointInfo.from_hf_repo("kyutai/tts-1.6b-en_fr"),
                                        n_q=32, temp=0.6, device="cuda")
    cond = tts.make_condition_attributes([tts.get_voice_path(voice)], cfg_coef=2.0)
    for text, out_wav, out_json in jobs:
        t = time.time()
        g = groups(text)
        entries = tts.prepare_script([" ".join(s for _, s in g)], padding_between=pb)
        r = tts.generate([entries], [cond])
        with tts.mimi.streaming(1), torch.no_grad():
            frames = r.frames[tts.delay_steps:]
            pcm = np.concatenate([tts.mimi.decode(f[:, 1:, :]).float().cpu().numpy()[0, 0] for f in frames])
        pcm = np.clip(pcm, -1, 1)
        # native word timestamps: one transcript item per spoken word, step / 12.5 Hz
        steps = [s for _, s in r.all_transcripts[0]]
        counts = [len(re.sub(r"[:()]", " ", s).split()) for _, s in g]
        if len(steps) == sum(counts):
            idx = np.cumsum([0] + counts[:-1])
            times = [steps[i] / tts.mimi.frame_rate for i in idx]
        else:  # word mismatch: fall back to whisper
            times = whisper_times(pcm, text)[0]
        print(f"[kyutai] {time.time() - t:.1f}s  {out_wav}", file=sys.stderr)
        finish(pcm, times, text, speed, out_wav, out_json)


def chatterbox(jobs, voice, speed, exaggeration=0.5, cfg_weight=0.5):
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    model = ChatterboxMultilingualTTS.from_pretrained(device="cuda")
    for text, out_wav, out_json in jobs:
        t = time.time()
        spoken = " ".join(s for _, s in groups(text, plu=True))
        wav = model.generate(spoken, language_id="fr", audio_prompt_path=voice,
                             exaggeration=exaggeration, cfg_weight=cfg_weight)
        assert model.sr == SR, model.sr
        pcm, _ = trim(wav.squeeze(0).cpu().numpy())
        times, end = whisper_times(pcm, text)
        # chatterbox often babbles/repeats after the last word: cut 0.2 s after it, 30 ms fade
        pcm = pcm[: int((end + 0.2) * SR)].copy()
        pcm[-720:] *= np.linspace(1, 0, len(pcm[-720:]))
        print(f"[chatterbox] {time.time() - t:.1f}s  {out_wav}", file=sys.stderr)
        finish(pcm, times, text, speed, out_wav, out_json)


def whisper_times(pcm, text):
    """(start seconds per caption word, end of last recognised word) via faster-whisper."""
    import sphn
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        sphn.write_wav(f.name, pcm, SR)
        rec = transcribe(f.name, prompt=text)
    return [t for t, _ in map_times(words(text), rec)], (rec[-1][1] if rec else len(pcm) / SR)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--engine", required=True, choices=["kyutai", "chatterbox"])
    p.add_argument("--voice", default="fr-2114")
    p.add_argument("--speed", type=float, default=1.0, help="tempo factor, pitch preserved")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--pb", type=int, default=0, help="kyutai padding_between (1 = slower, more articulated)")
    p.add_argument("--exaggeration", type=float, default=0.5, help="chatterbox")
    p.add_argument("--cfg-weight", type=float, default=0.5, help="chatterbox")
    p.add_argument("triples", nargs="+", help='"text" out.wav out.json [...]')
    a = p.parse_args()
    if len(a.triples) % 3:
        p.error("arguments must be triples: text out.wav out.json")
    jobs = [a.triples[i:i + 3] for i in range(0, len(a.triples), 3)]
    for _, w, j in jobs:
        for f in (w, j):
            os.makedirs(os.path.dirname(os.path.abspath(f)), exist_ok=True)

    import torch
    torch.manual_seed(a.seed)
    voice = VOICES.get(a.voice, a.voice)
    t = time.time()
    if a.engine == "kyutai":
        kyutai(jobs, voice, a.speed, a.pb)
    else:
        from huggingface_hub import hf_hub_download
        ref = voice if os.path.exists(voice) else hf_hub_download(VOICE_REPO, voice)
        chatterbox(jobs, ref, a.speed, a.exaggeration, a.cfg_weight)
    print(f"total {time.time() - t:.1f}s, peak VRAM {torch.cuda.max_memory_allocated() / 2**30:.2f} GiB",
          file=sys.stderr)


if __name__ == "__main__":
    main()
