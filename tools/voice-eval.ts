/**
 * How well does the narration come across? Transcribes speech with whisper.cpp and compares it with what was meant.
 *
 *   npx tsx tools/voice-eval.ts timeline workspace/<job>/make/voice            # an existing make voiceover, beat by beat
 *   npx tsx tools/voice-eval.ts synth workspace/<job>/script.json --voice gemini_charon [--raw] [--style "…"] [--take line] [--judge] [--out dir]
 *
 * `synth` speaks every beat's voiceover (with the pronunciation layer unless --raw) and transcribes it. The report
 * gives a word error rate over canonical spoken forms (brands and numbers spelled the way a Russian narrator says
 * them, on both sides) and a hit rate for the "hard" terms: Latin brand names and numbers.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ffmpeg } from "../src/lib/ffmpeg.ts";
import { transcribe } from "../src/understand/whisper.ts";
import { scoreSpeech, type SpeechScore } from "../src/voice/pronounce.ts";
import { judgePronunciation, type PronunciationIssue } from "../src/understand/gemini-audio.ts";

try {
  process.loadEnvFile(); // .env in cwd (GEMINI_API_KEY), optional
} catch {}
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function whisperText(wav: string, work: string): Promise<string> {
  await fs.mkdir(work, { recursive: true });
  const w16 = path.join(work, "in16k.wav");
  await ffmpeg(["-y", "-i", wav, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", w16]);
  const dur = await probeDuration(w16);
  const r = await transcribe(w16, dur, work, { language: "ru", threads: Number(process.env.EVAL_THREADS) || 8 });
  return r.transcript.segments.map((s) => s.text).join(" ");
}

async function probeDuration(file: string): Promise<number> {
  const { ffprobe } = await import("../src/lib/ffmpeg.ts");
  const p = await ffprobe(file);
  return Number(p.format.duration ?? 0);
}

const JUDGE = args.includes("--judge");
type Row = { beat: number; ref: string; hyp: string; score: SpeechScore; seconds?: number; judge?: { heard: string; issues: PronunciationIssue[]; naturalness: number } };

/** whisper + (with --judge) Gemini's listening of one clip */
async function evalClip(beat: number, clip: string, ref: string, work: string, seconds: number): Promise<Row> {
  const hyp = await whisperText(clip, work);
  const row: Row = { beat, ref, hyp, score: scoreSpeech(ref, hyp), seconds };
  if (JUDGE) {
    try {
      const j = await judgePronunciation(clip, ref);
      row.judge = { heard: j.heard, issues: j.issues, naturalness: j.naturalness };
    } catch (err) {
      console.error(`judge #${beat + 1}: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
    }
  }
  return row;
}

function report(rows: Row[]) {
  let errs = 0;
  let words = 0;
  let hits = 0;
  let terms = 0;
  for (const r of rows) {
    errs += r.score.errors;
    words += r.score.refWords;
    hits += r.score.termHits;
    terms += r.score.terms.length;
    console.log(`\n#${r.beat + 1}${r.seconds ? ` (${r.seconds.toFixed(2)} s)` : ""}  WER ${(r.score.wer * 100).toFixed(1)}%  terms ${r.score.termHits}/${r.score.terms.length}`);
    console.log(`  ref: ${r.ref}`);
    console.log(`  asr: ${r.hyp}`);
    const miss = r.score.terms.filter((t) => !t.hit);
    if (miss.length) console.log(`  missed: ${miss.map((t) => `${t.term} → «${t.spoken}»`).join("; ")}`);
    if (r.judge) {
      console.log(`  gemini heard (${r.judge.naturalness}/10): ${r.judge.heard}`);
      for (const i of r.judge.issues) console.log(`    ! ${i.kind} ${i.severity}: ${i.word} → ${i.heard_as}`);
    }
  }
  if (rows.some((r) => r.judge)) {
    const issues = rows.flatMap((r) => r.judge?.issues ?? []);
    const nat = rows.filter((r) => r.judge).map((r) => r.judge!.naturalness);
    const by = (k: string) => issues.filter((i) => i.kind === k).length;
    console.log(`
GEMINI  issues ${issues.length} (accent ${by("accent")}, stress ${by("stress")}, case ${by("case")}, garbled ${by("garbled")}, skipped ${by("skipped")})  naturalness ${(nat.reduce((a, b) => a + b, 0) / Math.max(1, nat.length)).toFixed(1)}/10`);
  }
  const total = rows.reduce((a, r) => a + (r.seconds ?? 0), 0);
  console.log(`\nTOTAL  WER ${((errs / Math.max(1, words)) * 100).toFixed(1)}% (${errs}/${words})  terms ${hits}/${terms} (${((hits / Math.max(1, terms)) * 100).toFixed(0)}%)${total ? `  speech ${total.toFixed(1)} s` : ""}`);
  return { wer: errs / Math.max(1, words), termRate: hits / Math.max(1, terms), seconds: total };
}

async function timeline(dir: string) {
  const meta = JSON.parse(await fs.readFile(path.join(dir, "voice.json"), "utf8")) as { beats: { beat: number; start: number; end: number; text: string }[] };
  const work = path.join(dir, "_eval");
  const rows: Row[] = [];
  for (const b of meta.beats) {
    const clip = path.join(work, `beat_${b.beat}.wav`);
    await fs.mkdir(work, { recursive: true });
    await ffmpeg(["-ss", Math.max(0, b.start - 0.1).toFixed(3), "-to", (b.end + 0.15).toFixed(3), "-i", path.join(dir, "voice.wav"), clip]);
    rows.push(await evalClip(b.beat, clip, b.text, path.join(work, `b${b.beat}`), b.end - b.start));
  }
  const out = report(rows);
  await fs.writeFile(path.join(work, "eval.json"), JSON.stringify({ ...out, rows }, null, 1));
}

async function synth(scriptPath: string) {
  const { synthesize } = await import("../src/voice/piper.ts");
  const { narrationLines } = await import("../src/voice/voiceover.ts");
  const script = JSON.parse(await fs.readFile(scriptPath, "utf8"));
  const voice = flag("voice") ?? "gemini_charon";
  const raw = args.includes("--raw");
  const style = flag("style");
  const out = flag("out") ?? path.join(path.dirname(scriptPath), `_voice_eval_${raw ? "raw" : "pron"}`);
  await fs.mkdir(out, { recursive: true });
  const lines = narrationLines(script);
  const r = await synthesize(lines, voice, path.join(out, "narration.wav"), {
    pronounce: raw ? false : undefined,
    take: flag("take") === "line" ? "line" : "single",
    gemini: style ? { style } : undefined,
    onEvent: (l) => console.error(l),
  });
  const rows: Row[] = [];
  for (const [i, c] of r.clips.entries()) {
    if (!c.pcm.length) continue;
    const { writeWav } = await import("../src/voice/piper.ts");
    const clip = path.join(out, `beat_${i}.wav`);
    await writeWav(clip, c.pcm, c.rate);
    rows.push(await evalClip(i, clip, lines[i], path.join(out, `b${i}`), c.pcm.length / c.rate));
  }
  const res = report(rows);
  await fs.writeFile(path.join(out, "eval.json"), JSON.stringify({ voice, raw, style: style ?? null, model: r.model, ...res, rows }, null, 1));
}

/** beat_<i>.wav files already in a folder, against the voiceover lines of a script */
async function clipsDir(dir: string, scriptPath: string) {
  const { narrationLines } = await import("../src/voice/voiceover.ts");
  const lines = narrationLines(JSON.parse(await fs.readFile(scriptPath, "utf8")));
  const rows: Row[] = [];
  for (const [i, line] of lines.entries()) {
    const clip = path.join(dir, `beat_${i}.wav`);
    if (!(await fs.stat(clip).catch(() => null))) continue;
    rows.push(await evalClip(i, clip, line, path.join(dir, `b${i}`), await probeDuration(clip)));
  }
  const res = report(rows);
  await fs.writeFile(path.join(dir, "eval.json"), JSON.stringify({ ...res, rows }, null, 1));
}

const [cmd, target] = args;
if (cmd === "timeline" && target) await timeline(target);
else if (cmd === "clips" && target && args[2]) await clipsDir(target, args[2]);
else if (cmd === "synth" && target) await synth(target);
else {
  console.error("usage: tools/voice-eval.ts timeline <make/voice dir> | synth <script.json> [--voice id] [--raw] [--style s] [--out dir]");
  process.exit(2);
}
