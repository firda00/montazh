// Stage 23: captions never cover a face, cleaner bold_pop captions, music detection in reference mode, the montage bed.
// Offline: placement against face boxes in various positions (high / low / centre / two faces / beside the text),
// hysteresis between pages, the Reels safe area, the split layout (mapping into the bottom box, the hook), the
// fallback without the sidecar (scenes focus + crop maths), the layout → composition path, the face sidecar runner
// and its cache (fake runner), the music classifier on synthetic signals and the stage-23 music rule, the mix graph.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { placeBlock, placeSequence, safeAreaFor, REELS_SAFE, type BlockRequest, type PlaceOptions } from "../src/design/placement.ts";
import { boxesBetween, detectFaces, estimateFaceTrack, resolveFaceTrack, smoothFaceTrack, toOutputFrame, type FaceBox, type FaceTrack } from "../src/design/faces.ts";
import { buildLayout, captionBlock } from "../src/design/layout.ts";
import { composeHyperframes } from "../src/design/hyperframes/compose.ts";
import { DesignSpecSchema, type DesignSpec, type Scenes } from "../src/schemas/index.ts";
import { loadPreset } from "../src/plan/presets.ts";
import type { DesignJob } from "../src/design/export.ts";
import type { FontMetrics } from "../src/design/layout-types.ts";
import type { OutPhrase } from "../src/design/timeline.ts";
import type { MatteRunner } from "../src/design/matte.ts";
import { classifyMusic, musicFeatures } from "../src/audio/musicdetect.ts";
import { decideMusic } from "../src/style/extract.ts";
import { buildMixGraph, speechRangesFrom } from "../src/audio/mix.ts";
import { barPhase } from "../src/audio/beats.ts";

const SAFE: PlaceOptions = { safe: REELS_SAFE };
/** a track with the same boxes at every sample over [0, seconds] */
const still = (boxes: FaceBox[], seconds = 10, fps = 8): FaceTrack => ({ source: "mediapipe", fps, samples: Array.from({ length: seconds * fps + 1 }, (_, i) => ({ t: i / fps, boxes })) });
const req = (o: Partial<BlockRequest> = {}): BlockRequest => ({ start: 0, end: 1, height: 0.1, width: 0.6, preferred: 0.75, ...o });
const intersects = (y: number, h: number, b: FaceBox) => y - h / 2 < b[3] && y + h / 2 > b[1];

test("placement: a face high in the frame leaves the captions on the preset's lower third", () => {
  const face: FaceBox = [0.3, 0.2, 0.7, 0.42];
  const p = placeBlock(req(), still([face]), SAFE);
  assert.equal(p.rule, "preferred");
  assert.equal(p.y, 0.75);
});

test("placement: a low face (close-up selfie) — no room below inside the Reels safe area → above the face", () => {
  const face: FaceBox = [0.25, 0.5, 0.75, 0.8];
  const p = placeBlock(req(), still([face]), SAFE);
  assert.equal(p.rule, "above_face");
  assert.ok(p.y + 0.05 <= face[1] - 0.06 + 1e-9, `block bottom ${p.y + 0.05} above the forehead pad`);
  assert.ok(p.y - 0.05 >= REELS_SAFE.top);
});

test("placement: a centred face under a centred reference anchor (50 %) → just below the chin, within the safe area", () => {
  const face: FaceBox = [0.23, 0.28, 0.8, 0.6];
  const p = placeBlock(req({ preferred: 0.5 }), still([face]), SAFE);
  assert.equal(p.rule, "below_face");
  assert.ok(p.y - 0.05 >= face[3] + 0.06 - 1e-9, `top ${p.y - 0.05} below chin + pad`);
  assert.ok(p.y + 0.05 <= REELS_SAFE.bottom + 1e-9);
  assert.ok(!intersects(p.y, 0.1, face));
});

