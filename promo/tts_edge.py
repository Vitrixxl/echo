"""One line of voice-over with word timings, via edge-tts (run with a Python that has edge-tts).

Usage: python tts_edge.py VOICE RATE "text" out.wav out.json
out.json: [[start_seconds, word], ...]
"""
import asyncio
import json
import subprocess
import sys

import edge_tts

voice, rate, text, wav, js = sys.argv[1:6]


async def main():
    com = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    mp3, words = bytearray(), []
    async for chunk in com.stream():
        if chunk["type"] == "audio":
            mp3 += chunk["data"]
        elif chunk["type"] == "WordBoundary":
            words.append([chunk["offset"] / 1e7, chunk["text"]])
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "mp3", "-i", "-", "-ac", "1", "-ar", "24000",
                    "-sample_fmt", "s16", wav], input=bytes(mp3), check=True)
    json.dump(words, open(js, "w"), ensure_ascii=False)


asyncio.run(main())
