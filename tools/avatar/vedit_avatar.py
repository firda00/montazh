"""vedit avatar sidecar: script -> speech (Chatterbox Multilingual) -> talking head (JoyVASA + LivePortrait).

Runs on Google Colab T4 (tools/avatar/colab_vedit_avatar.ipynb) or locally on CPU for a smoke test.
TTS and animation need different Python stacks (chatterbox-tts pins transformers 5.2, JoyVASA needs 4.39),
so each stage runs in its own venv; `pipeline` drives them as subprocesses. This file imports only the
standard library at module level, so any Python can run `pipeline`, `finalize` and `selftest`.

  tts       --job DIR --out-dir OUT [--device cuda] [--exaggeration 0.5] [--cfg-weight 0.4] [--fake]
            script.json lines -> one WAV per sentence -> speech.wav (24 kHz) + speech_16k.wav + timings.json.
            A bundle with `speech` (the user's own recording) skips TTS: the recording is converted instead.
  animate   --job DIR --out-dir OUT --joyvasa DIR [--device cuda] [--cfg-scale 2.0] [--max-chunk-seconds 20] [--fake]
            portrait + speech_16k.wav -> avatar_silent.mp4 (25 fps), in chunks cut at pauses when the speech is long
  finalize  --job DIR --out-dir OUT [--fps 25] -> avatar.mp4 (H.264 + AAC), meta.json, avatar_result.zip
  pipeline  --job ZIP|DIR --out-dir OUT [--tts-python P] [--joy-python P] [--joyvasa DIR] [--mode avatar|voice_only]
            all three stages; a stage whose inputs did not change is skipped (re-run safe)
  selftest  fakes TTS and animation with generated audio and ffmpeg video; checks chunking, concat, mux, zip
            (needs only Python + ffmpeg)

Bundle (avatar_job.zip, made by `vedit avatar export`): script.json {version, job, language, lines[],
voice_ref?, speech?, portrait, mode, tts{}, animate{}}, portrait.png, optional voice_ref.wav / speech_in.wav,
and a copy of this file.

Licences: Chatterbox (MIT; output carries Resemble's imperceptible Perth watermark), JoyVASA (MIT),
LivePortrait code and weights (MIT), chinese-hubert-base (MIT). InsightFace buffalo_l detection models used
by LivePortrait's cropper are for NON-COMMERCIAL research only — replace them (e.g. MediaPipe face
detection) before a commercial launch.
"""

from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import wave
import zipfile
from pathlib import Path

TTS_RATE = 24000  # Chatterbox S3Gen output rate
ANIM_RATE = 16000  # JoyVASA / hubert input rate
ANIM_FPS = 25  # JoyVASA motion generator frame rate
CHATTERBOX_FILES = ["ve.pt", "t3_mtl23ls_v2.safetensors", "s3gen.pt", "grapheme_mtl_merged_expanded_v1.json", "conds.pt", "Cangjie5_TC.json"]
CHATTERBOX_LANGS = {"ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh"}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def read_json(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()[:16]


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)
    if r.returncode != 0:
        tail = "\n".join((r.stderr or r.stdout or "").strip().splitlines()[-12:])
        raise RuntimeError(f"{Path(cmd[0]).name} exited with {r.returncode}:\n{tail}")
    return r


def ffmpeg(*args: str) -> None:
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args])


def probe(path: Path) -> dict:
    r = run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)])
    return json.loads(r.stdout)


def media_duration(path: Path) -> float:
    return float(probe(path)["format"].get("duration") or 0)


# ---------------------------------------------------------------- script

def load_script(job: Path) -> dict:
    f = job / "script.json"
    if not f.exists():
        raise SystemExit(f"нет {f}: распакуйте avatar_job.zip (vedit avatar export)")
    s = read_json(f)
    lines = [str(x).strip() for x in s.get("lines", []) if str(x).strip()]
    if not lines and not s.get("speech"):
        raise SystemExit("script.json: нет ни строк текста (lines), ни своей записи речи (speech)")
    s["lines"] = lines
    s.setdefault("language", "ru")
    s.setdefault("mode", "avatar")
    s.setdefault("tts", {})
    s.setdefault("animate", {})
    return s


def script_hash(job: Path, s: dict) -> str:
    """What the speech depends on: text, language, voice settings and the reference/provided audio."""
    h = hashlib.sha256(json.dumps({k: s.get(k) for k in ("language", "lines", "voice_ref", "speech", "tts", "fake")}, sort_keys=True, ensure_ascii=False).encode())
    for key in ("voice_ref", "speech"):
        if s.get(key) and (job / s[key]).exists():
            h.update(sha_file(job / s[key]).encode())
    return h.hexdigest()[:16]


_SENT = re.compile(r"(?<=[.!?…])[\"»”)]*\s+")


def split_sentences(text: str, max_chars: int = 220) -> list[str]:
    """Sentences of a line; a sentence longer than max_chars is cut at commas/dashes, then at spaces.
    Chatterbox generates at most ~40 s per call and gets less stable on long inputs."""
    out: list[str] = []
    for sent in (p.strip() for p in _SENT.split(text.strip())):
        if not sent:
            continue
        while len(sent) > max_chars:
            window = sent[: max_chars + 1]
            cut = max(window.rfind(", "), window.rfind("; "), window.rfind(" — "), window.rfind(": "))
            if cut < max_chars // 3:
                cut = window.rfind(" ")
            if cut <= 0:
                cut = max_chars
            out.append(sent[: cut + 1].strip())
            sent = sent[cut + 1 :].strip()
        if sent:
            out.append(sent)
    return out