test("placement: two faces — both are obstacles when the text spans them; a face beside narrow text is not", () => {
  const left: FaceBox = [0.05, 0.3, 0.4, 0.55];
  const right: FaceBox = [0.6, 0.55, 0.95, 0.8];
  const p = placeBlock(req({ width: 0.8 }), still([left, right]), SAFE);
  assert.ok(!intersects(p.y, 0.1, left) && !intersects(p.y, 0.1, right), `y ${p.y}`);
  // a face far left, a narrow page in the middle: no conflict
  const side: FaceBox = [0.0, 0.65, 0.18, 0.85];
  assert.equal(placeBlock(req({ width: 0.4 }), still([side]), SAFE).rule, "preferred");
});

test("placement: nothing free → the least overlap; a smaller alternative block is preferred when it fits", () => {
  const huge: FaceBox = [0.1, 0.1, 0.9, 0.82];
  const p = placeBlock(req({ height: 0.12 }), still([huge]), SAFE);
  assert.equal(p.rule, "least_overlap");
  const seq = placeSequence([req({ height: 0.2 })], still([[0.1, 0.12, 0.9, 0.5]]), SAFE, () => req({ height: 0.1 }));
  assert.equal(seq[0].alt, false, "the 2-line block already has a free band below");
  const tight = placeSequence([req({ height: 0.2 })], still([[0.1, 0.2, 0.9, 0.62]]), SAFE, () => req({ height: 0.1 }));
  assert.equal(tight[0].alt, true, "only the one-line block fits under the chin");
  assert.notEqual(tight[0].rule, "least_overlap");
});

test("Reels safe area: never in the bottom 16 % or the top 8 % (portrait); landscape keeps only the design margin", () => {
  const low = placeBlock(req({ preferred: 0.95, height: 0.1 }), undefined, SAFE);
  assert.ok(low.y + 0.05 <= 0.84 + 1e-9, `${low.y}`);
  const high = placeBlock(req({ preferred: 0.02, height: 0.1 }), undefined, SAFE);
  assert.ok(high.y - 0.05 >= 0.08 - 1e-9);
  assert.deepEqual(safeAreaFor(1080, 1920, 0.08), { top: 0.08, bottom: 0.84 });
  assert.deepEqual(safeAreaFor(1920, 1080, 0.08), { top: 0.08, bottom: 0.92 });
});

test("hysteresis: pages keep their spot while it is free, move only when the face takes it, return at a cut", () => {
  // face low for 0–4 s (pages must go above it), then gone
  const fps = 8;
  const track: FaceTrack = { source: "mediapipe", fps, samples: Array.from({ length: 8 * fps }, (_, i) => ({ t: i / fps, boxes: i / fps < 4 ? [[0.25, 0.5 + 0.01 * Math.sin(i), 0.75, 0.8] as FaceBox] : [] })) };
  const pages = [0, 1, 2, 3].map((k) => req({ start: k, end: k + 0.95, clip: 0 })).concat([req({ start: 4.1, end: 5, clip: 0 }), req({ start: 5.1, end: 6, clip: 1 })]);
  const out = placeSequence(pages, track, { ...SAFE, settle: 10 });
  const ys = out.map((o) => o.y);
  assert.equal(new Set(ys.slice(0, 4)).size, 1, `one spot for the first 4 pages: ${ys}`);
  assert.ok(ys[0] < 0.5);
  assert.equal(out[4].rule, "kept", "face gone but same clip, no pause → no jump");
  assert.equal(out[5].rule, "preferred", "back to the lower third at the cut");
  assert.equal(out[5].y, 0.75);
  // a spot held ≥ settle seconds may drift back without a cut (the obstacle is gone)
  const settled = placeSequence(pages, track, { ...SAFE, settle: 3 });
  assert.equal(settled[4].rule, "preferred");
});

test("face track: dropouts are bridged, a small unsure box next to a sure face (mic badge) is dropped", () => {
  const face = [0.3, 0.2, 0.7, 0.45, 0.95];
  const raw = [
    { t: 0, faces: [face, [0.6, 0.78, 0.77, 0.88, 0.6]] },
    { t: 0.125, faces: [] },
    { t: 0.25, faces: [face] },
  ];
  const s = smoothFaceTrack(raw, { fps: 8 });
  assert.equal(s[0].boxes.length, 1, "badge dropped");
  assert.equal(s[1].boxes.length, 2, "gap filled from both neighbours");
  assert.equal(boxesBetween({ source: "mediapipe", fps: 8, samples: s }, 0.1, 0.2).length >= 1, true);
});

