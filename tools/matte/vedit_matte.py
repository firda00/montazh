"""vedit matte sidecar: cuts the speaker out of a rough cut for the split layout (MediaPipe).

Run through tools/matte/.venv (see README, "Вырезание спикера"). Reads the rough cut with ffmpeg
(rawvideo pipe), segments people with the MediaPipe Tasks ImageSegmenter (selfie_segmenter.tflite)
at an analysis fps, refines the edge on every output frame with a guided filter against the real
image, smooths it in time, and lets a second ffmpeg merge the matte with the untouched video
(alphamerge) into, in one pass: the plate (the box below the seam, the speaker composited over the
designed background, opaque H.264) and the pop strip (the rows above the seam, VP9 WebM with alpha,
yuva420p — HyperFrames decodes it with libvpx-vp9 into RGBA frames; kept small because full-height
alpha frames made the renderer ~3.5x slower).
Progress goes to stderr; stats go to the --stats JSON; nothing goes to stdout.

  matte    --input rough.mp4 --out-plate plate.mp4 [--out-pop pop.webm] [--out-alpha alpha.webm]
           --stats stats.json --width 1080 --crop-h 1076 --overlap 116 [--bg-color #0D0A1A --accent #8B6CFF]
           [--head-margin 24] [--analysis-fps 15] [--fps N] [--crf 30]
           [--model models/selfie_segmenter.tflite] [--segmenter mediapipe|key --key-color #RRGGBB]
           [--ffmpeg ffmpeg] [--ffprobe ffprobe] [--max-seconds S]
  model    downloads the model into tools/matte/models (once)
  selftest synthetic clip (a coloured "person" on a moving background) through the whole pipeline
           with the colour-key segmenter (no model, no network), prints the stats JSON to stderr

The layer is the rough cut scaled to --width and cropped to --crop-h rows starting at y0, which the
sidecar picks so the head top lands --head-margin rows below the crop top; its first --overlap rows (the
pop strip) sit above the seam, so the head breaks over the top panel ("pop-out"), the rest is the plate.

Licences: MediaPipe (Apache-2.0), selfie_segmenter.tflite (Apache-2.0, model card:
https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf),
OpenCV (Apache-2.0), NumPy (BSD-3-Clause).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np

VERSION = "matte/1"
HERE = Path(__file__).resolve().parent
MODELS_DIR = Path(os.environ.get("VEDIT_MATTE_MODELS", HERE / "models"))
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"
MODEL_FILE = MODELS_DIR / "selfie_segmenter.tflite"
SEG = 256  # selfie_segmenter input side


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def write_json(path: str, data: dict) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


def cv():
    import cv2

    cv2.setNumThreads(max(1, min(4, (os.cpu_count() or 2) // 2)))
    return cv2


# ---------------------------------------------------------------- model / segmenters

def ensure_model(path: Path) -> Path:
    if path.exists() and path.stat().st_size > 10_000:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    log(f"downloading {MODEL_URL}")
    tmp = path.with_suffix(".part")
    try:
        import certifi
        import ssl

        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ctx = None
    with urllib.request.urlopen(MODEL_URL, timeout=60, context=ctx) as r, open(tmp, "wb") as f:
        f.write(r.read())
    tmp.replace(path)
    return path


class MediaPipeSegmenter:
    """Selfie segmenter: RGB uint8 → person confidence (SEG×SEG float32)."""

    name = "mediapipe-selfie"

    def __init__(self, model: Path):
        from mediapipe.tasks.python import BaseOptions, vision
        import mediapipe as mp

        self._mp = mp
        # model bytes, not a path: the C++ loader cannot open non-ASCII paths on Windows
        opts = vision.ImageSegmenterOptions(
            base_options=BaseOptions(model_asset_buffer=model.read_bytes()),
            running_mode=vision.RunningMode.IMAGE,
            output_confidence_masks=True,
            output_category_mask=False,
        )
        self._seg = vision.ImageSegmenter.create_from_options(opts)

    def __call__(self, rgb: np.ndarray) -> np.ndarray:
        img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        r = self._seg.segment(img)
        m = r.confidence_masks[0].numpy_view()
        return np.asarray(m, dtype=np.float32).reshape(m.shape[0], m.shape[1])

    def close(self) -> None:
        try:
            self._seg.close()
        except Exception:
            pass


class KeySegmenter:
    """Test segmenter: pixels near a key colour are the "person" (soft edge from the colour distance)."""

    name = "key"

    def __init__(self, color: str):
        c = color.lstrip("#")
        self.rgb = np.array([int(c[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)

    def __call__(self, rgb: np.ndarray) -> np.ndarray:
        d = np.linalg.norm(rgb.astype(np.float32) - self.rgb, axis=2)
        return np.clip((90.0 - d) / 50.0, 0.0, 1.0).astype(np.float32)

    def close(self) -> None:
        pass


# ---------------------------------------------------------------- ffmpeg I/O

def probe(ffprobe: str, path: str) -> dict:
    out = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", path],
        capture_output=True, text=True, check=True,
    ).stdout
    d = json.loads(out)
    s = d["streams"][0]
    num, den = (s.get("r_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den or 1)
    return {"w": int(s["width"]), "h": int(s["height"]), "fps": fps, "duration": float(d.get("format", {}).get("duration") or 0)}


def crop_filter(width: int, scaled_h: int, crop_h: int, y0: int) -> str:
    """scale to width, then rows [y0, y0+crop_h) — rows outside the picture are padded (transparent later)."""
    top_pad = max(0, -y0)
    cy = max(0, y0)
    ch = max(2, min(scaled_h - cy, crop_h - top_pad))
    f = f"scale={width}:{scaled_h}:flags=bicubic,crop={width}:{ch}:0:{cy}"
    if ch != crop_h:
        f += f",pad={width}:{crop_h}:0:{top_pad}:black"
    return f


class FrameReader:
    """rgb24 frames from ffmpeg through a pipe; a thread keeps one frame ahead (decode overlaps compute)."""

    def __init__(self, ffmpeg: str, path: str, vf: str, w: int, h: int, max_seconds: float | None):
        args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin"]
        args += ["-i", path]
        if max_seconds:
            args += ["-t", str(max_seconds)]
        args += ["-an", "-sn", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        self.size = w * h * 3
        self.shape = (h, w, 3)
        self._q: list = []
        self._cv = threading.Condition()
        self._done = False
        threading.Thread(target=self._pump, daemon=True).start()

    def _read_exact(self) -> bytes | None:
        buf = bytearray(self.size)
        view = memoryview(buf)
        got = 0
        while got < self.size:
            n = self.proc.stdout.readinto(view[got:])
            if not n:
                return None
            got += n
        return bytes(buf)

    def _pump(self) -> None:
        while True:
            b = self._read_exact()
            with self._cv:
                while len(self._q) >= 3:
                    self._cv.wait()
                self._q.append(b)
                self._cv.notify_all()
            if b is None:
                return

    def __iter__(self):
        while True:
            with self._cv:
                while not self._q:
                    self._cv.wait()
                b = self._q.pop(0)
                self._cv.notify_all()
            if b is None:
                break
            yield np.frombuffer(b, dtype=np.uint8).reshape(self.shape)
        self.proc.wait()

    def error(self) -> str:
        try:
            return (self.proc.stderr.read() or b"").decode("utf-8", "replace")
        except Exception:
            return ""


# ---------------------------------------------------------------- matte maths

def guided_filter(I: np.ndarray, p: np.ndarray, r: int, eps: float, apply_to: np.ndarray | None = None) -> np.ndarray:
    """Grey guided filter (He et al.) — the edge of p snaps to edges of I. I, p float32 in [0, 1].
    apply_to: a finer copy of I to apply the (upsampled) coefficients to."""
    cv2 = cv()
    k = (2 * r + 1, 2 * r + 1)
    box = lambda x: cv2.boxFilter(x, -1, k, borderType=cv2.BORDER_REFLECT)
    mI = box(I)
    mp_ = box(p)
    cIp = box(I * p) - mI * mp_
    vI = box(I * I) - mI * mI
    a = cIp / (vI + eps)
    b = mp_ - a * mI
    if apply_to is None:
        return box(a) * I + box(b)
    cv2_ = cv()
    h, w = apply_to.shape[:2]
    return cv2_.resize(box(a), (w, h), interpolation=cv2_.INTER_LINEAR) * apply_to + cv2_.resize(box(b), (w, h), interpolation=cv2_.INTER_LINEAR)


def guided_coeffs_color(I: np.ndarray, p: np.ndarray, r: int, eps: float) -> tuple[np.ndarray, np.ndarray]:
    """Colour guided filter coefficients (A: h×w×3, b: h×w), already box-averaged.

    Computed at a low resolution and applied to a finer guide ("fast guided filter", He & Sun 2015):
    colour separates dark hair from a dark background better than luma alone."""
    cv2 = cv()
    k = (2 * r + 1, 2 * r + 1)
    box = lambda x: cv2.boxFilter(x, -1, k, borderType=cv2.BORDER_REFLECT)
    mI = box(I)  # h×w×3
    mp_ = box(p)
    cov_Ip = box(I * p[..., None]) - mI * mp_[..., None]
    R, G, B = I[..., 0], I[..., 1], I[..., 2]
    rr = box(R * R) - mI[..., 0] ** 2 + eps
    rg = box(R * G) - mI[..., 0] * mI[..., 1]
    rb = box(R * B) - mI[..., 0] * mI[..., 2]
    gg = box(G * G) - mI[..., 1] ** 2 + eps
    gb = box(G * B) - mI[..., 1] * mI[..., 2]
    bb = box(B * B) - mI[..., 2] ** 2 + eps
    # inverse of the symmetric 3×3 covariance via the adjugate
    i_rr = gg * bb - gb * gb
    i_rg = gb * rb - rg * bb
    i_rb = rg * gb - gg * rb
    i_gg = rr * bb - rb * rb
    i_gb = rb * rg - rr * gb
    i_bb = rr * gg - rg * rg
    det = rr * i_rr + rg * i_rg + rb * i_rb
    det = np.where(np.abs(det) < 1e-12, 1e-12, det)
    c0, c1, c2 = cov_Ip[..., 0], cov_Ip[..., 1], cov_Ip[..., 2]
    a0 = (i_rr * c0 + i_rg * c1 + i_rb * c2) / det
    a1 = (i_rg * c0 + i_gg * c1 + i_gb * c2) / det
    a2 = (i_rb * c0 + i_gb * c1 + i_bb * c2) / det
    b = mp_ - a0 * mI[..., 0] - a1 * mI[..., 1] - a2 * mI[..., 2]
    A = np.dstack([box(a0), box(a1), box(a2)])
    return A, box(b)


def fast_guided(I: np.ndarray, p: np.ndarray, r: int, eps: float, sub: int, color: bool) -> np.ndarray:
    """Guided filter of p by I (both at the guide size), coefficients at 1/sub resolution."""
    cv2 = cv()
    h, w = p.shape
    lw, lh = max(8, w // sub), max(8, h // sub)
    if color:
        A, b = guided_coeffs_color(cv2.resize(I, (lw, lh), interpolation=cv2.INTER_AREA), cv2.resize(p, (lw, lh), interpolation=cv2.INTER_AREA), r, eps)
        A = cv2.resize(A, (w, h), interpolation=cv2.INTER_LINEAR)
        b = cv2.resize(b, (w, h), interpolation=cv2.INTER_LINEAR)
        return (A * I).sum(axis=2) + b
    g = cv2.cvtColor(I, cv2.COLOR_RGB2GRAY)
    return guided_filter(cv2.resize(g, (lw, lh), interpolation=cv2.INTER_AREA), cv2.resize(p, (lw, lh), interpolation=cv2.INTER_AREA), r, eps, apply_to=g)


def clean_coarse(m: np.ndarray) -> np.ndarray:
    """Drop thin streaks and specks (shelves, lamps) and fill holes: keep the big blobs touching the person."""
    cv2 = cv()
    h, w = m.shape
    b = (m > 0.5).astype(np.uint8)
    if b.sum() < 0.004 * h * w:
        return m * 0.0
    core = cv2.morphologyEx(b, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    # shelves, table edges, light strips: horizontal bands thinner than ~6% of the height leave the core
    core = cv2.morphologyEx(core, cv2.MORPH_OPEN, np.ones((max(3, h // 16), 1), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(core, connectivity=8)
    if n <= 1:
        return m * 0.0
    areas = st[1:, cv2.CC_STAT_AREA]
    big = areas.max()
    keep = np.zeros(n, dtype=np.uint8)
    keep[1:] = ((areas >= 0.2 * big) & (areas >= 0.01 * h * w)).astype(np.uint8)
    gate = keep[lab]
    # holes inside the person (a hand, a strap, a mic in front of the chest) become foreground
    inv = (1 - gate).astype(np.uint8)
    n2, lab2, st2, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    for i in range(1, n2):
        x, y, ww, hh, area = st2[i]
        if x > 0 and y > 0 and x + ww < w and y + hh < h:
            gate[lab2 == i] = 1
    gate = cv2.dilate(gate, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    soft = cv2.GaussianBlur(gate.astype(np.float32), (0, 0), 1.5)
    filled = np.maximum(m, (gate > 0) & (cv2.erode(gate, np.ones((5, 5), np.uint8)) > 0)).astype(np.float32)
    return np.clip(filled * soft, 0.0, 1.0)


def head_top(mask: np.ndarray, min_frac: float = 0.03) -> int | None:
    """First row where the foreground spans at least min_frac of the width (None = empty)."""
    rows = (mask > 0.5).mean(axis=1)
    idx = np.nonzero(rows >= min_frac)[0]
    return int(idx[0]) if idx.size else None


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


# ---------------------------------------------------------------- designed background

def hex_rgb(c: str) -> np.ndarray:
    c = c.strip().lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    return np.array([int(c[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)


def make_background(w: int, h: int, bg: str, accent: str) -> np.ndarray:
    """The bottom box behind the speaker, drawn like the split CSS draws the top half (RGB uint8, h×w):
    panel colour · 1 px grid every 60 px (white 4.5 %) · darker floor (55 % → 100 %: black 0 → 55 %) ·
    accent glow behind the head (ellipse, accent 55 % → 20 % at 0.55 → 0)."""
    img = np.empty((h, w, 3), np.float32)
    img[...] = hex_rgb(bg)
    white = np.array([255, 255, 255], np.float32)
    rows = np.arange(h) % 60 == 0
    cols = np.arange(w) % 60 == 0
    img[rows] = img[rows] * (1 - 0.045) + white * 0.045
    img[:, cols] = img[:, cols] * (1 - 0.045) + white * 0.045
    y = (np.arange(h, dtype=np.float32) / max(1, h - 1))[:, None, None]
    floor = np.clip((y - 0.55) / 0.45, 0, 1) * 0.55
    img = img * (1 - floor)
    cx, cy, rx, ry = 0.5 * w, 0.355 * h, 0.44 * w, 0.475 * h
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
    ga = np.interp(d, [0.0, 0.55, 1.0], [0.55, 0.2, 0.0]).astype(np.float32)[..., None] * 0.9
    img = img * (1 - ga) + hex_rgb(accent) * ga
    return np.clip(img + 0.5, 0, 255).astype(np.uint8)


def write_png(path: str, rgb: np.ndarray) -> None:
    """cv2.imwrite cannot open non-ASCII paths on Windows: encode in memory, write with Python."""
    cv2 = cv()
    ok, buf = cv2.imencode(".png", np.ascontiguousarray(rgb[..., ::-1]))
    if not ok:
        raise RuntimeError("png encode failed")
    Path(path).write_bytes(buf.tobytes())


# ---------------------------------------------------------------- matte command

def pick_y0(a, seg, info: dict, scaled_h: int) -> tuple[int, dict]:
    """Pass 1: sample ~1 frame/s of the full picture, find the head top and put it `head_margin` rows below the crop top."""
    cv2 = cv()
    W = a.width
    side = max(W, scaled_h)
    vf = f"fps={a.probe_fps},scale={W}:{scaled_h}"
    tops: list[int] = []
    clipped = 0
    samples = 0
    reader = FrameReader(a.ffmpeg, a.input, vf, W, scaled_h, a.max_seconds)
    for fr in reader:
        samples += 1
        sq = np.zeros((side, side, 3), np.uint8)
        ox = (side - W) // 2
        sq[:scaled_h, ox : ox + W] = fr  # top-aligned square: rows map 1:1 (× side/SEG)
        m = seg(cv2.resize(sq, (SEG, SEG), interpolation=cv2.INTER_AREA))
        m = clean_coarse(m)
        t = head_top(m[:, (ox * SEG) // side : ((ox + W) * SEG) // side], 0.03)
        if t is None:
            continue
        top = int(t * side / SEG)
        tops.append(top)
        if t <= 1:
            clipped += 1
    if not tops:
        y0 = max(0, (scaled_h - a.crop_h) // 3)
        return y0, {"samples": samples, "with_person": 0, "head_top": None, "head_clipped": 0.0}
    top = int(np.percentile(tops, 25))
    clipped_frac = clipped / len(tops)
    if clipped_frac > 0.4:
        # the head is cut by the frame top: a flat-topped head above the seam looks wrong — no pop-out
        y0 = -a.overlap
    else:
        y0 = top - a.head_margin
    y0 = int(min(max(y0, -a.overlap), max(0, scaled_h - a.crop_h)))
    return y0, {"samples": samples, "with_person": len(tops), "head_top": top, "head_clipped": round(clipped_frac, 3)}


def cmd_matte(a: argparse.Namespace) -> dict:
    cv2 = cv()
    t0 = time.time()
    info = probe(a.ffprobe, a.input)
    fps = a.fps or info["fps"]
    # 4:2:0 needs even sizes
    a.width += a.width % 2
    a.crop_h += a.crop_h % 2
    W = a.width
    scaled_h = int(round(info["h"] * W / info["w"] / 2) * 2)
    if a.segmenter == "key":
        seg = KeySegmenter(a.key_color)
    else:
        seg = MediaPipeSegmenter(ensure_model(Path(a.model)))
    try:
        y0, place = pick_y0(a, seg, info, scaled_h)
        log(f"matte: {W}x{a.crop_h} from y0={y0} (head top {place['head_top']}), {fps:g} fps, analysis {a.analysis_fps:g} fps")
        CH = a.crop_h
        vf = f"fps={fps:g}," + crop_filter(W, scaled_h, CH, y0)
        # matte resolution: ~540 px wide — the reader hands Python only this size; the writer upsamples
        # the matte to W×CH and merges it with the untouched full-resolution picture
        gs = max(1, round(W / 540))
        gw, gh = W // gs, CH // gs
        gw += gw % 2
        gh += gh % 2
        ov = int(round(a.overlap * gh / CH))
        step = max(1, int(round(fps / max(0.5, a.analysis_fps))))
        valid_top = max(0, -y0)  # rows above this are padding (no picture)
        OV = a.overlap - a.overlap % 2
        HB = CH - OV  # the bottom box (below the seam)
        Path(a.out_plate).parent.mkdir(parents=True, exist_ok=True)
        bg_png = str(Path(a.out_plate).with_suffix(".bg.png"))
        write_png(bg_png, make_background(W, HB, a.bg_color, a.accent))
        threads = str(max(2, min(8, os.cpu_count() or 4)))
        vp9 = ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", str(a.crf), "-deadline", a.deadline, "-cpu-used", str(a.cpu_used), "-row-mt", "1", "-threads", threads, "-auto-alt-ref", "0", "-g", str(int(fps * 2))]
        # one pass, up to three outputs: the plate (speaker over the designed background, opaque H.264 — cheap
        # for the renderer), the pop-out strip above the seam (VP9 alpha, small) and optionally the whole matte
        outs = [("plate", a.out_plate)] + ([("pop", a.out_pop)] if a.out_pop and OV >= 2 else []) + ([("alpha", a.out_alpha)] if a.out_alpha else [])
        fc = f"[0:v]{vf},format=yuv420p[v];[1:v]scale={W}:{CH}:flags=bicubic,format=gray[m];[v][m]alphamerge,format=yuva420p,split={len(outs)}" + "".join(f"[s{i}]" for i in range(len(outs))) + ";"
        maps: list[str] = []
        for i, (kind, path) in enumerate(outs):
            if kind == "plate":
                fc += f"[s{i}]crop={W}:{HB}:0:{OV}[body];[2:v]format=yuv420p[bg];[bg][body]overlay=0:0:shortest=1:format=yuv420,format=yuv420p[plate];"
                maps += ["-map", "[plate]", "-an", "-sn", "-c:v", "libx264", "-preset", "veryfast", "-crf", str(a.plate_crf), "-pix_fmt", "yuv420p", "-g", str(int(fps * 2)), "-movflags", "+faststart", path]
            elif kind == "pop":
                fc += f"[s{i}]crop={W}:{OV}:0:0[pop];"
                maps += ["-map", "[pop]", "-an", "-sn", *vp9, path]
            else:
                fc += f"[s{i}]null[alpha];"
                maps += ["-map", "[alpha]", "-an", "-sn", *vp9, path]
        writer_args = [a.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
        if a.max_seconds:
            writer_args += ["-t", str(a.max_seconds)]
        writer_args += [
            "-i", a.input,
            "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{gw}x{gh}", "-r", f"{fps:g}", "-i", "pipe:0",
            "-loop", "1", "-framerate", f"{fps:g}", "-i", bg_png,
            "-filter_complex", fc.rstrip(";"),
            *maps,
        ]
        writer = subprocess.Popen(writer_args, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        reader = FrameReader(a.ffmpeg, a.input, f"{vf},scale={gw}:{gh}:flags=area", gw, gh, a.max_seconds)

        total = int(round((min(info["duration"], a.max_seconds) if a.max_seconds else info["duration"]) * fps)) or 1
        coarse_ema: np.ndarray | None = None
        prev_thumb: np.ndarray | None = None
        prev_bin: np.ndarray | None = None
        coverage: list[float] = []
        ious: list[float] = []
        uncertain: list[float] = []
        cuts = 0
        frames = 0
        analysed = 0
        t_seg = 0.0
        read_frames = 0
        ramp = None
        if valid_top > 0:
            ramp = np.ones((gh, 1), np.float32)
            ramp[: int(np.ceil(valid_top * gh / CH))] = 0.0
        # "stay near the coarse person" gate, built at the coarse resolution (~2·radius at the low resolution)
        nr = max(1, int(round(2 * a.radius * a.sub * SEG / max(gw, gh))))
        near_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * nr + 1, 2 * nr + 1))
        from collections import deque
        from concurrent.futures import ThreadPoolExecutor

        workers = max(1, min(4, (os.cpu_count() or 2) // 3))
        pool = ThreadPoolExecutor(max_workers=workers)
        depth = workers + 2
        pending: deque = deque()
        state = {"prev": None, "frames": 0, "fallback": 0, "t_ref": 0.0, "last_pct": -1}

        def refine(fr: np.ndarray, p: np.ndarray, near: np.ndarray) -> np.ndarray:
            t = time.time()
            small = fr.astype(np.float32) * (1.0 / 255.0)
            q = fast_guided(small, p, a.radius, a.eps, a.sub, a.guide == "color")
            # erode a little (no halo of the old background); the guided filter may bleed into flat
            # background far from the person — stay near the coarse mask
            q = np.clip((q - a.erode) * (1.0 / (1.0 - 2 * a.erode)), 0.0, 1.0)
            q *= near
            state["t_ref"] += time.time() - t
            return q

        def emit(fut, cut: bool, empty: bool) -> bool:
            q = fut.result()
            prev = state["prev"]
            # temporal: small changes are flicker (blend), big changes are motion (follow)
            if prev is not None and not cut:
                calm = cv2.absdiff(q, prev) < 0.2
                q = np.where(calm, 0.5 * (q + prev), q).astype(np.float32)
            state["prev"] = q
            alpha = cv2.GaussianBlur(q, (0, 0), a.feather)
            if ramp is not None:
                alpha *= ramp
            if empty:
                # nobody in the shot (b-roll, an empty wide frame): the plain picture inside the box
                state["fallback"] += 1
                alpha = np.zeros((gh, gw), np.float32)
                alpha[ov:] = 1.0
            try:
                writer.stdin.write((alpha * 255.0 + 0.5).astype(np.uint8).tobytes())
            except (BrokenPipeError, OSError):
                return False
            state["frames"] += 1
            pct = min(100, state["frames"] * 100 // total)
            if pct // 10 != state["last_pct"] // 10:
                state["last_pct"] = pct
                log(f"matte {pct}% ({state['frames']}/{total} frames, {time.time() - t0:.0f}s)")
            return True

        for fr in reader:
            # cut detection on a tiny grey thumbnail: a new shot resets the temporal smoothing
            thumb = cv2.resize(cv2.cvtColor(fr, cv2.COLOR_RGB2GRAY), (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
            cut = prev_thumb is not None and float(np.abs(thumb - prev_thumb).mean()) > 22.0
            if cut:
                cuts += 1
            prev_thumb = thumb
            read_frames += 1
            ta = time.time()
            if (read_frames - 1) % step == 0 or cut or coarse_ema is None:
                m = seg(cv2.resize(fr, (SEG, SEG), interpolation=cv2.INTER_AREA))
                m = clean_coarse(m)
                analysed += 1
                if coarse_ema is None or cut:
                    coarse_ema = m
                else:
                    a_ = 0.6
                    coarse_ema = a_ * m + (1 - a_) * coarse_ema
                b = coarse_ema > 0.5
                cov = float(b.mean())
                coverage.append(cov)
                mid = ((coarse_ema > 0.15) & (coarse_ema < 0.85)).sum()
                uncertain.append(float(mid / max(1, b.sum())))
                if prev_bin is not None and not cut:
                    inter = float((b & prev_bin).sum())
                    union = float((b | prev_bin).sum())
                    if union > 0:
                        ious.append(inter / union)
                prev_bin = b
            t_seg += time.time() - ta
            # edge refinement runs on a thread pool (OpenCV/NumPy release the GIL); the sequential
            # parts (temporal smoothing, writing) stay here, in frame order
            p = cv2.resize(smoothstep(0.3, 0.7, coarse_ema), (gw, gh), interpolation=cv2.INTER_LINEAR)
            near = cv2.resize(cv2.dilate((coarse_ema > 0.05).astype(np.uint8), near_k), (gw, gh), interpolation=cv2.INTER_NEAREST)
            empty = bool(coverage) and coverage[-1] < 0.02
            pending.append((pool.submit(refine, fr, p, near), cut, empty))
            if len(pending) >= depth:
                if not emit(*pending.popleft()):
                    break
        while pending:
            if not emit(*pending.popleft()):
                break
        pool.shutdown(wait=True)
        try:
            writer.stdin.close()
        except Exception:
            pass
        frames = state["frames"]
        werr = writer.stderr.read().decode("utf-8", "replace") if writer.stderr else ""
        code = writer.wait()
        if frames == 0:
            raise RuntimeError(f"no frames decoded from {a.input}: {reader.error()[-400:]}")
        missing = [p for _, p in outs if not Path(p).exists()]
        if code != 0 or missing:
            raise RuntimeError(f"ffmpeg (plate / vp9 alpha) failed with code {code}: {werr[-600:]}")
        Path(bg_png).unlink(missing_ok=True)
    finally:
        seg.close()

    cov = np.array(coverage or [0.0])
    iou = np.array(ious or [1.0])
    wall = time.time() - t0
    stats = {
        "version": VERSION,
        "segmenter": seg.name,
        "input": {"width": info["w"], "height": info["h"], "fps": fps, "duration": info["duration"]},
        "output": {"plate": a.out_plate, "pop": a.out_pop if a.out_pop and OV >= 2 else None, "alpha": a.out_alpha, "width": W, "height": CH, "plate_height": HB, "y0": y0, "overlap": OV, "scaled_height": scaled_h, "matte_width": gw, "matte_height": gh},
        "placement": place,
        "frames": frames,
        "analysed_frames": analysed,
        "analysis_fps": a.analysis_fps,
        "cuts": cuts,
        "coverage": {"median": round(float(np.median(cov)), 4), "p10": round(float(np.percentile(cov, 10)), 4), "p90": round(float(np.percentile(cov, 90)), 4)},
        "empty_frac": round(float((cov < 0.02).mean()), 4),
        "fallback_frames": state["fallback"],
        "stability": {"median_iou": round(float(np.median(iou)), 4), "unstable_frac": round(float((iou < 0.75).mean()), 4)},
        "uncertain_ratio": round(float(np.median(np.array(uncertain or [0.0]))), 4),
        "timings": {"wall_seconds": round(wall, 2), "segment_seconds": round(t_seg, 2), "refine_seconds": round(state["t_ref"], 2), "refine_threads": workers, "realtime_factor": round(wall / max(1e-6, frames / fps), 3)},
        "params": {"guide": a.guide, "radius": a.radius, "sub": a.sub, "eps": a.eps, "erode": a.erode, "feather": a.feather, "crf": a.crf, "deadline": a.deadline, "cpu_used": a.cpu_used},
    }
    if a.stats:
        write_json(a.stats, stats)
    log(f"matte done: {frames} frames in {wall:.1f}s ({stats['timings']['realtime_factor']}x realtime), coverage {stats['coverage']['median']}, iou {stats['stability']['median_iou']}")
    return stats


# ---------------------------------------------------------------- selftest

def make_synthetic(path: str, ffmpeg: str, w: int = 270, h: int = 480, frames: int = 30, fps: int = 15) -> list:
    """A green "person" (head, neck, shoulders) drifting over a moving striped background; returns the true masks."""
    cv2 = cv()
    proc = subprocess.Popen(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "pipe:0",
         "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", path],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    masks = []
    for i in range(frames):
        x = np.arange(w)[None, :] + i * 6
        stripes = ((x // 24) % 2).astype(np.uint8)
        bg = np.zeros((h, w, 3), np.uint8)
        bg[...] = (40, 50, 120)
        bg[stripes.repeat(h, 0) == 1] = (200, 120, 60)
        cx = w // 2 + int(10 * np.sin(i / 5))
        person = np.zeros((h, w), np.uint8)
        cv2.circle(person, (cx, int(h * 0.36)), int(w * 0.17), 1, -1)
        cv2.rectangle(person, (cx - int(w * 0.07), int(h * 0.4)), (cx + int(w * 0.07), int(h * 0.6)), 1, -1)
        cv2.ellipse(person, (cx, int(h * 0.82)), (int(w * 0.38), int(h * 0.3)), 0, 180, 360, 1, -1)
        cv2.rectangle(person, (cx - int(w * 0.38), int(h * 0.82)), (cx + int(w * 0.38), h), 1, -1)
        bg[person == 1] = (40, 220, 60)
        masks.append(person)
        proc.stdin.write(bg.tobytes())
    proc.stdin.close()
    proc.wait()
    return masks


def decode_alpha(ffmpeg: str, path: str, w: int, h: int) -> list:
    """Alpha planes of a VP9 WebM (libvpx-vp9 decoder: the native one drops alpha)."""
    out = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9", "-i", path, "-vf", "alphaextract", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
        capture_output=True, check=True,
    ).stdout
    n = len(out) // (w * h)
    return [np.frombuffer(out[k * w * h : (k + 1) * w * h], np.uint8).reshape(h, w) for k in range(n)]


def cmd_selftest(a: argparse.Namespace) -> None:
    out_dir = Path(a.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    src = str(out_dir / "synthetic.mp4")
    masks = make_synthetic(src, a.ffmpeg)
    W, CH, OV = 270, 300, 30
    ns = argparse.Namespace(
        input=src, out_plate=str(out_dir / "plate.mp4"), out_pop=str(out_dir / "pop.webm"), out_alpha=str(out_dir / "alpha.webm"), bg_color="#0D0A1A", accent="#8B6CFF", plate_crf=18,
        stats=str(out_dir / "stats.json"), width=W, crop_h=CH, overlap=OV, head_margin=6,
        analysis_fps=7.5, fps=None, crf=30, deadline="realtime", cpu_used=8, model=str(MODEL_FILE), segmenter="key", key_color="#28DC3C", ffmpeg=a.ffmpeg, ffprobe=a.ffprobe,
        max_seconds=None, probe_fps=2.0, guide="color", radius=3, sub=2, eps=1e-3, erode=0.08, feather=0.6,
    )
    stats = cmd_matte(ns)
    y0 = stats["output"]["y0"]
    alphas = decode_alpha(a.ffmpeg, ns.out_alpha, W, CH)
    pops = decode_alpha(a.ffmpeg, ns.out_pop, W, OV)
    plate = probe(a.ffprobe, ns.out_plate)
    ious = []
    for gt, al in zip(masks, alphas):
        g = np.zeros((CH, W), bool)
        lo, hi = max(0, y0), min(gt.shape[0], y0 + CH)
        g[lo - y0 : hi - y0] = gt[lo:hi] > 0
        p = al > 127
        ious.append(float((g & p).sum() / max(1, (g | p).sum())))
    head = int(np.nonzero(masks[0].any(axis=1))[0][0])
    stats["selftest"] = {"decoded_frames": len(alphas), "pop_frames": len(pops), "plate_size": [plate["w"], plate["h"]], "iou_mean": round(float(np.mean(ious or [0.0])), 4), "true_head_top": head}
    write_json(str(out_dir / "stats.json"), stats)
    ok = len(alphas) == len(masks) and len(pops) == len(masks) and plate["w"] == W and plate["h"] == CH - OV and stats["selftest"]["iou_mean"] > 0.9 and abs((stats["placement"]["head_top"] or 0) - head) <= 8
    log(json.dumps({"selftest": "ok" if ok else "failed", **stats["selftest"], "head_top": stats["placement"]["head_top"], "y0": y0, "coverage": stats["coverage"]["median"]}))
    if not ok:
        sys.exit(1)


def cmd_model(a: argparse.Namespace) -> None:
    p = ensure_model(Path(a.model))
    log(f"model ok: {p} ({p.stat().st_size} bytes)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("matte")
    m.add_argument("--input", required=True)
    m.add_argument("--out-plate", required=True, help="H.264: the speaker over the designed background, the box below the seam")
    m.add_argument("--out-pop", help="VP9+alpha WebM: the strip above the seam (pop-out)")
    m.add_argument("--out-alpha", help="VP9+alpha WebM of the whole layer (debugging, selftest)")
    m.add_argument("--bg-color", default="#0D0A1A")
    m.add_argument("--accent", default="#8B6CFF")
    m.add_argument("--plate-crf", type=int, default=16)
    m.add_argument("--stats")
    m.add_argument("--width", type=int, default=1080)
    m.add_argument("--crop-h", type=int, required=True)
    m.add_argument("--overlap", type=int, default=0, help="rows of the crop that sit above the seam")
    m.add_argument("--head-margin", type=int, default=24)
    m.add_argument("--analysis-fps", type=float, default=15.0)
    m.add_argument("--probe-fps", type=float, default=1.0)
    m.add_argument("--fps", type=float)
    m.add_argument("--crf", type=int, default=26)
    # an intermediate (HyperFrames re-encodes the reel): realtime VP9 is ~4× faster than "good" at the same look
    m.add_argument("--deadline", choices=["realtime", "good"], default="realtime")
    m.add_argument("--cpu-used", type=int, default=6)
    m.add_argument("--model", default=str(MODEL_FILE))
    m.add_argument("--segmenter", choices=["mediapipe", "key"], default="mediapipe")
    m.add_argument("--key-color", default="#00FF00")
    m.add_argument("--guide", choices=["gray", "color"], default="color")
    m.add_argument("--radius", type=int, default=4, help="guided filter radius at the low resolution")
    m.add_argument("--sub", type=int, default=2, help="guided filter coefficients at 1/sub of the matte resolution")
    m.add_argument("--eps", type=float, default=2e-3)
    m.add_argument("--erode", type=float, default=0.1)
    m.add_argument("--feather", type=float, default=0.8, help="Gaussian sigma at the matte resolution (×2 at 1080)")
    m.add_argument("--ffmpeg", default=os.environ.get("FFMPEG_PATH", "ffmpeg"))
    m.add_argument("--ffprobe", default=os.environ.get("FFPROBE_PATH", "ffprobe"))
    m.add_argument("--max-seconds", type=float)
    s = sub.add_parser("selftest")
    s.add_argument("--out-dir", required=True)
    s.add_argument("--ffmpeg", default=os.environ.get("FFMPEG_PATH", "ffmpeg"))
    s.add_argument("--ffprobe", default=os.environ.get("FFPROBE_PATH", "ffprobe"))
    d = sub.add_parser("model")
    d.add_argument("--model", default=str(MODEL_FILE))
    a = ap.parse_args()
    try:
        if a.cmd == "matte":
            cmd_matte(a)
        elif a.cmd == "selftest":
            cmd_selftest(a)
        else:
            cmd_model(a)
    except Exception as e:  # one readable line for the Node side
        log(f"error: {type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
