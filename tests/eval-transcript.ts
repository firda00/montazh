// Measures word-timestamp accuracy of a job's whisper.json against the fixture's
// .truth.json (SAPI word start times), for both timestamp methods.
//   npx tsx tests/eval-transcript.ts <job_id> [truth.json]
import path from "node:path";
import fs from "node:fs/promises";
import { jobDir, readJson } from "../src/lib/workspace.ts";
import { JobSchema } from "../src/schemas/index.ts";
import { parseWhisperJson, type TimestampMethod, type WhisperJson } from "../src/understand/whisper.ts";

const jobId = process.argv[2];
if (!jobId) throw new Error("usage: tsx tests/eval-transcript.ts <job_id> [truth.json]");
const dir = jobDir(jobId);
const job = await readJson(path.join(dir, "job.json"), JobSchema);
const truthFile = process.argv[3] ?? job.source.replace(/\.mp4$/i, ".truth.json");
const truth = JSON.parse(await fs.readFile(truthFile, "utf8")) as { words: { w: string; start: number }[] };
truth.words.sort((a, b) => a.start - b.start); // SAPI progress events can arrive out of order
const manifest = JSON.parse(await fs.readFile(path.join(dir, "whisper", "chunks.json"), "utf8")) as { chunks: { json: string; start: number }[] };
const raws = await Promise.all(manifest.chunks.map(async (c) => ({ raw: JSON.parse(await fs.readFile(c.json, "utf8")) as WhisperJson, offset: c.start })));
const silences = JSON.parse(await fs.readFile(path.join(dir, "whisper", "silences.json"), "utf8")) as { start: number; end: number }[];
const parse = (method: TimestampMethod) => ({ language: "", segments: raws.flatMap((r) => parseWhisperJson(r.raw, method, r.offset, silences).segments) });

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Longest common subsequence over normalized words → index pairs. */
function align(a: string[], b: string[]): [number, number][] {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

const pct = (arr: number[], p: number) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : NaN;

for (const method of ["tokens", "dtw"] as TimestampMethod[]) {
  const t = parse(method);
  const words = t.segments.flatMap((s) => s.words);
  const pairs = align(truth.words.map((w) => norm(w.w)), words.map((w) => norm(w.w)));
  const errs = pairs.map(([i, j]) => Math.abs(words[j].start - truth.words[i].start)).sort((a, b) => a - b);
  const signed = pairs.map(([i, j]) => words[j].start - truth.words[i].start);
  const bias = signed.reduce((s, x) => s + x, 0) / Math.max(1, signed.length);
  console.log(`\n[${method}]  matched ${pairs.length}/${truth.words.length} truth words (whisper produced ${words.length})`);
  console.log(`  start error: median ${(pct(errs, 0.5) * 1000).toFixed(0)}ms  p90 ${(pct(errs, 0.9) * 1000).toFixed(0)}ms  max ${(pct(errs, 1) * 1000).toFixed(0)}ms  >100ms: ${errs.filter((e) => e > 0.1).length}  bias ${(bias * 1000).toFixed(0)}ms`);
  const worst = pairs.map(([i, j]) => ({ w: truth.words[i].w, truth: truth.words[i].start, got: words[j].start })).sort((a, b) => Math.abs(b.got - b.truth) - Math.abs(a.got - a.truth)).slice(0, 4);
  console.log(`  worst: ${worst.map((x) => `${x.w} ${x.truth}→${x.got}`).join(", ")}`);
}
console.log(`\nunmatched truth words: ${(() => { const p = align(truth.words.map((w) => norm(w.w)), parse("dtw").segments.flatMap((s) => s.words).map((w) => norm(w.w))); const m = new Set(p.map(([i]) => i)); return truth.words.filter((_, i) => !m.has(i)).map((w) => w.w).join(" "); })()}`);
