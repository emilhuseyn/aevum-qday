"""Builds the demo video from the recorded footage (record.ts) and a synthetic English narration (edge-tts).

Usage:  py build_video.py
Reads narration.json, out/slides/<id>.jpg and out/frames/<id>/ (frames + timeline.json).
Writes out/payeeguard-demo.mp4, out/captions.srt and out/timings.txt. Needs network (edge-tts), ffmpeg and ffprobe.

Footage keeps its real order and speed, except that a still screen (no repaint, e.g. while a transaction confirms)
is shortened to at most GAP_CAP seconds, and footage longer than its narration plays up to MAX_SPEED times faster.
A scene lasts as long as its footage or its narration, whichever is longer.
"""
import asyncio
import json
import pathlib
import re
import subprocess

import edge_tts

HERE = pathlib.Path(__file__).parent
OUT = HERE / "out"
WORK = OUT / "tts"
FINAL = OUT / "payeeguard-demo.mp4"
LEAD, TAIL = 0.5, 0.8
GAP_CAP = 1.6
MAX_SPEED = 2.0
WORDS_PER_CAPTION = 13


def probe(path):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                          "-of", "csv=p=0", str(path)]).decode().strip())


def srt_time(t):
    ms = round(t * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def sentences(text):
    return [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]


async def synth(voice, scene_id, text):
    mp3 = WORK / f"{scene_id}.mp3"
    bounds = []
    comm = edge_tts.Communicate(text, voice, boundary="SentenceBoundary")
    with open(mp3, "wb") as f:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "SentenceBoundary":
                bounds.append((chunk["offset"] / 1e7, chunk["duration"] / 1e7, chunk["text"]))
    return mp3, bounds


async def narrate(voice, scene):
    cache = WORK / f"{scene['id']}.json"
    if cache.exists():
        c = json.loads(cache.read_text(encoding="utf-8"))
        if c["say"] == scene["say"] and c["voice"] == voice and (WORK / f"{scene['id']}.mp3").exists():
            return WORK / f"{scene['id']}.mp3", [tuple(b) for b in c["bounds"]]
    for attempt in range(1, 7):
        try:
            mp3, bounds = await synth(voice, scene["id"], scene["say"])
            cache.write_text(json.dumps({"say": scene["say"], "voice": voice, "bounds": bounds}), encoding="utf-8")
            await asyncio.sleep(3)
            return mp3, bounds
        except edge_tts.exceptions.NoAudioReceived:
            print(f"{scene['id']}: no audio on attempt {attempt}, retrying")
            await asyncio.sleep(6)
    raise SystemExit(f"{scene['id']}: edge-tts returned no audio six times")


def footage(scene_id):
    """(frame paths, per-frame durations) for a slide or a recorded clip."""
    slide = OUT / "slides" / f"{scene_id}.jpg"
    if slide.exists():
        return [slide], [0.0]
    d = OUT / "frames" / scene_id
    tl = json.loads((d / "timeline.json").read_text(encoding="utf-8"))
    frames = tl["frames"]
    times = [f["t"] for f in frames] + [tl["end"]]
    durs = [min(max(times[i + 1] - times[i], 1 / 30), GAP_CAP) for i in range(len(frames))]
    return [d / f["file"] for f in frames], durs


def caption_cues(start, bounds, show_text):
    shown = sentences(show_text)
    texts = shown if len(shown) == len(bounds) else [b[2] for b in bounds]
    cues = []
    for (off, dur, _), text in zip(bounds, texts):
        words = text.split()
        chunks = [" ".join(words[i:i + WORDS_PER_CAPTION]) for i in range(0, len(words), WORDS_PER_CAPTION)]
        if len(chunks) > 1 and len(chunks[-1].split()) < 4:
            last = chunks.pop()
            chunks[-1] += " " + last
        total = sum(len(c) for c in chunks)
        t = start + LEAD + off
        for c in chunks:
            span = dur * len(c) / total
            cues.append((t, t + span + 0.15, c))
            t += span
    return cues


async def main():
    spec = json.loads((HERE / "narration.json").read_text(encoding="utf-8"))
    WORK.mkdir(parents=True, exist_ok=True)
    scenes = spec["scenes"]

    voiced = []
    for s in scenes:
        voiced.append(await narrate(spec["voice"], s))

    concat, cues, rows, wavs = [], [], [], []
    t = 0.0
    for s, (mp3, bounds) in zip(scenes, voiced):
        audio = probe(mp3)
        files, durs = footage(s["id"])
        clip = sum(durs)
        target = LEAD + audio + TAIL
        speed = min(MAX_SPEED, clip / target) if clip > target else 1.0
        durs = [d / speed for d in durs]
        clip = sum(durs)
        length = max(clip, target)
        durs[-1] += length - clip
        for f, d in zip(files, durs):
            concat += [f"file '{f.as_posix()}'", f"duration {d:.4f}"]
        cues += caption_cues(t, bounds, s["show"])
        wav = WORK / f"{s['id']}.wav"
        subprocess.run(["ffmpeg", "-y", "-i", str(mp3), "-af", f"adelay={int(LEAD * 1000)}:all=1,apad=whole_dur={length:.3f}",
                        "-ar", "44100", "-ac", "1", str(wav)], check=True, capture_output=True)
        wavs.append(wav)
        rows.append(f"{s['id']:<18} {t:7.2f}-{t + length:7.2f}s  footage {clip:6.2f}s (x{speed:.2f})  voice {audio:6.2f}s")
        t += length
    total = t
    concat.append(concat[-2])

    (OUT / "frames.txt").write_text("\n".join(concat) + "\n", encoding="utf-8")
    (WORK / "audio.txt").write_text("".join(f"file '{w.name}'\n" for w in wavs), encoding="utf-8")
    subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", "audio.txt", "-c", "copy", "audio.wav"],
                   cwd=WORK, check=True, capture_output=True)
    srt = "".join(f"{n}\n{srt_time(a)} --> {srt_time(b)}\n{text}\n\n" for n, (a, b, text) in enumerate(cues, 1))
    (OUT / "captions.srt").write_text(srt, encoding="utf-8")

    style = ("FontName=Segoe UI Semibold,FontSize=10,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,"
             "BackColour=&HA0000000,BorderStyle=3,Outline=4,Shadow=0,MarginV=14,MarginL=60,MarginR=60,Alignment=2")
    vf = ("scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0f172a,"
          f"fps=30,format=yuv420p,subtitles=captions.srt:force_style='{style}'")
    # Footage frames (1280x720) and slides (1920x1080) differ in size; without -reinit_filter 0 the filter graph is
    # rebuilt at each switch and the frame timing drifts.
    subprocess.run(["ffmpeg", "-y", "-reinit_filter", "0", "-f", "concat", "-safe", "0", "-i", "frames.txt", "-i", "tts/audio.wav",
                    "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "160k",
                    "-t", f"{total:.3f}", "-movflags", "+faststart", FINAL.name],
                   cwd=OUT, check=True, capture_output=True)
    rows.append(f"total {total:.2f}s")
    (OUT / "timings.txt").write_text("\n".join(rows) + "\n", encoding="utf-8")
    print("\n".join(rows))


if __name__ == "__main__":
    asyncio.run(main())
