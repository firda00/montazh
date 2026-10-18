/**
 * Whisper.cpp vs Gemini on the same speech: where does our transcript go wrong (names, brands, English terms, numbers)?
 *
 *   npx tsx tools/asr-eval.ts <media> [--from 5040 --to 5100] [--hint "Илон Маск, xAI, Grok"] [--fix] [--out dir] [--lang ru]
 *
 * Extracts the window as 16 kHz mono, transcribes it with whisper.cpp (our pipeline, optionally with the vocabulary
 * prompt from --hint) and with Gemini audio understanding (cached in <out>/gemini.json), then aligns both on canonical
 * spoken words (src/voice/pronounce.ts: «OpenAI» and «Оупен Эй-Ай» compare equal, «2024» and «две тысячи двадцать
 * четыре» too) and prints the disagreement rate and every substitution. --fix also runs the post-correction pass
 * (src/understand/asrfix.ts) and scores the corrected transcript the same way.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ffmpeg, ffprobe } from "../src/lib/ffmpeg.ts";
import { transcribe } from "../src/understand/whisper.ts";
import { transcribeAudio } from "../src/understand/gemini-audio.ts";
import { canonicalWords, similarity } from "../src/voice/pronounce.ts";
import type { Transcript } from "../src/schemas/index.ts";

try {
  process.loadEnvFile();
} catch {}
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

export interface Diff {
  ref: string;
  hyp: string;
}

/** Word alignment (Levenshtein with backtrace): substitutions, deletions (ref only) and insertions (hyp only). */
export function alignWords(ref: string[], hyp: string[]): { errors: number; diffs: Diff[] } {
  const n = ref.length;
  const m = hyp.length;
  const eq = (a: string, b: string) => a === b || (a.length > 4 && similarity(a, b) >= 0.8);
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (eq(ref[i - 1], hyp[j - 1]) ? 0 : 1));
  const diffs: Diff[] = [];
  let i = n;
  let j = m;
  let cur: Diff | null = null;
  const flush = () => {
    if (cur) diffs.unshift({ ref: cur.ref.trim(), hyp: cur.hyp.trim() });
    cur = null;
  };
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (eq(ref[i - 1], hyp[j - 1]) ? 0 : 1)) {
      if (eq(ref[i - 1], hyp[j - 1])) flush();
      else {
        cur ??= { ref: "", hyp: "" };
        cur.ref = `${ref[i - 1]} ${cur.ref}`;
        cur.hyp = `${hyp[j - 1]} ${cur.hyp}`;
      }
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      cur ??= { ref: "", hyp: "" };
      cur.ref = `${ref[i - 1]} ${cur.ref}`;
      i--;
    } else {
      cur ??= { ref: "", hyp: "" };
      cur.hyp = `${hyp[j - 1]} ${cur.hyp}`;
      j--;
    }
  }
  flush();
  return { errors: d[n][m], diffs };
}

const textOf = (t: Transcript) => t.segments.map((s) => s.text).join(" ");

async function main() {
  const [media] = args;
  if (!media) throw new Error("usage: tools/asr-eval.ts <media> [--from s --to s] [--hint text] [--fix] [--out dir]");
  const from = Number(flag("from") ?? 0);
  const to = flag("to") ? Number(flag("to")) : undefined;
  const lang = flag("lang") ?? "ru";
  const hint = flag("hint");
  const out = flag("out") ?? path.join("workspace", "_asr_eval", `${path.parse(media).name.slice(0, 24)}_${from}`);
  await fs.mkdir(out, { recursive: true });
  const wav = path.join(out, "audio16k.wav");
  await ffmpeg(["-ss", String(from), ...(to ? ["-to", String(to)] : []), "-i", media, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  const duration = Number((await ffprobe(wav)).format.duration) || 0;

  // whisper.cpp, as the pipeline runs it (+ the vocabulary prompt when --hint is given)
  const w = await transcribe(wav, duration, path.join(out, hint ? "wp" : "w"), { language: lang, threads: Number(process.env.EVAL_THREADS) || 8, prompt: hint });
  // Gemini, cached
  const gfile = path.join(out, "gemini.json");
  let g: { segments: { text: string }[]; model: string; usd: number };
  try {
    g = JSON.parse(await fs.readFile(gfile, "utf8"));
  } catch {
    g = await transcribeAudio(wav, { hint, onLog: (l) => console.error(l) });
    await fs.writeFile(gfile, JSON.stringify(g, null, 1));
  }
  const gText = g.segments.map((s) => s.text).join(" ");
  const ref = canonicalWords(gText, lang);
  const report = (name: string, t: Transcript) => {
    const hyp = canonicalWords(textOf(t), lang);
    const a = alignWords(ref, hyp);
    console.log(`\n== ${name}: disagreement with Gemini ${((a.errors / Math.max(1, ref.length)) * 100).toFixed(1)}% (${a.errors}/${ref.length} words)`);
    for (const d of a.diffs) console.log(`   gemini «${d.ref}»  ←→  ${name} «${d.hyp}»`);
    return { name, rate: a.errors / Math.max(1, ref.length), errors: a.errors, words: ref.length, diffs: a.diffs };
  };
  console.log(`window ${from}–${to ?? "end"} s (${duration.toFixed(1)} s), gemini ${g.model}`);
  console.log(`GEMINI : ${gText}`);
  console.log(`WHISPER: ${textOf(w.transcript)}`);
  const rows = [report(hint ? "whisper+prompt" : "whisper", w.transcript)];
  if (args.includes("--fix")) {
    const { fixTranscript } = await import("../src/understand/asrfix.ts");
    const f = await fixTranscript(w.transcript, { hint, onLog: (l) => console.error(l) });
    console.log(`FIXED  : ${textOf(f.transcript)}  (${f.changes.length} changes, ${f.model}, $${f.usd.toFixed(4)})`);
    for (const c of f.changes) console.log(`   fix «${c.from}» → «${c.to}»`);
    rows.push(report("whisper+fix", f.transcript));
  }
  await fs.writeFile(path.join(out, `eval${hint ? "_prompt" : ""}${args.includes("--fix") ? "_fix" : ""}.json`), JSON.stringify({ from, to, duration, gemini: gText, rows }, null, 1));
}

await main();