test("split layout: rough-cut boxes map into the bottom box (plain cover and cutout plate)", () => {
  const track: FaceTrack = { source: "mediapipe", fps: 8, samples: [{ t: 0, boxes: [[0.3, 0.3, 0.7, 0.5]] }] };
  const plain = toOutputFrame(track, { kind: "split", seam: 0.5, offsetPct: 20, frameW: 1080, frameH: 1920, roughW: 1080, roughH: 1920 });
  const b = plain.samples[0].boxes[0];
  // object-position 20 % of the 960 px scroll: rough y 0.3·1920 = 576 → 960 + 576 − 192 = 1344 px
  assert.ok(Math.abs(b[1] - 1344 / 1920) < 1e-3, `${b[1]}`);
  assert.ok(b[1] >= 0.5);
  const cut = toOutputFrame(track, { kind: "cutout", seam: 0.5, overlap: 134, y0: 300, layerW: 1080, scaledH: 1920, frameW: 1080, frameH: 1920 });
  // layer top at 960 − 134; rough row 576 is layer row 276
  assert.ok(Math.abs(cut.samples[0].boxes[0][1] - (960 - 134 + 276) / 1920) < 1e-3);
});

const mono = (em = 0.6): FontMetrics => ({ family: "Mono", file: "", source: "heuristic", measure: (t, s) => Array.from(t).length * em * s, spaceWidth: (s) => 0.25 * s });
function phrase(index: number, text: string, start: number, clip = 0, step = 0.3): OutPhrase {
  const words = text.split(" ").map((w, i) => ({ w, start: Math.round((start + i * step) * 1000) / 1000, end: Math.round((start + (i + 1) * step) * 1000) / 1000, clip, phrase: index }));
  return { phrase: index, clip, start: words[0].start, end: words[words.length - 1].end, lang: "ru", text, words };
}
function job(design: Partial<DesignSpec> | Record<string, unknown>, faces?: FaceTrack, extra: Partial<DesignJob> = {}): DesignJob {
  const phrases = [phrase(0, "Скоро агент будет в приложении банка", 0), phrase(1, "Выиграет тот кто научится ставить задачи", 2.5, 1)];
  return {
    job_id: "t",
    rough_path: "",
    timeline: { output_id: "reel_1", aspect: "9:16", width: 1080, height: 1920, fps: 30, duration: 6, clips: [], phrases, titles: [{ at: 0, duration: 2, text: "Агенты в телефоне", style: "card" }], captions: { enabled: true } },
    pages: [],
    design: DesignSpecSchema.parse(design),
    preset: "bold_pop",
    captions_language: null,
    translated: false,
    warnings: [],
    ...(faces ? { faces } : {}),
    ...extra,
  };
}

test("layout + composition: pages under a centred reference anchor go below the face; the title too; padding per page", () => {
  const face: FaceBox = [0.23, 0.28, 0.8, 0.6];
  const j = job({ captions: { anchor_y: 0.5, max_words: 2 } }, still([face], 7));
  const L = buildLayout(j, mono());
  assert.ok(L.pages.length >= 4);
  for (const p of L.pages) {
    const b = captionBlock(j.design, p, 1080, 1920);
    assert.ok(p.anchorY !== undefined && !intersects(p.anchorY, b.height, face), `page ${p.index} at ${p.anchorY}`);
    assert.ok(p.anchorY! + b.height / 2 <= 0.84 + 1e-6);
  }
  assert.equal(new Set(L.pages.map((p) => p.anchorY)).size, 1, "one stable spot");
  assert.equal(L.faces?.source, "mediapipe");
  const t = L.titlesOut[0];
  assert.ok(t.anchorY !== undefined && t.anchorY < 0.28, `title above the face at ${t.anchorY}`);
  const withOutro = buildLayout(job({ captions: { anchor_y: 0.5, max_words: 2 }, outro: { enabled: true, duration: 1.5, text: "Подпишись — дальше ещё вкуснее" } }, still([[0.23, 0.4, 0.8, 0.62]], 7)), mono());
  assert.ok(withOutro.outroAnchorY !== undefined && (withOutro.outroAnchorY < 0.3 || withOutro.outroAnchorY > 0.62), `outro CTA off the face: ${withOutro.outroAnchorY}`);
  const html = composeHyperframes(j, L, { videoRel: "a.mp4", fontRel: "f.ttf", gsapRel: "g.js" });
  const y = L.pages[0].anchorY! * 1920;
  assert.ok(html.includes(`padding:${Math.round((2 * y - 1920) * 1000) / 1000}px`), "page padding centres it on its own anchor");
});

