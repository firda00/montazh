"""vedit ASR sidecar: faster-whisper transcription and speaker labelling.

Run through tools/asr/.venv (see README, "Длинное видео"). Both commands read a 16 kHz mono WAV
and write one JSON file; progress goes to stderr, nothing else goes to stdout.

  transcribe --audio in.wav --out transcript.json [--model large-v3-turbo] [--language ru]
             [--device auto|cpu|cuda] [--compute int8|float16|...] [--threads N]
  speakers   --audio in.wav --phrases phrases.json --out speakers.json
             [--num-speakers N] [--threshold 0.72] [--min-seconds 0.6] [--min-cluster-seconds 10]
  selftest   checks merge_small_clusters on synthetic embeddings (numpy only, no torch/speechbrain)

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


def merge_small_clusters(labels, embs, seconds_per_phrase, min_seconds: float = 10.0, min_phrases: int = 3) -> list[int]:
    """Folds micro-clusters (laughter, interjections, a repeated name) into real speakers.

    labels: cluster id per phrase; embs: (n, d) L2-normalised embeddings in the same order;
    seconds_per_phrase: speech seconds of each phrase. While more than one cluster remains, the
    smallest cluster with < min_seconds of speech or < min_phrases phrases is merged into the
    cluster whose centroid is nearest by cosine distance. Returns labels renumbered 0..k-1 in
    order of first appearance.
    """
    import numpy as np

    X = np.asarray(embs, dtype=np.float64)
    lab = [int(l) for l in labels]
    secs = [float(x) for x in seconds_per_phrase]
    if not (len(lab) == len(X) == len(secs)):
        raise ValueError("labels, embs and seconds_per_phrase must have the same length")
    while True:
        ids = sorted(set(lab))
        if len(ids) <= 1:
            break
        total = {c: 0.0 for c in ids}
        count = {c: 0 for c in ids}
        for l, sec in zip(lab, secs):
            total[l] += sec
            count[l] += 1
        small = [c for c in ids if total[c] < min_seconds or count[c] < min_phrases]
        if not small:
            break
        victim = min(small, key=lambda c: (total[c], count[c], c))
        cents = {}
        for c in ids:
            m = X[[i for i, l in enumerate(lab) if l == c]].mean(axis=0)
            cents[c] = m / (np.linalg.norm(m) + 1e-9)
        target = min((c for c in ids if c != victim), key=lambda c: (1.0 - float(np.dot(cents[victim], cents[c])), c))
        lab = [target if l == victim else l for l in lab]
    order: dict[int, int] = {}
    for l in lab:
        order.setdefault(l, len(order))
    return [order[l] for l in lab]


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

    # a cached encoder must not wait on the Hub (unauthenticated requests can stall for minutes)
    cached = MODELS_DIR / "spkrec-ecapa-voxceleb"
    if (cached / "hyperparams.yaml").exists() and (cached / "embedding_model.ckpt").exists():
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
    from speechbrain.inference.speaker import EncoderClassifier
    from speechbrain.utils.fetching import LocalStrategy

    device = getattr(a, "device", "auto")
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    log(f"loading ECAPA speaker encoder on {device}")
    # COPY_SKIP_CACHE: files land in savedir directly; the default SYMLINK strategy needs admin rights on Windows
    enc = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir=str(MODELS_DIR / "spkrec-ecapa-voxceleb"),
        run_opts={"device": device},
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
            v = enc.encode_batch(torch.from_numpy(seg).unsqueeze(0).to(device)).squeeze().cpu().numpy()
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
        cl = [int(c) - 1 for c in cl]
        if a.min_cluster_seconds > 0 and not a.num_speakers:
            # micro-clusters (laughter, "Grok, Grok", interjections) join the nearest real speaker
            before = len(set(cl))
            cl = merge_small_clusters(cl, X, [float(phrases[i]["end"]) - float(phrases[i]["start"]) for i in valid], a.min_cluster_seconds)
            if len(set(cl)) < before:
                log(f"  merged {before - len(set(cl))} small cluster(s) (< {a.min_cluster_seconds:g} s or < 3 phrases)")
        for i, c in zip(valid, cl):
            labels[i] = c
        n_speakers = len(set(cl))

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
            "min_cluster_seconds": a.min_cluster_seconds,
            "num_speakers": n_speakers,
            "speakers": speakers,
            "phrases": out_phrases,
            "wall_seconds": round(time.time() - t0, 2),
        },
    )


# ---------------------------------------------------------------- selftest

def cmd_selftest(a: argparse.Namespace) -> None:
    """Synthetic check of merge_small_clusters: two real voices plus micro-clusters near each."""
    import numpy as np

    rng = np.random.default_rng(7)
    d = 192

    def unit(v):
        return v / np.linalg.norm(v)

    voice_a, voice_b = unit(rng.normal(size=d)), unit(rng.normal(size=d))
    near = lambda base, k: [unit(base + 0.15 * rng.normal(size=d)) for _ in range(k)]
    # A: 20 phrases x 4 s; B: 12 x 3 s; micro 2 (near A): 2 x 1.5 s; micro 3 (near B): 5 x 1 s; micro 4 (near A): 1 x 20 s
    embs = near(voice_a, 20) + near(voice_b, 12) + near(voice_a, 2) + near(voice_b, 5) + near(voice_a, 1)
    labels = [0] * 20 + [1] * 12 + [2] * 2 + [3] * 5 + [4] * 1
    secs = [4.0] * 20 + [3.0] * 12 + [1.5] * 2 + [1.0] * 5 + [20.0] * 1

    out = merge_small_clusters(labels, np.stack(embs), secs, 10.0)
    assert len(out) == len(labels)
    assert len(set(out)) == 2, f"expected 2 clusters, got {len(set(out))}: {out}"
    a_id, b_id = out[0], out[20]
    assert a_id != b_id
    assert all(x == a_id for x in out[:20]) and all(x == b_id for x in out[20:32]), "real clusters stay intact"
    assert out[32] == out[33] == a_id, "short micro-cluster near A merged into A"
    assert all(x == b_id for x in out[34:39]), "5-phrase micro-cluster under 10 s merged into B"
    assert out[39] == a_id, "a single phrase (< 3 phrases) merges even with 20 s of speech"

    # every cluster small: merging stops at one cluster, never at zero
    one = merge_small_clusters([0, 1, 2], np.stack(near(voice_a, 1) + near(voice_b, 2)), [1.0, 1.0, 1.0], 10.0)
    assert one == [0, 0, 0], one
    # nothing small: labels unchanged (renumbered by first appearance)
    same = merge_small_clusters([5] * 3 + [2] * 3, np.stack(near(voice_a, 3) + near(voice_b, 3)), [5.0] * 6, 10.0)
    assert same == [0, 0, 0, 1, 1, 1], same
    # threshold 0 disables the seconds rule but keeps the phrase-count rule
    kept = merge_small_clusters([0] * 3 + [1] * 3, np.stack(near(voice_a, 3) + near(voice_b, 3)), [0.5] * 6, 0.0)
    assert len(set(kept)) == 2, kept
    # single cluster and empty input
    assert merge_small_clusters([3], np.stack(near(voice_a, 1)), [0.2], 10.0) == [0]
    assert merge_small_clusters([], np.zeros((0, d)), [], 10.0) == []
    print("selftest ok: merge_small_clusters")


def cmd_pipeline(a: argparse.Namespace) -> None:
    """transcribe → phrases.json (raw segments) → speakers; everything lands in --out-dir for `vedit asr-import`."""
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    a.out = str(out / "faster.json")
    cmd_transcribe(a)
    with open(a.out, encoding="utf-8") as f:
        segs = json.load(f)["segments"]
    phrases = [{"start": s["start"], "end": s["end"]} for s in segs if s.get("text", "").strip()]
    with open(out / "phrases.json", "w", encoding="utf-8") as f:
        json.dump(phrases, f)
    if len(phrases) >= 2:
        a.phrases = str(out / "phrases.json")
        a.out = str(out / "speakers_raw.json")
        cmd_speakers(a)
    else:
        log("fewer than 2 phrases: speakers skipped")
    log(f"bundle ready in {out}")


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
    s.add_argument("--device", default="auto", help="auto | cpu | cuda")
    s.add_argument("--min-cluster-seconds", type=float, default=10.0, help="merge clusters with less speech (or < 3 phrases) into the nearest one; 0 = off")
    s.set_defaults(fn=cmd_speakers)

    pl = sub.add_parser("pipeline", help="transcribe + speakers into one folder (what the Colab notebook runs)")
    pl.add_argument("--audio", required=True)
    pl.add_argument("--out-dir", required=True)
    pl.add_argument("--model", default="large-v3-turbo")
    pl.add_argument("--language", default=None)
    pl.add_argument("--device", default="auto")
    pl.add_argument("--compute", default=None)
    pl.add_argument("--threads", type=int, default=0)
    pl.add_argument("--beam-size", type=int, default=5)
    pl.add_argument("--num-speakers", type=int, default=0)
    pl.add_argument("--threshold", type=float, default=0.72)
    pl.add_argument("--min-seconds", type=float, default=0.6)
    pl.add_argument("--min-cluster-seconds", type=float, default=10.0)
    pl.set_defaults(fn=cmd_pipeline)

    st = sub.add_parser("selftest")
    st.set_defaults(fn=cmd_selftest)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
