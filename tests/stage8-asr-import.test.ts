import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-ws-"));

const { createJob, jobDir, readJson } = await import("../src/lib/workspace.ts");
const { exportAsrAudio, importAsrBundle, loadImportedAsr } = await import("../src/understand/asr-import.ts");
const { TranscriptSchema, SpeakersSchema, CostSchema } = await import("../src/schemas/index.ts");
const { ffmpeg } = await import("../src/lib/ffmpeg.ts");

const faster = {
  engine: "faster-whisper",
  model: "large-v3-turbo",
  device: "cuda",
  compute_type: "float16",
  language: "ru",
  language_probability: 0.99,
  duration: 12,
  wall_seconds: 4.2,
  segments: [
    { start: 0, end: 3, text: "Привет. Начинаем.", words: [{ w: "Привет.", start: 0, end: 1 }, { w: "Начинаем.", start: 1.5, end: 3 }] },
    { start: 4, end: 6, text: "Отвечаю тебе.", words: [{ w: "Отвечаю", start: 4, end: 5 }, { w: "тебе.", start: 5, end: 6 }] },
    { start: 7, end: 9, text: "Субтитры сделал DimaTorzok", words: [] },
    { start: 9.5, end: 12, text: "И снова я.", words: [{ w: "И", start: 9.5, end: 9.8 }, { w: "снова", start: 9.8, end: 10.5 }, { w: "я.", start: 10.5, end: 12 }] },
  ],
};
const phrases = faster.segments.map((s) => ({ start: s.start, end: s.end }));
const speakersRaw = {
  engine: "speechbrain/spkrec-ecapa-voxceleb + agglomerative",
  num_speakers: 2,
  speakers: [{ id: "S1", seconds: 7.5, phrases: 3 }, { id: "S2", seconds: 2, phrases: 1 }],
  phrases: [{ i: 0, speaker: "S1" }, { i: 1, speaker: "S2" }, { i: 2, speaker: "S1" }, { i: 3, speaker: "S1" }],
  wall_seconds: 1.1,
};

test("importAsrBundle: transcript from faster.json, speakers by raw-segment midpoint, marker written; then loadImportedAsr", async () => {
  const job = await createJob("C:/fixture/a.mp4");
  const bundle = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-bundle-"));
  await fs.writeFile(path.join(bundle, "faster.json"), JSON.stringify(faster));
  await fs.writeFile(path.join(bundle, "phrases.json"), JSON.stringify(phrases));
  await fs.writeFile(path.join(bundle, "speakers_raw.json"), JSON.stringify(speakersRaw));

  const r = await importAsrBundle(job.id, bundle);
  // "Привет. Начинаем." splits into two phrases; both sit inside raw segment 0 → S1; the hallucination is dropped
  assert.deepEqual(r.transcript.segments.map((s) => [s.text, s.speaker]), [["Привет.", "S1"], ["Начинаем.", "S1"], ["Отвечаю тебе.", "S2"], ["И снова я.", "S1"]]);
  assert.deepEqual(r.warnings, ['dropped likely hallucination "Субтитры сделал DimaTorzok"']);
  assert.equal(r.speakers?.speakers[1].sample, "Отвечаю тебе.");
  assert.equal(r.marker.device, "cuda");
  assert.equal(r.marker.speakers_wall_seconds, 1.1);

  const dir = jobDir(job.id);
  const t = await readJson(path.join(dir, "transcript.json"), TranscriptSchema);
  assert.equal(t.segments.length, 4);
  const sp = await readJson(path.join(dir, "speakers.json"), SpeakersSchema);
  assert.equal(sp.speakers[0].id, "S1");
  const loaded = await loadImportedAsr(job.id);
  assert.equal(loaded.marker.model, "large-v3-turbo");
  assert.equal(loaded.speakers?.speakers.length, 2);

  // a bundle without speakers still imports the transcript
  const job2 = await createJob("C:/fixture/b.mp4");
  const bundle2 = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-bundle-"));
  await fs.writeFile(path.join(bundle2, "faster.json"), JSON.stringify(faster));
  const r2 = await importAsrBundle(job2.id, bundle2);
  assert.equal(r2.speakers, null);
  assert.ok(r2.warnings.some((w) => /speakers_raw/.test(w)));
  assert.ok(r2.transcript.segments.every((s) => s.speaker === undefined));

  const empty = await createJob("C:/fixture/c.mp4");
  await assert.rejects(() => loadImportedAsr(empty.id), /asr_import\.json/);
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-empty-"));
  await assert.rejects(() => importAsrBundle(job.id, emptyDir), /faster\.json/);
});

test("importAsrBundle accepts a zip (unpacked with the system tar)", async () => {
  const job = await createJob("C:/fixture/z.mp4");
  const bundle = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-bundle-"));
  await fs.writeFile(path.join(bundle, "faster.json"), JSON.stringify(faster));
  await fs.writeFile(path.join(bundle, "phrases.json"), JSON.stringify(phrases));
  await fs.writeFile(path.join(bundle, "speakers_raw.json"), JSON.stringify(speakersRaw));
  const zip = path.join(bundle, "..", `vedit-bundle-${Date.now()}.zip`);
  const { runProcess } = await import("../src/lib/ffmpeg.ts");
  try {
    await runProcess("tar", ["-a", "-cf", zip, "-C", bundle, "faster.json", "phrases.json", "speakers_raw.json"]);
  } catch {
    console.log("tar cannot write zip here — zip path not tested");
    return;
  }
  const r = await importAsrBundle(job.id, zip);
  assert.equal(r.transcript.segments.length, 4);
  assert.equal(r.speakers?.speakers.length, 2);
});

test("exportAsrAudio writes a small Opus file next to audio.wav", async () => {
  const job = await createJob("C:/fixture/e.mp4");
  const dir = jobDir(job.id);
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", path.join(dir, "audio.wav")]);
  const r = await exportAsrAudio(job.id);
  assert.equal(path.basename(r.file), "asr_upload.ogg");
  assert.ok(r.bytes > 1000 && r.bytes < 5 * 16000 * 2, `${r.bytes} bytes is far smaller than the WAV`);
  const noAudio = await createJob("C:/fixture/f.mp4");
  await assert.rejects(() => exportAsrAudio(noAudio.id), /audio\.wav/);
});