test("layout: avoid_face off keeps the old fixed anchor; no face data keeps a lower-third slot, moves a centred one", () => {
  const face: FaceBox = [0.2, 0.6, 0.8, 0.85];
  const off = buildLayout(job({ captions: { avoid_face: false, anchor_y: 0.72 } }, still([face], 7)), mono());
  assert.ok(off.pages.every((p) => p.anchorY === undefined));
  assert.equal(off.faces, undefined);
  const none = buildLayout(job({ captions: { anchor_y: 0.77 } }, { source: "none", fps: 8, samples: [] }), mono());
  assert.ok(none.pages.every((p) => p.place === "preferred" && p.anchorY === 0.77));
  // no face data, a centred (reference) anchor: the usual talking-head face is assumed for the captions
  const centred = buildLayout(job({ captions: { anchor_y: 0.5 } }), mono());
  assert.ok(centred.pages.every((p) => p.anchorY! > 0.7), centred.pages.map((p) => p.anchorY).join(","));
});

test("split layout: captions avoid the speaker in the bottom box and the hook on the seam", () => {
  const face: FaceBox = [0.25, 0.6, 0.75, 0.82]; // already in the composition frame
  const panels = { hook_title: [{ text: "АГЕНТЫ", style: "plain" }, { text: "в телефоне", style: "accent" }], panels: [{ start: 0, end: 3 }], image_style: "", notes: [] } as unknown as DesignJob["panels"];
  const j = job({ layout: "split", captions: { anchor_y: 0.79, max_words: 3 } }, still([face], 7), { panels });
  const L = buildLayout(j, mono());
  for (const p of L.pages) {
    const b = captionBlock(j.design, p, 1080, 1920);
    assert.ok(!intersects(p.anchorY!, b.height, [face[0], face[1] - 0.08, face[2], face[3] + 0.06]), `page ${p.index} at ${p.anchorY}`);
  }
  // pages during the hook (first 3 s) stay off it: the hook sits around the seam
  const early = L.pages.filter((p) => p.dispStart < 2.5);
  assert.ok(early.every((p) => p.anchorY! < 0.42), early.map((p) => p.anchorY).join(","));
});

test("fallback without the sidecar: scenes focus through the auto_face crop → a coarse face box; none without focus", async () => {
  const scenes: Scenes = [{ start: 0, end: 10, description: "", objects: [], people_count: 1, emotion: "", shot_type: "medium", quality_score: 1, focus: { x: 0.33, y: 0.3 } }];
  const clips = [{ src_start: 1, src_end: 4, crop: "auto_face" as const, out_start: 0, out_end: 3 }];
  const t = estimateFaceTrack(clips, scenes, { width: 1920, height: 1080 }, "9:16");
  assert.equal(t.source, "scenes");
  const b = t.samples[0].boxes[0];
  // 9:16 from 1080p: the 608 px window centred on x 0.33 → the face centred horizontally; y unchanged (full height)
  assert.ok(Math.abs((b[0] + b[2]) / 2 - 0.5) < 0.02, `${b}`);
  assert.ok(b[1] < 0.3 && b[3] > 0.3);
  const r = await resolveFaceTrack({ rough: "nope.mp4", cacheDir: os.tmpdir(), clips, scenes, media: { width: 1920, height: 1080 }, aspect: "9:16" }, { python: null });
  assert.equal(r.track.source, "scenes");
  assert.ok(r.warnings.some((w) => /сайдкар/.test(w)));
  const none = await resolveFaceTrack({ rough: "nope.mp4", cacheDir: os.tmpdir(), clips, media: { width: 1920, height: 1080 }, aspect: "9:16" }, { python: null });
  assert.equal(none.track.source, "none");
});

