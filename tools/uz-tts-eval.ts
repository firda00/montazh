// Stage 33: can Gemini TTS speak Uzbek well enough for a faceless venture-news reel?
// Synthesises 4 Uzbek sentences (his style, numbers, English brand names, oʻ/gʻ) with several prebuilt voices,
// transcribes every take back with Gemini audio (blind: no hint of the text) and asks a strict "native Tashkent
// listener" judge for intelligibility, accent and naturalness. Writes WAVs + report.json into the output folder.
//   npx tsx tools/uz-tts-eval.ts [outDir] [--voices Charon,Kore,Puck,Fenrir]
import fs from "node:fs/promises";
import path from "node:path";
import { geminiApiKey, geminiTts } from "../src/voice/gemini.ts";
import { wavBytes } from "../src/voice/piper.ts";
import { inlineAudio, audioModels, transcribeAudio } from "../src/understand/gemini-audio.ts";
import { GeminiClient } from "../src/understand/gemini-client.ts";
import { priceUsage } from "../src/understand/vision/gemini.ts";
import { WORKSPACE_ROOT } from "../src/lib/workspace.ts";

export const UZ_SENTENCES = [
  "Gap shundaki, Tenstorrent degan startap 1,5 milliard dollar investitsiya koʻtardi.",
  "Bu — Nvidia bilan raqobatlashadigan AI chiplar ishlab chiqaradigan kompaniya.",
  "Eng qizigʻi — kompaniyani afsonaviy muhandis Jim Keller boshqaradi.",
  "Agar sizda startup boʻlsa, \"MAN\" soʻzini yozib qoldiringlar.",
];

export const UZ_STYLE = "an energetic young Uzbek tech-news host from Tashkent speaking natural colloquial Uzbek (not Turkish, not Kazakh); fast, confident, friendly; brand names in English";

/** lower-case word tokens with the Uzbek apostrophes unified and digits kept */
export function tokensUz(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/[ʻʼ'‘’`]/g, "'")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/[^\p{L}\p{N}'.\s-]/gu, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** word error rate (Levenshtein over tokens) */
export function wer(ref: string[], hyp: string[]): number {
  const d = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...new Array<number>(hyp.length).fill(0)]);
  for (let j = 1; j <= hyp.length; j++) d[0][j] = j;
  for (let i = 1; i <= ref.length; i++) for (let j = 1; j <= hyp.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  return ref.length ? d[ref.length][hyp.length] / ref.length : 0;
}

interface Judge {
  heard: string;
  language_heard: string;
  intelligibility: number;
  naturalness: number;
  accent: string;
  issues: { word: string; heard_as: string; problem: string }[];
  verdict: string;
}

async function judgeUz(file: string, intended: string, client: GeminiClient): Promise<Judge & { model: string; usd: number }> {
  const schema = {
    type: "OBJECT",
    properties: {
      heard: { type: "STRING" },
      language_heard: { type: "STRING" },
      intelligibility: { type: "NUMBER" },
      naturalness: { type: "NUMBER" },
      accent: { type: "STRING" },
      issues: { type: "ARRAY", items: { type: "OBJECT", properties: { word: { type: "STRING" }, heard_as: { type: "STRING" }, problem: { type: "STRING" } }, required: ["word", "heard_as", "problem"] } },
      verdict: { type: "STRING" },
    },
    required: ["heard", "language_heard", "intelligibility", "naturalness", "accent", "issues", "verdict"],
  };
  const system =
    "You are a strict native Uzbek listener from Tashkent who edits voice-overs for Uzbek Instagram tech reels. You judge synthetic speech honestly: " +
    "Is it clearly Uzbek, or does it sound like Turkish, Kazakh, Russian-accented or English-accented reading? Are oʻ, gʻ, q, x, h pronounced the Uzbek way? " +
    "Are the numbers said with correct Uzbek words and endings? Would an Uzbek viewer accept it as a normal Uzbek narrator, or find it foreign/robotic?";
  const user = `Intended text (Uzbek Latin):\n${intended}\n\n1) "heard": write exactly what you hear, in Uzbek Latin, numbers as words if the endings matter.\n2) "language_heard": which language/accent it sounds like.\n3) "intelligibility" 1–10: how much an Uzbek viewer understands without reading.\n4) "naturalness" 1–10: how natural as an Uzbek reels narrator.\n5) "accent": describe the accent in one sentence.\n6) "issues": every mispronounced, wrongly stressed, foreign-sounding or skipped word.\n7) "verdict": acceptable / borderline / not acceptable for publishing, with one reason.`;
  const r = await client.generate(audioModels(), { system, parts: [await inlineAudio(file), { text: user }], schema, temperature: 0.1, rounds: 1 });
  return { ...(r.data as Judge), model: r.model, usd: priceUsage(r.model, r.usage).usd };
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("uz-tts-eval.ts")) {
  try {
    process.loadEnvFile();
  } catch {}
  const args = process.argv.slice(2);
  const vi = args.indexOf("--voices");
  const voices = vi >= 0 ? args[vi + 1].split(",") : ["Charon", "Kore", "Puck", "Fenrir"];
  const outDir = args.find((a, i) => !a.startsWith("--") && i !== vi + 1) ?? path.join(WORKSPACE_ROOT, "abror_tts_eval");
  await fs.mkdir(outDir, { recursive: true });
  const key = geminiApiKey();
  if (!key) throw new Error("нет GEMINI_API_KEY");
  const client = new GeminiClient({ apiKey: key, rounds: 1, roundWaitMs: 20_000, onLog: (l) => console.log(`  ${l}`) });
  const text = UZ_SENTENCES.join(" ");
  const report: unknown[] = [];
  let usd = 0;
  for (const v of voices) {
    console.log(`▸ ${v}`);
    try {
      const a = await geminiTts(text, v, { style: UZ_STYLE, onEvent: (l) => console.log(l) });
      const file = path.join(outDir, `uz_${v}.wav`);
      await fs.writeFile(file, wavBytes(a.pcm, a.rate));
      const seconds = a.pcm.length / a.rate;
      // blind transcript: no hint, the language is whatever the model hears
      const tr = await transcribeAudio(file, {});
      const heard = tr.segments.map((s) => s.text).join(" ");
      const langs = [...new Set(tr.segments.map((s) => s.language))];
      const w = wer(tokensUz(text), tokensUz(heard));
      const j = await judgeUz(file, text, client);
      usd += tr.usd + j.usd;
      const row = { voice: v, model: a.model, seconds: Math.round(seconds * 10) / 10, words_per_min: Math.round((tokensUz(text).length / seconds) * 60), transcript: heard, transcript_languages: langs, wer: Math.round(w * 1000) / 10, judge: j };
      report.push(row);
      console.log(`  ${a.model} ${seconds.toFixed(1)} s · WER ${(w * 100).toFixed(1)} % · языки ${langs.join(",")} · понятность ${j.intelligibility}/10 · естественность ${j.naturalness}/10 · «${j.language_heard}» · ${j.verdict}`);
      console.log(`  слышит: ${heard}`);
      for (const x of j.issues.slice(0, 8)) console.log(`    - ${x.word} → ${x.heard_as}: ${x.problem}`);
    } catch (err) {
      console.log(`  ✗ ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      report.push({ voice: v, error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
    }
  }
  await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify({ text, style: UZ_STYLE, usd: Math.round(usd * 1e4) / 1e4, takes: report }, null, 1));
  console.log(`→ ${path.join(outDir, "report.json")} (≈$${usd.toFixed(4)})`);
}