# ---------------------------------------------------------------- PCM helpers (stdlib only)

def read_pcm(path: Path) -> tuple[array.array, int]:
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError(f"{path}: ожидается 16-bit mono WAV")
        rate = w.getframerate()
        data = array.array("h")
        data.frombytes(w.readframes(w.getnframes()))
    if sys.byteorder == "big":
        data.byteswap()
    return data, rate


def write_pcm(path: Path, samples: array.array, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = array.array("h", samples)
    if sys.byteorder == "big":
        data.byteswap()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(data.tobytes())


def trim_silence(samples: array.array, rate: int, threshold: int = 300, pad_ms: int = 60) -> array.array:
    """Cuts leading/trailing near-silence (|x| < threshold) and keeps pad_ms around the speech."""
    n = len(samples)
    lo = 0
    while lo < n and abs(samples[lo]) < threshold:
        lo += 1
    if lo >= n:
        return samples
    hi = n - 1
    while hi > lo and abs(samples[hi]) < threshold:
        hi -= 1
    pad = int(rate * pad_ms / 1000)
    return samples[max(0, lo - pad) : min(n, hi + 1 + pad)]


def fake_speech(text: str, rate: int = TTS_RATE, seed: int = 0) -> array.array:
    """Speech-like stand-in for TTS: a voiced tone with ~4 Hz syllable envelope, ~14 characters per second."""
    dur = max(0.6, len(text) / 14.0)
    n = int(dur * rate)
    f0 = 140 + (seed % 5) * 12
    out = array.array("h", bytes(2 * n))
    for i in range(n):
        t = i / rate
        env = 0.5 * (1 - math.cos(2 * math.pi * 4.0 * t)) * min(1.0, t * 20, (dur - t) * 20)
        v = math.sin(2 * math.pi * f0 * t) + 0.4 * math.sin(2 * math.pi * 2 * f0 * t) + 0.2 * math.sin(2 * math.pi * 3 * f0 * t)
        out[i] = int(9000 * env * v / 1.6)
    return out


# ---------------------------------------------------------------- tts

def detect_pauses(wav: Path, min_silence: float = 0.25, noise_db: int = -35) -> list[tuple[float, float]]:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(wav), "-af", f"silencedetect=noise={noise_db}dB:d={min_silence}", "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    starts = [float(m) for m in re.findall(r"silence_start: ([\d.]+)", r.stderr)]
    ends = [float(m) for m in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
    return list(zip(starts, ends))


class ChatterboxVoice:
    def __init__(self, device: str, seed: int):
        import torch  # noqa: F401  (fails early with a clear error outside the TTS venv)
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        self.torch = torch
        torch.manual_seed(seed)
        log(f"chatterbox multilingual on {device}")
        self.model = ChatterboxMultilingualTTS.from_pretrained(device=device)
        self.rate = int(self.model.sr)
        self.conditioned = False

    def say(self, text: str, language: str, ref: Path | None, exaggeration: float, cfg_weight: float, temperature: float = 0.8) -> array.array:
        # the reference voice is embedded once; later calls reuse model.conds
        prompt = str(ref) if ref and not self.conditioned else None
        wav = self.model.generate(text, language_id=language, audio_prompt_path=prompt, exaggeration=exaggeration, cfg_weight=cfg_weight, temperature=temperature)
        self.conditioned = self.conditioned or prompt is not None
        x = wav.squeeze().detach().cpu().clamp(-1, 1).numpy()
        return array.array("h", (x * 32767).astype("int16").tobytes())


def cmd_tts(a: argparse.Namespace) -> None:
    job, out = Path(a.job).resolve(), Path(a.out_dir).resolve()
    s = load_script(job)
    lang = (a.language or s["language"]).lower()
    tts_cfg = {"exaggeration": 0.5, "cfg_weight": 0.4, "line_pause_ms": 450, "sentence_pause_ms": 220, **s.get("tts", {})}
    for k in ("exaggeration", "cfg_weight"):
        if getattr(a, k) is not None:
            tts_cfg[k] = getattr(a, k)
    key = script_hash(job, {**s, "language": lang, "tts": tts_cfg, "fake": bool(a.fake)})
    timings_file = out / "timings.json"
    if not a.force and timings_file.exists() and (out / "speech.wav").exists() and (out / "speech_16k.wav").exists():
        if read_json(timings_file).get("script_sha") == key:
            log("tts: speech.wav уже готов для этого сценария — пропускаю (--force для повтора)")
            return
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    lines_out: list[dict] = []
    cuts: list[float] = []
    versions: dict = {"python": sys.version.split()[0]}

    if s.get("speech"):
        # the user's own recording: no TTS, just a clean 24 kHz mono WAV
        src = job / s["speech"]
        if not src.exists():
            raise SystemExit(f"script.json ссылается на {s['speech']}, а файла нет в бандле")
        ffmpeg("-i", str(src), "-vn", "-ac", "1", "-ar", str(TTS_RATE), "-c:a", "pcm_s16le", str(out / "speech.wav"))
        samples, rate = read_pcm(out / "speech.wav")
        duration = len(samples) / rate
        pauses = detect_pauses(out / "speech.wav")
        cuts = [round((a0 + b0) / 2, 3) for a0, b0 in pauses if 0.5 < (a0 + b0) / 2 < duration - 0.5]
        sm = s.get("speech_meta") or {}
        if sm.get("lines"):
            # speech synthesised by vedit (Piper): exact line timings come with it
            lines_out = [{"i": int(x["i"]), "text": x["text"], "start": x.get("start"), "end": x.get("end")} for x in sm["lines"]]
        else:
            lines_out = [{"i": i, "text": t, "start": None, "end": None} for i, t in enumerate(s["lines"])]
        if sm:
            engine, model, voice = sm.get("engine") or "provided", sm.get("model") or "", sm.get("voice") or "library"
        else:
            engine, model, voice = "provided", "user recording", "own-recording"
    else:
        if lang not in CHATTERBOX_LANGS and not a.fake:
            raise SystemExit(f"Chatterbox не знает язык «{lang}». Поддерживаются: {', '.join(sorted(CHATTERBOX_LANGS))}. Для других языков запишите голос сами (vedit avatar export --speech my.ogg).")
        ref = job / s["voice_ref"] if s.get("voice_ref") else None
        if ref is not None and not ref.exists():
            raise SystemExit(f"script.json ссылается на {s['voice_ref']}, а файла нет в бандле")
        voice = "clone" if ref else "default"
        if a.fake:
            rate, engine, model = TTS_RATE, "fake", "tone"
            synth = None
        else:
            synth = ChatterboxVoice(a.device, a.seed)
            rate, engine, model = synth.rate, "chatterbox-multilingual", "ResembleAI/chatterbox t3_mtl23ls_v2"
            versions.update(_versions("torch", "chatterbox-tts", "transformers"))
        line_gap = array.array("h", bytes(2 * int(rate * tts_cfg["line_pause_ms"] / 1000)))
        sent_gap = array.array("h", bytes(2 * int(rate * tts_cfg["sentence_pause_ms"] / 1000)))
        speech = array.array("h")
        n_sent = 0
        for i, line in enumerate(s["lines"]):
            if i:
                cuts.append(round((len(speech) + len(line_gap) / 2) / rate, 3))
                speech.extend(line_gap)
            start = len(speech) / rate
            for j, sent in enumerate(split_sentences(line)):
                if j:
                    cuts.append(round((len(speech) + len(sent_gap) / 2) / rate, 3))
                    speech.extend(sent_gap)
                if synth is None:
                    pcm = fake_speech(sent, rate, seed=n_sent)
                else:
                    pcm = _say_checked(synth, sent, lang, ref, tts_cfg, n_sent)
                pcm = trim_silence(pcm, rate)
                write_pcm(out / "tts" / f"line{i:03d}_s{j}.wav", pcm, rate)
                speech.extend(pcm)
                n_sent += 1
                log(f"  [{i + 1}/{len(s['lines'])}] {len(pcm) / rate:5.1f}s  {sent[:70]}")
            lines_out.append({"i": i, "text": line, "start": round(start, 3), "end": round(len(speech) / rate, 3)})
        # a short tail so the last word is not clipped by the video
        speech.extend(array.array("h", bytes(2 * int(rate * 0.3))))
        write_pcm(out / "speech.wav", speech, rate)
        duration = len(speech) / rate
    ffmpeg("-i", str(out / "speech.wav"), "-ac", "1", "-ar", str(ANIM_RATE), "-c:a", "pcm_s16le", str(out / "speech_16k.wav"))
    write_json(timings_file, {
        "script_sha": key,
        "engine": engine,
        "model": model,
        "voice": voice,
        "language": lang,
        "sample_rate": TTS_RATE,
        "duration": round(duration, 3),
        "lines": lines_out,
        "cuts": cuts,
        "settings": tts_cfg,
        "watermark": "perth (Resemble AI, imperceptible)" if engine == "chatterbox-multilingual" else None,
        "wall_seconds": round(time.time() - t0, 1),
        "versions": versions,
    })
    log(f"tts: {duration:.1f}s речи ({engine}, {voice}) за {time.time() - t0:.0f}s → {out / 'speech.wav'}")


def _say_checked(synth: ChatterboxVoice, sent: str, lang: str, ref: Path | None, cfg: dict, n: int) -> array.array:
    """One retry when the length is implausible for the text (a cut-off or a run-on generation)."""
    expected = max(0.8, len(sent) / 14.0)
    pcm = synth.say(sent, lang, ref, cfg["exaggeration"], cfg["cfg_weight"])
    dur = len(pcm) / synth.rate
    if dur < expected * 0.35 or dur > expected * 3 + 2:
        log(f"  ⚠ {dur:.1f}s на {len(sent)} символов — повторяю с другим сидом")
        synth.torch.manual_seed(1000 + n)
        pcm = synth.say(sent, lang, ref, cfg["exaggeration"], cfg["cfg_weight"], temperature=0.7)
    return pcm


def _versions(*pkgs: str) -> dict:
    from importlib import metadata

    out = {}
    for p in pkgs:
        try:
            out[p] = metadata.version(p)
        except Exception:
            pass
    return out


# ---------------------------------------------------------------- animate

def plan_chunks(duration: float, cuts: list[float], max_len: float, fps: int = ANIM_FPS, min_len: float = 3.0) -> list[tuple[float, float]]:
    """Splits [0, duration] into chunks ≤ max_len, preferring the latest pause (cut) inside each window.
    Boundaries sit on the frame grid, so trimmed chunk videos add up to the speech exactly.
    max_len ≤ 0 → one chunk."""
    grid = lambda t: round(round(t * fps) / fps, 4)  # noqa: E731
    duration = grid(duration)
    if max_len <= 0 or duration <= max_len:
        return [(0.0, duration)]
    cuts = sorted(c for c in cuts if 0 < c < duration)
    out: list[tuple[float, float]] = []
    start = 0.0
    while duration - start > max_len:
        inside = [c for c in cuts if start + min_len <= c <= start + max_len]
        end = grid(inside[-1] if inside else start + max_len)
        if end <= start:
            end = grid(start + max_len)
        out.append((start, end))
        start = end
    out.append((start, duration))
    # a tiny tail chunk joins the previous one when that stays near the limit
    if len(out) > 1 and out[-1][1] - out[-1][0] < 1.5 and out[-1][1] - out[-2][0] <= max_len * 1.25:
        out[-2:] = [(out[-2][0], out[-1][1])]
    return out


def slice_wav(src: Path, dest: Path, start: float, end: float) -> None:
    samples, rate = read_pcm(src)
    write_pcm(dest, samples[int(round(start * rate)) : int(round(end * rate))], rate)


class JoyVasa:
    """JoyVASA human-mode pipeline loaded once and reused for every chunk (same API as its inference.py)."""

    def __init__(self, joy_dir: Path, portrait: Path, device: str, cfg_scale: float, half: bool):
        os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")  # its checkpoints pickle argparse args
        if os.name == "nt":
            import pathlib

            pathlib.PosixPath = pathlib.WindowsPath  # the checkpoint pickles PosixPath objects (JoyVASA's inference.py does the same)
        joy_dir = joy_dir.resolve()
        if os.name == "nt" and not str(joy_dir).isascii():
            raise SystemExit(f"JoyVASA в пути с не-латинскими символами ({joy_dir}): OpenCV на Windows не читает такие пути — перенесите папку, например в C:/JoyVASA")
        ensure_hubert_alias(joy_dir)
        sys.path.insert(0, str(joy_dir))
        os.chdir(joy_dir)
        import torch

        self.torch = torch
        cpu = device == "cpu" or not torch.cuda.is_available()
        if cpu and device != "cpu":
            log("⚠ CUDA недоступна — JoyVASA пойдёт на CPU (очень медленно)")
        import src.live_portrait_wmg_pipeline as P
        from src.config.argument_config import ArgumentConfig
        from src.config.crop_config import CropConfig
        from src.config.inference_config import InferenceConfig

        if cpu:
            # CPU smoke tests only: JoyVASA hard-codes device="cuda" in DitTalkingHead (load_model passes none) and enc_dec_mask
            import src.modules.common as C
            import src.modules.dit_talking_head as D

            orig = D.DitTalkingHead.__init__

            def init(self_, *args, **kw):
                kw.setdefault("device", "cpu")
                orig(self_, *args, **kw)

            D.DitTalkingHead.__init__ = init
            mask = C.enc_dec_mask

            def enc_dec_mask(*args, **kw):
                kw.setdefault("device", "cpu")
                return mask(*args, **kw)

            C.enc_dec_mask = D.enc_dec_mask = enc_dec_mask

        # keep the silent render: audio is muxed later from speech.wav without a 2 Mbit/s re-encode
        def keep_silent(silent_video_path, audio_video_path, output_video_path, remove_temp=True):
            os.replace(silent_video_path, output_video_path)

        P.add_audio_to_video = keep_silent
        self.args = ArgumentConfig(
            animation_mode="human",
            reference=str(portrait.resolve()),
            audio=str(portrait.resolve()),
            output_dir=str(joy_dir / "animations"),
            flag_use_half_precision=half,
            flag_force_cpu=cpu,
            flag_do_crop=True,
            flag_pasteback=True,
            flag_stitching=True,
            flag_relative_motion=True,
            flag_normalize_lip=True,
            driving_option="expression-friendly",
            driving_multiplier=1.0,
            cfg_scale=cfg_scale,
        )
        pick = lambda cls: cls(**{k: v for k, v in self.args.__dict__.items() if hasattr(cls, k)})  # noqa: E731
        self.pipeline = P.LivePortraitPipeline(inference_cfg=pick(InferenceConfig), crop_cfg=pick(CropConfig))
        self.device = "cpu" if cpu else torch.cuda.get_device_name(0)

    def render(self, audio: Path, out_dir: Path) -> Path:
        import gc

        self.args.audio = str(audio.resolve())
        self.args.output_dir = str(out_dir.resolve())
        try:
            video = Path(self.pipeline.execute(self.args))
        except Exception as e:
            if "No face detected" in str(e):
                raise SystemExit("JoyVASA не нашёл лицо на портрете: нужен фронтальный портрет, лицо крупно, без очков-масок и сильного поворота") from e
            raise
        gc.collect()
        if self.torch.cuda.is_available():
            self.torch.cuda.empty_cache()
        return video


def ensure_hubert_alias(joy_dir: Path) -> None:
    """JoyVASA loads the audio encoder from pretrained_weights/TencentGameMate:chinese-hubert-base on Linux and
    pretrained_weights/chinese-hubert-base on Windows; whichever exists, make the other name point to it."""
    w = joy_dir / "pretrained_weights"
    names = [w / "chinese-hubert-base"] + ([] if os.name == "nt" else [w / "TencentGameMate:chinese-hubert-base"])
    have = next((p for p in names if (p / "config.json").exists()), None)
    if have is None:
        raise SystemExit(f"нет весов hubert в {w} (ячейка загрузки весов)")
    for p in names:
        if not p.exists():
            try:
                p.symlink_to(have.name, target_is_directory=True)
            except OSError:
                shutil.copytree(have, p)


def fake_animate(portrait: Path, audio: Path, dest: Path) -> None:
    """Stand-in for JoyVASA: the still portrait at 25 fps, as long as the audio (+ JoyVASA's ~0.1 s overshoot)."""
    dur = media_duration(audio) + 0.12
    frames = int(math.ceil(dur * ANIM_FPS))
    ffmpeg("-loop", "1", "-framerate", str(ANIM_FPS), "-i", str(portrait), "-vf", "scale=720:1280,format=yuv420p", "-frames:v", str(frames), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", str(dest))


def cmd_animate(a: argparse.Namespace) -> None:
    job, out = Path(a.job).resolve(), Path(a.out_dir).resolve()
    s = load_script(job)
    anim_cfg = {"cfg_scale": 2.0, "max_chunk_seconds": 20.0, **s.get("animate", {})}
    if a.cfg_scale is not None:
        anim_cfg["cfg_scale"] = a.cfg_scale
    if a.max_chunk_seconds is not None:
        anim_cfg["max_chunk_seconds"] = a.max_chunk_seconds
    timings = read_json(out / "timings.json")
    speech16 = out / "speech_16k.wav"
    portrait = job / s.get("portrait", "portrait.png")
    if not portrait.exists():
        raise SystemExit(f"нет портрета {portrait}")
    key = hashlib.sha256(f"{sha_file(speech16)}|{sha_file(portrait)}|{json.dumps(anim_cfg, sort_keys=True)}|{a.fake}".encode()).hexdigest()[:16]
    report_file = out / "animate.json"
    silent = out / "avatar_silent.mp4"
    if not a.force and silent.exists() and report_file.exists() and read_json(report_file).get("input_sha") == key:
        log("animate: avatar_silent.mp4 уже готов для этой речи — пропускаю (--force для повтора)")
        return
    t0 = time.time()
    samples, rate = read_pcm(speech16)
    duration = len(samples) / rate
    chunks = plan_chunks(duration, timings.get("cuts", []), float(anim_cfg["max_chunk_seconds"]))
    log(f"animate: {duration:.1f}s речи → {len(chunks)} кусок(ов): " + ", ".join(f"{c0:.1f}–{c1:.1f}" for c0, c1 in chunks))
    work = out / "animate"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    joy_dir = Path(a.joyvasa).resolve()
    joy = None if a.fake else JoyVasa(joy_dir, portrait, a.device, float(anim_cfg["cfg_scale"]), a.half)
    videos: list[Path] = []
    for k, (c0, c1) in enumerate(chunks):
        wav = work / f"chunk_{k:03d}.wav"
        slice_wav(speech16, wav, c0, c1)
        t1 = time.time()
        if joy is None:
            video = work / f"chunk_{k:03d}.mp4"
            fake_animate(portrait, wav, video)
        else:
            produced = joy.render(wav, work / f"chunk_{k:03d}")
            video = work / f"chunk_{k:03d}.mp4"
            os.replace(produced, video)
        videos.append(video)
        log(f"  кусок {k + 1}/{len(chunks)}: {c1 - c0:.1f}s за {time.time() - t1:.0f}s")
    concat_chunks(videos, chunks, silent)
    vs = next(st for st in probe(silent)["streams"] if st["codec_type"] == "video")
    versions = {"python": sys.version.split()[0]}
    if joy is not None:
        versions.update(_versions("torch", "transformers", "onnxruntime"))
        versions["joyvasa"] = _git_head(joy_dir)
    write_json(report_file, {
        "input_sha": key,
        "engine": "fake" if joy is None else "joyvasa",
        "device": "cpu" if joy is None else joy.device,
        "settings": anim_cfg,
        "fps": ANIM_FPS,
        "width": vs.get("width"),
        "height": vs.get("height"),
        "chunks": [{"start": c0, "end": c1} for c0, c1 in chunks],
        "duration": round(media_duration(silent), 3),
        "wall_seconds": round(time.time() - t0, 1),
        "versions": versions,
    })
    log(f"animate: {silent} за {time.time() - t0:.0f}s")


def _git_head(d: Path) -> str | None:
    try:
        return run(["git", "-C", str(d), "rev-parse", "HEAD"]).stdout.strip()
    except Exception:
        return None


def concat_chunks(videos: list[Path], chunks: list[tuple[float, float]], dest: Path) -> None:
    """Each chunk trimmed (or padded by repeating its last frame) to exactly its share of the speech, then joined."""
    inputs: list[str] = []
    parts: list[str] = []
    for i, (v, (c0, c1)) in enumerate(zip(videos, chunks)):
        inputs += ["-i", str(v)]
        frames = int(round((c1 - c0) * ANIM_FPS))
        parts.append(f"[{i}:v]fps={ANIM_FPS},tpad=stop_mode=clone:stop_duration=2,trim=end_frame={frames},setpts=PTS-STARTPTS,format=yuv420p,scale=trunc(iw/2)*2:trunc(ih/2)*2[v{i}]")
    graph = ";".join(parts) + ";" + "".join(f"[v{i}]" for i in range(len(videos))) + f"concat=n={len(videos)}:v=1:a=0[out]"
    ffmpeg(*inputs, "-filter_complex", graph, "-map", "[out]", "-r", str(ANIM_FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", str(dest))


# ---------------------------------------------------------------- finalize

def cmd_finalize(a: argparse.Namespace) -> None:
    job, out = Path(a.job).resolve(), Path(a.out_dir).resolve()
    s = load_script(job)
    mode = a.mode or s.get("mode", "avatar")
    timings = read_json(out / "timings.json")
    speech = out / "speech.wav"
    duration = media_duration(speech)
    files = {"speech.wav": speech}
    meta: dict = {
        "version": 1,
        "job": s.get("job"),
        "mode": mode,
        "language": timings.get("language"),
        "duration": round(duration, 3),
        "lines": timings.get("lines", []),
        "tts": {k: timings.get(k) for k in ("engine", "model", "voice", "settings", "watermark", "wall_seconds", "versions")},
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if mode != "voice_only":
        anim = read_json(out / "animate.json")
        fps = int(a.fps or ANIM_FPS)
        video = out / "avatar.mp4"
        vf = f"fps={fps},tpad=stop_mode=clone:stop_duration=1,format=yuv420p" if fps != ANIM_FPS else "tpad=stop_mode=clone:stop_duration=1,format=yuv420p"
        ffmpeg("-i", str(out / "avatar_silent.mp4"), "-i", str(speech), "-map", "0:v:0", "-map", "1:a:0", "-vf", vf, "-t", f"{duration:.3f}",
               "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", str(fps), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", str(video))
        # the Telegram bot downloads ≤ 20 MB: re-encode at a computed bitrate when the zip would not fit
        limit = int(float(a.max_mb) * 1e6) if a.max_mb else 0
        if limit and video.stat().st_size + speech.stat().st_size > limit:
            budget = limit - speech.stat().st_size * 0.9 - 300_000
            kbps = max(300, int(budget * 8 / duration / 1000 * 0.93) - 128)
            log(f"finalize: {video.stat().st_size / 1e6:.1f} МБ больше лимита {a.max_mb} МБ — перекодирую видео в {kbps} кбит/с")
            tmp = out / "avatar_fit.mp4"
            ffmpeg("-i", str(video), "-map", "0:v:0", "-map", "0:a:0", "-c:v", "libx264", "-preset", "medium", "-b:v", f"{kbps}k", "-maxrate", f"{int(kbps * 1.3)}k", "-bufsize", f"{kbps * 2}k",
                   "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(tmp))
            os.replace(tmp, video)
        files["avatar.mp4"] = video
        meta["fps"] = fps
        meta["width"], meta["height"] = anim.get("width"), anim.get("height")
        meta["animate"] = {k: anim.get(k) for k in ("engine", "device", "settings", "chunks", "wall_seconds", "versions")}
    write_json(out / "meta.json", meta)
    files["meta.json"] = out / "meta.json"
    zpath = Path(a.zip) if a.zip else out / "avatar_result.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for name, f in files.items():
            z.write(f, name, compress_type=zipfile.ZIP_STORED if name.endswith(".mp4") else zipfile.ZIP_DEFLATED)
    log(f"finalize: {zpath} ({zpath.stat().st_size / 1e6:.1f} МБ: {', '.join(files)})")
    print(str(zpath))


# ---------------------------------------------------------------- pipeline

def unpack_job(src: Path, dest: Path) -> Path:
    if src.is_dir():
        return src
    with zipfile.ZipFile(src) as z:
        for m in z.infolist():
            name = Path(m.filename)
            if name.is_absolute() or ".." in name.parts:
                raise SystemExit(f"подозрительный путь в архиве: {m.filename}")
        z.extractall(dest)
    # the zip may hold one top-level folder
    if not (dest / "script.json").exists():
        sub = [p for p in dest.iterdir() if p.is_dir() and (p / "script.json").exists()]
        if sub:
            return sub[0]
    return dest


def _exe(p: str | None) -> str:
    """A venv python given as a path (relative to the cwd) or a command name; default: this interpreter."""
    if not p:
        return sys.executable
    # abspath, not resolve(): a venv python is a symlink to the base interpreter, resolving it would leave the venv
    return os.path.abspath(p) if ("/" in p or "\\" in p) else p


def cmd_pipeline(a: argparse.Namespace) -> None:
    out = Path(a.out_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    job = unpack_job(Path(a.job).resolve(), out / "job")
    s = load_script(job)
    mode = a.mode or s.get("mode", "avatar")
    me = str(Path(__file__).resolve())
    common = ["--job", str(job), "--out-dir", str(out)] + (["--fake"] if a.fake else []) + (["--force"] if a.force else [])
    t0 = time.time()
    tts = [_exe(a.tts_python), me, "tts", *common, "--device", a.device]
    for flag, v in (("--exaggeration", a.exaggeration), ("--cfg-weight", a.cfg_weight)):
        if v is not None:
            tts += [flag, str(v)]
    log("▸ речь")
    subprocess.run(tts, check=True)
    if mode != "voice_only":
        log("▸ анимация")
        anim = [_exe(a.joy_python), me, "animate", *common, "--device", a.device, "--joyvasa", str(Path(a.joyvasa or "JoyVASA").resolve())]
        for flag, v in (("--cfg-scale", a.cfg_scale), ("--max-chunk-seconds", a.max_chunk_seconds)):
            if v is not None:
                anim += [flag, str(v)]
        if a.half:
            anim.append("--half")
        subprocess.run(anim, check=True)
    log("▸ сборка")
    fin = [sys.executable, me, "finalize", "--job", str(job), "--out-dir", str(out), "--mode", mode] + (["--fps", str(a.fps)] if a.fps else [])
    subprocess.run(fin, check=True)
    log(f"готово за {time.time() - t0:.0f}s")


# ---------------------------------------------------------------- selftest

def cmd_selftest(a: argparse.Namespace) -> None:
    assert split_sentences("Привет. Как дела? Отлично!") == ["Привет.", "Как дела?", "Отлично!"]
    long = "слово, " * 60
    parts = split_sentences(long, 100)
    assert all(len(p) <= 101 for p in parts) and " ".join(parts).replace("  ", " ").strip() == long.strip(), parts
    assert plan_chunks(12.0, [5.0], 20) == [(0.0, 12.0)]
    ch = plan_chunks(50.0, [8.3, 17.9, 26.1, 39.5, 48.0], 20)
    assert ch[0][0] == 0.0 and abs(ch[0][1] - 17.9) <= 0.04 and ch[-1][1] == 50.0 and all(c1 - c0 <= 20.001 for c0, c1 in ch), ch
    assert all(abs(round(c * ANIM_FPS) - c * ANIM_FPS) < 1e-6 for pair in ch for c in pair), "frame grid"
    assert plan_chunks(41.0, [], 20) == [(0.0, 20.0), (20.0, 41.0)], plan_chunks(41.0, [], 20)
    pcm = array.array("h", [0] * 1000 + [5000] * 100 + [0] * 1000)
    assert len(trim_silence(pcm, 1000, pad_ms=10)) == 120
    if not shutil.which("ffmpeg"):
        raise SystemExit("selftest: нужен ffmpeg в PATH")

    tmp = Path(tempfile.mkdtemp(prefix="vedit-avatar-selftest-"))
    try:
        # job: portrait + four lines (one long), chunks forced at 5 s
        jd = tmp / "job_src"
        jd.mkdir()
        ffmpeg("-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=1", "-frames:v", "1", str(jd / "portrait.png"))
        lines = ["Привет! Это проверка аватара.", "Вторая строка, чуть длиннее первой, чтобы было что резать на куски.", "Третья.", "И последняя строка сценария."]
        write_json(jd / "script.json", {"version": 1, "job": "selftest", "language": "ru", "lines": lines, "portrait": "portrait.png", "mode": "avatar", "tts": {}, "animate": {"max_chunk_seconds": 5}})
        zpath = tmp / "avatar_job.zip"
        with zipfile.ZipFile(zpath, "w") as z:
            for f in jd.iterdir():
                z.write(f, f.name)
        out = tmp / "out"
        argv = [sys.executable, str(Path(__file__).resolve()), "pipeline", "--job", str(zpath), "--out-dir", str(out), "--fake", "--device", "cpu"]
        subprocess.run(argv, check=True)
        res = out / "avatar_result.zip"
        with zipfile.ZipFile(res) as z:
            names = set(z.namelist())
        assert names == {"avatar.mp4", "speech.wav", "meta.json"}, names
        meta = read_json(out / "meta.json")
        p = probe(out / "avatar.mp4")
        kinds = sorted(st["codec_type"] for st in p["streams"])
        assert kinds == ["audio", "video"], kinds
        vdur, sdur = float(p["format"]["duration"]), media_duration(out / "speech.wav")
        assert abs(vdur - sdur) < 0.15, (vdur, sdur)
        assert len(meta["animate"]["chunks"]) >= 2, meta["animate"]["chunks"]
        assert [l["text"] for l in meta["lines"]] == lines
        assert all(l["end"] > l["start"] for l in meta["lines"])
        mtime = (out / "avatar_silent.mp4").stat().st_mtime
        subprocess.run(argv, check=True)  # re-run: stages are skipped
        assert (out / "avatar_silent.mp4").stat().st_mtime == mtime, "animate re-ran on unchanged input"

        # own recording (skip TTS) + voice only
        jd2 = tmp / "job_own"
        jd2.mkdir()
        shutil.copy(jd / "portrait.png", jd2 / "portrait.png")
        write_pcm(jd2 / "speech_in.wav", fake_speech("Своя запись голоса, без синтеза речи вообще.") + array.array("h", bytes(2 * 12000)) + fake_speech("Вторая фраза записи."), TTS_RATE)
        write_json(jd2 / "script.json", {"version": 1, "job": "selftest2", "language": "ru", "lines": [], "speech": "speech_in.wav", "portrait": "portrait.png", "mode": "voice_only"})
        out2 = tmp / "out2"
        subprocess.run([sys.executable, str(Path(__file__).resolve()), "pipeline", "--job", str(jd2), "--out-dir", str(out2), "--fake", "--device", "cpu"], check=True)
        with zipfile.ZipFile(out2 / "avatar_result.zip") as z:
            assert set(z.namelist()) == {"speech.wav", "meta.json"}, z.namelist()
        t2 = read_json(out2 / "timings.json")
        assert t2["engine"] == "provided" and t2["cuts"], t2
        # speech synthesised by vedit (Piper): engine, voice and line timings are taken from speech_meta
        jd3 = tmp / "job_piper"
        jd3.mkdir()
        shutil.copy(jd2 / "speech_in.wav", jd3 / "speech_in.wav")
        sm_lines = [{"i": 0, "text": "Своя запись.", "start": 0.0, "end": 1.2}, {"i": 1, "text": "Вторая фраза.", "start": 1.7, "end": 2.6}]
        write_json(jd3 / "script.json", {"version": 1, "job": "selftest3", "language": "ru", "lines": ["Своя запись.", "Вторая фраза."], "speech": "speech_in.wav",
                                          "speech_meta": {"engine": "piper", "voice": "denis", "model": "ru_RU-denis-medium", "lines": sm_lines}, "portrait": "portrait.png", "mode": "voice_only"})
        out3 = tmp / "out3"
        subprocess.run([sys.executable, str(Path(__file__).resolve()), "tts", "--job", str(jd3), "--out-dir", str(out3), "--fake", "--device", "cpu"], check=True)
        t3 = read_json(out3 / "timings.json")
        assert t3["engine"] == "piper" and t3["voice"] == "denis" and t3["lines"][1]["start"] == 1.7, t3
        print(f"selftest ok: chunks {meta['animate']['chunks']}, video {vdur:.2f}s / speech {sdur:.2f}s, own-recording cuts {t2['cuts']}")
    finally:
        if not a.keep:
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            print(f"kept {tmp}")


# ---------------------------------------------------------------- cli

def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles default to cp1251
        except Exception:
            pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def job_args(p: argparse.ArgumentParser) -> None:
        p.add_argument("--job", required=True, help="распакованный avatar_job (папка со script.json)")
        p.add_argument("--out-dir", required=True)
        p.add_argument("--fake", action="store_true", help="без моделей: синтетическая речь / видео (проверка обвязки)")
        p.add_argument("--force", action="store_true", help="пересчитать, даже если вход не менялся")

    t = sub.add_parser("tts", help="script.json → speech.wav")
    job_args(t)
    t.add_argument("--device", default="cuda")
    t.add_argument("--language")
    t.add_argument("--exaggeration", type=float)
    t.add_argument("--cfg-weight", type=float)
    t.add_argument("--seed", type=int, default=42)
    t.set_defaults(fn=cmd_tts)

    an = sub.add_parser("animate", help="portrait + speech_16k.wav → avatar_silent.mp4")
    job_args(an)
    an.add_argument("--device", default="cuda")
    an.add_argument("--joyvasa", default="JoyVASA", help="папка клона JoyVASA с pretrained_weights/")
    an.add_argument("--cfg-scale", type=float)
    an.add_argument("--max-chunk-seconds", type=float)
    an.add_argument("--half", action="store_true", help="fp16 (быстрее; при чёрных квадратах — без него)")
    an.set_defaults(fn=cmd_animate)

    fi = sub.add_parser("finalize", help="avatar.mp4 + meta.json → avatar_result.zip")
    fi.add_argument("--job", required=True)
    fi.add_argument("--out-dir", required=True)
    fi.add_argument("--mode", choices=["avatar", "voice_only"])
    fi.add_argument("--fps", type=int, help="25 (родной JoyVASA) или 30")
    fi.add_argument("--zip")
    fi.add_argument("--max-mb", type=float, default=19, help="уместить архив в столько МБ (бот Telegram принимает ≤ 20); 0 — без лимита")
    fi.set_defaults(fn=cmd_finalize)

    pl = sub.add_parser("pipeline", help="tts → animate → finalize (то, что запускает ноутбук Colab)")
    pl.add_argument("--job", required=True, help="avatar_job.zip или папка")
    pl.add_argument("--out-dir", required=True)
    pl.add_argument("--mode", choices=["avatar", "voice_only"])
    pl.add_argument("--tts-python", help="python окружения chatterbox-tts")
    pl.add_argument("--joy-python", help="python окружения JoyVASA")
    pl.add_argument("--joyvasa", help="папка клона JoyVASA")
    pl.add_argument("--device", default="cuda")
    pl.add_argument("--exaggeration", type=float)
    pl.add_argument("--cfg-weight", type=float)
    pl.add_argument("--cfg-scale", type=float)
    pl.add_argument("--max-chunk-seconds", type=float)
    pl.add_argument("--half", action="store_true")
    pl.add_argument("--fps", type=int)
    pl.add_argument("--fake", action="store_true")
    pl.add_argument("--force", action="store_true")
    pl.set_defaults(fn=cmd_pipeline)

    st = sub.add_parser("selftest", help="обвязка без моделей: синтетическая речь и видео через ffmpeg")
    st.add_argument("--keep", action="store_true")
    st.set_defaults(fn=cmd_selftest)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