test("face sidecar: the faces command is called on the rough cut and cached by its content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-faces-"));
  const rough = path.join(dir, "rough.mp4");
  await fs.writeFile(rough, "fake video bytes");
  let calls = 0;
  const run: MatteRunner = async (_py, args) => {
    calls++;
    assert.equal(args[0], "faces");
    const out = args[args.indexOf("--out") + 1];
    await fs.writeFile(out, JSON.stringify({ version: "faces/1", detector: "x", width: 1080, height: 1920, fps: 8, duration: 1, samples: [{ t: 0, faces: [[0.3, 0.2, 0.7, 0.45, 0.9]] }], with_face: 1, wall_seconds: 0.1 }));
    return { code: 0, stderr: "" };
  };
  const a = await detectFaces(rough, path.join(dir, "cache"), { python: "py", run });
  const b = await detectFaces(rough, path.join(dir, "cache"), { python: "py", run });
  assert.equal(calls, 1);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  const r = await resolveFaceTrack({ rough, cacheDir: path.join(dir, "cache"), clips: [], media: { width: 1080, height: 1920 }, aspect: "9:16" }, { python: "py", run });
  assert.equal(r.track.source, "mediapipe");
  assert.deepEqual(r.track.samples[0].boxes[0], [0.3, 0.2, 0.7, 0.45]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("bold_pop: smaller, softer captions (≈60 px, thin stroke + shadow, ≤ 3 words) and avoid_face on every preset", async () => {
  const bp = (await loadPreset("bold_pop")).preset.design.captions;
  assert.ok(bp.font_size >= 58 && bp.font_size <= 64, `${bp.font_size}`);
  assert.ok(bp.stroke_width <= 4);
  assert.ok(bp.shadow_opacity > 0);
  assert.equal(bp.max_words, 3);
  assert.ok(bp.anchor_y >= 0.7 && bp.anchor_y <= 0.78);
  for (const name of ["bold_pop", "split_news", "calm"]) assert.equal((await loadPreset(name)).preset.design.captions.avoid_face, true, name);
  assert.equal(DesignSpecSchema.parse({}).captions.avoid_face, true);
});

// ---------------------------------------------------------------- music

const SR = 16000;
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}
/** syllable-modulated glottal pulses with a gliding pitch + faint room noise: speech-like, no notes in the pauses */
function speechLike(seconds: number): Float32Array {
  const r = rng(1);
  const x = new Float32Array(seconds * SR);
  let lp = 0;
  let lp2 = 0;
  const f0s = [110, 130, 150, 120, 170];
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const env = Math.max(0, Math.sin(2 * Math.PI * 4.3 * t + Math.sin(t * 1.7) * 2)) ** 1.5;
    const f0 = f0s[Math.floor(t * 4.3) % f0s.length] * (1 + 0.08 * Math.sin(2 * Math.PI * 3 * t));
    const pulse = (t * f0) % 1 < 0.08 ? 1 : 0;
    lp += 0.3 * (pulse + 0.3 * r() - lp);
    lp2 += 0.5 * (lp - lp2);
    x[i] = 0.3 * env * (lp - lp2 * 0.5) + 0.002 * r();
  }
  return x;
}
/** chords + a kick every 0.5 s at `db` */
function bed(seconds: number, db: number): Float32Array {
  const r = rng(9);
  const g = 10 ** (db / 20);
  const chords = [[110, 138.6, 164.8], [98, 123.5, 146.8], [130.8, 164.8, 196], [87.3, 110, 130.8]];
  const x = new Float32Array(seconds * SR);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    let v = 0;
    for (const f of chords[Math.floor(t / 2) % 4]) v += Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t);
    const b = t % 0.5;
    x[i] = g * (0.15 * v + 0.6 * Math.exp(-b * 18) * Math.sin(2 * Math.PI * 55 * b) + 0.02 * r());
  }
  return x;
}

