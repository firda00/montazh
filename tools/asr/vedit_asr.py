"""vedit ASR sidecar: faster-whisper transcription and speaker labelling.

Run through tools/asr/.venv (see README, "Длинное видео"). Both commands read a 16 kHz mono WAV
and write one JSON file; progress goes to stderr, nothing else goes to stdout.

  transcribe --audio in.wav --out transcript.json [--model large-v3-turbo] [--language ru]
             [--device auto|cpu|cuda] [--compute int8|float16|...] [--threads N]
  speakers   --audio in.wav --phrases phrases.json --out speakers.json
             [--num-speakers N] [--threshold 0.72] [--min-seconds 0.6]

Licences: faster-whisper (MIT), CTranslate2 (MIT), Whisper weights (MIT), SpeechBrain (Apache-2.0),
ECAPA-TDNN weights trained on VoxCeleb (speechbrain/spkrec-ecapa-voxceleb, Apache-2.0).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import wave
from pathlib import Path

# SpeechBrain fetches checkpoints with symlinks by default; on Windows that needs admin rights.
os.environ.setdefault("SB_FETCHING_STRATEGY", "COPY")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

MODELS_DIR = Path(os.environ.get("VEDIT_ASR_MODELS", Path(__file__).resolve().parent / "models"))


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def write_json(path: str, data: dict) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


# ---------------------------------------------------------------- transcribe

def cmd_transcribe(a: argparse.Namespace) -> None:
    from faster_whisper import WhisperModel

    t0 = time.time()
    device = a.device
    if device == "auto":
        try:
            import ctranslate2

            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:
            device = "cpu"
    compute = a.compute or ("float16" if device == "cuda" else "int8")
    threads = a.threads or max(4, min(16, os.cpu_count() or 4))
    log(f"faster-whisper {a.model} on {device} ({compute}, {threads} threads)")
    model = WhisperModel(a.model, device=device, compute_type=compute, cpu_threads=threads, download_root=str(MODELS_DIR))
    t_load = time.time() - t0

    # decoded here (16 kHz mono PCM from ffmpeg) instead of by faster-whisper's PyAV path, whose kwargs change between PyAV releases
    audio, rate = read_wav(a.audio)
    if rate != 16000:
        raise SystemExit(f"expected 16 kHz audio, got {rate}")
    segments_iter, info = model.transcribe(
        audio,
        language=a.language or None,
        task="transcribe",
        beam_size=a.beam_size,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
        condition_on_previous_text=False,
    )
    segments = []
    last_report = time.time()
    for s in segments_iter:
        words = [
            {"w": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3), "p": round(w.probability, 3)}
            for w in (s.words or [])
            if w.word.strip()
        ]
        segments.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip(), "words": words, "no_speech_prob": round(s.no_speech_prob, 3)})
        if time.time() - last_report > 10:
            log(f"  {s.end:7.1f}s / {info.duration:.0f}s")
            last_report = time.time()
    wall = time.time() - t0
    log(f"done: {len(segments)} segments, {info.language} (p={info.language_probability:.2f}), {wall:.0f}s wall")
    write_json(
        a.out,
        {
            "engine": "faster-whisper",
            "model": a.model,
            "device": device,
            "compute_type": compute,
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
            "duration": round(info.duration, 3),
            "segments": segments,
            "wall_seconds": round(wall, 2),
            "load_seconds": round(t_load, 2),
        },
    )


# ---------------------------------------------------------------- speakers

def read_wav(path: str):
    import numpy as np

    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise SystemExit("expected 16-bit PCM WAV")
        rate = w.getframerate()
        ch = w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return data, rate


def cmd_speakers(a: argparse.Namespace) -> None:
    import numpy as np
    import torch

    t0 = time.time()
    with open(a.phrases, encoding="utf-8") as f:
        phrases = json.load(f)
    if not isinstance(phrases, list):
        raise SystemExit("phrases must be a JSON array of {start, end}")
    audio, rate = read_wav(a.audio)
    if rate != 16000:
        raise SystemExit(f"expected 16 kHz audio, got {rate}")

    from speechbrain.inference.speaker import EncoderClassifier
    from speechbrain.utils.fetching import LocalStrategy

    log("loading ECAPA speaker encoder")
    # COPY_SKIP_CACHE: files land in savedir directly; the default SYMLINK strategy needs admin rights on Windows
    enc = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir=str(MODELS_DIR / "spkrec-ecapa-voxceleb"),
        run_opts={"device": "cpu"},
        local_strategy=LocalStrategy.COPY_SKIP_CACHE,
    )

    # one embedding per phrase; phrases shorter than --min-seconds are widened to it when possible
    embs: list = []
    valid: list[int] = []
    for i, p in enumerate(phrases):
        s, e = float(p["start"]), float(p["end"])
        if e - s < a.min_seconds:
            pad = (a.min_seconds - (e - s)) / 2
            s, e = max(0.0, s - pad), min(len(audio) / rate, e + pad)
        seg = audio[int(s * rate) : int(e * rate)]
        if len(seg) < int(0.3 * rate):
            embs.append(None)
            continue
        with torch.no_grad():
            v = enc.encode_batch(torch.from_numpy(seg).unsqueeze(0)).squeeze().cpu().numpy()
        v = v / (np.linalg.norm(v) + 1e-9)
        embs.append(v)
        valid.append(i)
        if (len(valid) % 50) == 0:
            log(f"  embeddings: {len(valid)}/{len(phrases)}")

    labels = [None] * len(phrases)
    n_speakers = 0
    if len(valid) == 1:
        labels[valid[0]] = 0
        n_speakers = 1
    elif len(valid) > 1:
        from scipy.cluster.hierarchy import fcluster, linkage

        X = np.stack([embs[i] for i in valid])
        Z = linkage(X, method="average", metric="cosine")
        if a.num_speakers:
            cl = fcluster(Z, t=a.num_speakers, criterion="maxclust")
        else:
            # cosine distance threshold: ECAPA same-speaker pairs sit well below ~0.7 on VoxCeleb
            cl = fcluster(Z, t=a.threshold, criterion="distance")
        for i, c in zip(valid, cl):
            labels[i] = int(c) - 1
        n_speakers = int(cl.max())

    # phrases without an embedding inherit the nearest labelled neighbour in time
    for i, l in enumerate(labels):
        if l is None:
            near = min((j for j in valid), key=lambda j: abs(float(phrases[j]["start"]) - float(phrases[i]["start"])), default=None)
            labels[i] = labels[near] if near is not None else 0

    # speaker ids ordered by speech time: S1 talks the most
    seconds: dict[int, float] = {}
    for p, l in zip(phrases, labels):
        seconds[l] = seconds.get(l, 0.0) + float(p["end"]) - float(p["start"])
    order = sorted(seconds, key=lambda k: -seconds[k])
    ident = {old: f"S{n + 1}" for n, old in enumerate(order)}

    # confidence: how much closer a phrase is to its own centroid than to the nearest other one
    centroids: dict[int, np.ndarray] = {}
    for l in order:
        vs = [embs[i] for i in valid if labels[i] == l]
        if vs:
            centroids[l] = np.mean(np.stack(vs), axis=0)
    out_phrases = []
    for i, (p, l) in enumerate(zip(phrases, labels)):
        conf = None
        if embs[i] is not None and l in centroids and len(centroids) > 1:
            own = float(np.dot(embs[i], centroids[l]) / (np.linalg.norm(centroids[l]) + 1e-9))
            other = max(float(np.dot(embs[i], c) / (np.linalg.norm(c) + 1e-9)) for k, c in centroids.items() if k != l)
            conf = round(max(0.0, min(1.0, 0.5 + (own - other))), 2)
        out_phrases.append({"i": i, "speaker": ident[l], **({"confidence": conf} if conf is not None else {})})

    speakers = [{"id": ident[l], "seconds": round(seconds[l], 2), "phrases": sum(1 for x in labels if x == l)} for l in order]
    log(f"done: {n_speakers} speaker(s), {time.time() - t0:.0f}s wall")
    write_json(
        a.out,
        {
            "engine": "speechbrain/spkrec-ecapa-voxceleb + agglomerative",
            "threshold": a.threshold,
            "num_speakers": n_speakers,
            "speakers": speakers,
            "phrases": out_phrases,
            "wall_seconds": round(time.time() - t0, 2),
        },
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    t = sub.add_parser("transcribe")
    t.add_argument("--audio", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--model", default="large-v3-turbo")
    t.add_argument("--language", default=None)
    t.add_argument("--device", default="auto")
    t.add_argument("--compute", default=None)
    t.add_argument("--threads", type=int, default=0)
    t.add_argument("--beam-size", type=int, default=5)
    t.set_defaults(fn=cmd_transcribe)

    s = sub.add_parser("speakers")
    s.add_argument("--audio", required=True)
    s.add_argument("--phrases", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--num-speakers", type=int, default=0)
    s.add_argument("--threshold", type=float, default=0.72)
    s.add_argument("--min-seconds", type=float, default=0.6)
    s.set_defaults(fn=cmd_speakers)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