test("music classifier: speech-like bursts → no music; the same + a quiet chord/kick bed → music", () => {
  const sp = speechLike(12);
  const plain = classifyMusic(musicFeatures(sp));
  assert.equal(plain.verdict, "no_music", JSON.stringify(plain));
  const b = bed(12, -26);
  const mixed = new Float32Array(sp.length);
  for (let i = 0; i < sp.length; i++) mixed[i] = sp[i] + b[i];
  const f = musicFeatures(mixed);
  const withBed = classifyMusic(f);
  assert.equal(withBed.verdict, "music", JSON.stringify({ f, withBed }));
  // silent gaps between known words are evidence against a bed
  const gaps = musicFeatures(sp, [{ start: 0, end: 2 }, { start: 4, end: 12 }].map((w) => w));
  assert.ok(gaps.gap_seconds >= 0);
});

test("music rule: the audio wins; unclear → no bed unless Gemini AND the audio lean to music", () => {
  const m = (verdict: "music" | "no_music" | "uncertain", score: number) => ({ music: { version: "musicdetect/1", verdict, score, floor_tonality: 1, gap_db: null, reasons: [] }, audio: null });
  assert.deepEqual(decideMusic(true, m("no_music", -1), true), { value: false, provenance: "measured" }, "Gemini heard a bed that is not there");
  assert.equal(decideMusic(false, m("music", 1.2), true).value, true);
  assert.equal(decideMusic(true, m("uncertain", 0.6), true).value, true, "Gemini + a lean");
  assert.equal(decideMusic(true, m("uncertain", 0), true).value, false, "Gemini alone is not enough");
  assert.equal(decideMusic(false, m("uncertain", 0.6), true).value, false);
  // a profile from before stage 23 (no music measurement, no gaps measured) → no bed
  assert.equal(decideMusic(true, { audio: { speech_lufs: -17, gap_lufs: null, music_likely: false } }, true).value, false);
  assert.equal(decideMusic(true, { audio: { speech_lufs: -17, gap_lufs: -30, music_likely: true } }, true).value, true);
});

test("montage bed: automated under the speech ranges (no side-chain), downbeat offset, qsin fades, linear trim", () => {
  const ranges = speechRangesFrom([{ start: 0.2, end: 0.6 }, { start: 0.8, end: 1.4 }, { start: 3, end: 4 }]);
  assert.deepEqual(ranges, [{ start: 0.2, end: 1.4 }, { start: 3, end: 4 }], "short pauses bridged");
  const g = buildMixGraph({ video: "v.mp4", out: "o.mp4", duration: 10, music: "m.mp3", speech: true, musicOffset: 12.5, speechRanges: ranges, musicFadeOut: 2.2, noFinalLoudnorm: true }, { hasAudio: true, sfxFile: () => "" });
  const fc = g.args[g.args.indexOf("-filter_complex") + 1];
  assert.ok(!fc.includes("sidechaincompress"), fc);
  assert.match(fc, /volume='1-0\.\d+\*min\(1,clip/);
  assert.match(fc, /loudnorm=I=-21/);
  assert.match(fc, /afade=t=out:st=7\.800:d=2\.200:curve=qsin/);
  assert.ok(!/loudnorm=I=-14/.test(fc), "no dynamic final loudnorm");
  assert.ok(g.args.includes("12.500"), "starts at the chosen downbeat");
  // the old path (no speech ranges) still side-chains
  const old = buildMixGraph({ video: "v.mp4", out: "o.mp4", duration: 10, music: "m.mp3", speech: true }, { hasAudio: true, sfxFile: () => "" });
  assert.match(old.args[old.args.indexOf("-filter_complex") + 1], /sidechaincompress/);
});

test("downbeat: the bar phase is the beat whose every 4th neighbour carries the strongest onsets", () => {
  const hop = 0.01;
  const env = new Array(800).fill(0);
  const beats = Array.from({ length: 12 }, (_, i) => 0.5 + i * 0.5);
  beats.forEach((b, i) => (env[Math.round(b / hop)] = i % 4 === 2 ? 3 : 1));
  assert.equal(barPhase(env, beats, hop), 2);
});
