import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addCost } from "../lib/cost.ts";
import { ffmpeg, ffprobe } from "../lib/ffmpeg.ts";
import { selectStructuredLlm, type StructuredFn } from "../lib/llm.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { createJob, exists, jobDir, writeJson } from "../lib/workspace.ts";
import { writeZip, type ZipInput } from "../lib/zip.ts";
import { ANIMATE_DEFAULTS, AvatarScriptSchema, AvatarStateSchema, TTS_DEFAULTS, TTS_LANGUAGES, type AvatarMode, type AvatarScript, type AvatarState } from "./schema.ts";
import { classifyAvatarInput, estimateSeconds, linesFromText, writeMonologue } from "./script.ts";
import { getVoice, languageCode, requireVoice, type VoiceDef } from "../voice/catalog.ts";
import { synthesize, type SentenceSynth } from "../voice/piper.ts";

/**
 * `vedit avatar export` / Telegram /avatar: everything the Colab notebook needs in one avatar_job.zip
 * (script.json, portrait.png, optional voice_ref.wav / speech_in.wav, and vedit_avatar.py itself, so
 * the user uploads a single file). The job is created here; `vedit avatar import` later puts the
 * talking-head video into the same job and runs the montage on it.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SIDECAR = path.join(ROOT, "tools", "avatar", "vedit_avatar.py");
export const NOTEBOOK = path.join(ROOT, "tools", "avatar", "colab_vedit_avatar.ipynb");
export const NOTEBOOK_NAME = "colab_vedit_avatar.ipynb";
/** longest portrait side sent to Colab (JoyVASA resizes to ≤ 1280 anyway) */
export const PORTRAIT_MAX = 1280;
/** voice reference: Chatterbox conditions on ≤ 10 s; a little more leaves room for trimmed silence */
export const VOICE_REF_SECONDS = 12;
/** what a Piper voice reads to become a Chatterbox cloning reference (~8–10 s of calm speech) */
export const REF_TEXT: Record<string, string> = {
  ru: "Привет! Сегодня я коротко расскажу, как это устроено и почему это важно. Без воды, только главное, так что оставайтесь со мной до конца.",
  en: "Hi! Today I will briefly explain how this works and why it matters. No fluff, only the essentials, so stay with me until the end.",
};

export interface AvatarExportOptions {
  /** the words, as written by the user */
  text?: string;
  /** …or a topic for Claude to write a monologue about */
  topic?: string;
  /** free input from the bot: classified into text or topic */
  input?: string;
  photo?: string;
  /** reference clip for voice cloning (any audio ffmpeg reads) */
  voice?: string;
  /** the user's own narration: TTS is skipped */
  speech?: string;
  /** a catalogue voice (vedit voices): Piper voices are synthesised here into speech_in.wav (Colab only animates);
   *  Chatterbox presets add a Piper-made voice_ref.wav. The user's own --voice / --speech win over it. */
  voiceId?: string;
  /** test hook: replaces the Piper call */
  voiceSynth?: SentenceSynth;
  language?: string;
  /** monologue length for a topic, s */
  seconds?: number;
  mode?: AvatarMode;
  /** generate a portrait when no photo is given (default true) */
  images?: boolean;
  llm?: StructuredFn;
  model?: string;
  /** test hook / alternative generator: writes a portrait image for `prompt` to `dest` */
  generatePortrait?: (prompt: string, dest: string) => Promise<void>;
  onEvent?: (line: string) => void;
  /** create the job under this source label (bot: "_bot/<chat>/avatar") */
  sourceLabel?: string;
}

export interface AvatarExportResult {
  jobId: string;
  bundle: string;
  bytes: number;
  script: AvatarScript;
  state: AvatarState;
  warnings: string[];
}

/** Any image → RGB PNG, longest side ≤ PORTRAIT_MAX, even dimensions. */
export async function preparePortrait(src: string, dest: string): Promise<{ width: number; height: number }> {
  const scale = `scale='if(gte(iw,ih),min(${PORTRAIT_MAX},iw),-2)':'if(gte(iw,ih),-2,min(${PORTRAIT_MAX},ih))':flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=rgb24`;
  await ffmpeg(["-i", src, "-frames:v", "1", "-vf", scale, dest]);
  const v = (await ffprobe(dest)).streams.find((s) => s.codec_type === "video");
  if (!v?.width || !v.height) throw new Error(`не удалось прочитать портрет ${src}`);
  if (Math.min(v.width, v.height) < 256) throw new Error(`портрет слишком маленький (${v.width}×${v.height}); нужно хотя бы 512 px по короткой стороне`);
  return { width: v.width, height: v.height };
}

/** Any audio → 24 kHz mono 16-bit WAV, leading silence removed, at most `maxSeconds`. Returns its length, s. */
export async function prepareAudio(src: string, dest: string, maxSeconds?: number): Promise<number> {
  const args = ["-i", src, "-vn", "-ac", "1", "-ar", "24000", "-af", "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1"];
  if (maxSeconds) args.push("-t", String(maxSeconds));
  await ffmpeg([...args, "-c:a", "pcm_s16le", dest]);
  const d = Number((await ffprobe(dest)).format.duration ?? 0);
  if (!(d > 0.3)) throw new Error(`в ${path.basename(src)} нет звука (после обрезки тишины ${d.toFixed(1)} с)`);
  return d;
}

/** Default portrait generator: one image through Antigravity's image tool (as `make` does), cover-cropped to 9:16. */
async function antigravityPortrait(prompt: string, dest: string): Promise<void> {
  const { generateImages } = await import("../make/images.ts");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-portrait-"));
  try {
    const r = await generateImages([{ beat: 0, prompt }], dir, { style: "photorealistic studio portrait photography, natural skin texture, soft key light" });
    const f = r.files.get(0);
    if (!f) throw new Error("генератор картинок не вернул портрет");
    await fs.copyFile(f, dest);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function exportAvatarJob(o: AvatarExportOptions): Promise<AvatarExportResult> {
  const say = o.onEvent ?? (() => {});
  const warnings: string[] = [];
  const mode: AvatarMode = o.mode ?? "avatar";
  const language = (o.language ?? "ru").toLowerCase();
  let text = o.text?.trim();
  let topic = o.topic?.trim();
  if (o.input?.trim()) {
    const c = classifyAvatarInput(o.input);
    if (c.kind === "topic") topic = c.value;
    else text = c.value;
  }
  if (!text && !topic && !o.speech) throw new Error("нужен текст (--text), тема (--topic) или своя запись речи (--speech)");
  const catalogVoice: VoiceDef | undefined = o.voiceId && !o.speech && !o.voice ? requireVoice(o.voiceId) : undefined;
  const localSpeech = catalogVoice?.engine === "piper";
  if (!o.speech && !localSpeech && !(TTS_LANGUAGES as readonly string[]).includes(language)) {
    throw new Error(`синтез речи не знает язык «${language}» (поддержаны: ${TTS_LANGUAGES.join(", ")}). Запишите голос сами и передайте --speech файл`);
  }
  if (mode === "avatar" && !o.photo && o.images === false && !o.generatePortrait) throw new Error("нужен портрет: --photo фото.jpg (генерация выключена --no-images)");
  for (const [flag, f] of [["--photo", o.photo], ["--voice", o.voice], ["--speech", o.speech]] as const) {
    if (f && !(await exists(f))) throw new Error(`${flag}: файл не найден: ${f}`);
  }

  const label = (topic ?? text ?? "своя запись").replace(/\s+/g, " ").slice(0, 80);
  const job = await createJob(o.sourceLabel ? `${o.sourceLabel}:${label}` : `avatar:${label}`, { prompt: topic ?? text?.slice(0, 500), preset: "split_news" });
  say(`job ${job.id}`);
  const dir = jobDir(job.id);
  const stage = path.join(dir, "avatar", "job");
  await fs.mkdir(stage, { recursive: true });

  // 1. words
  let lines: string[] = text ? linesFromText(text) : [];
  let title = "";
  let hashtags: string[] = [];
  if (!lines.length && topic && !o.speech) {
    say("▸ сценарий монолога…");
    const llm = o.llm ?? selectStructuredLlm();
    const r = await writeMonologue(topic, llm, { language, seconds: o.seconds ?? 40, model: o.model });
    lines = r.monologue.lines;
    title = r.monologue.title;
    hashtags = r.monologue.hashtags;
    await addCost(job.id, { step: "plan", provider: r.provider === "anthropic" ? "anthropic" : r.provider, model: r.model, units: { ...r.usage, calls: 1, avatar_script: 1, estimate: r.estimate ? 1 : 0 }, usd: r.usd });
    say(`  ${lines.length} строк, ≈${estimateSeconds(lines).toFixed(0)} с речи`);
  }
  if (!title) title = (topic ?? lines[0] ?? "").slice(0, 40);

  // 2. portrait
  let portrait: AvatarState["portrait"] = "none";
  if (mode === "avatar") {
    const png = path.join(stage, "portrait.png");
    if (o.photo) {
      const d = await preparePortrait(o.photo, png);
      portrait = "photo";
      if (d.height < d.width) warnings.push(`горизонтальное фото ${d.width}×${d.height}: для рилса лучше вертикальный портрет`);
    } else {
      say("▸ портрет ведущего (вымышленный человек)…");
      const raw = path.join(stage, "portrait_raw.jpg");
      const prompt = fill(loadPrompt("avatar.portrait"), { topic: topic ?? title });
      try {
        await (o.generatePortrait ?? antigravityPortrait)(prompt, raw);
      } catch (err) {
        throw new Error(`портрет не сгенерирован (${err instanceof Error ? err.message.split("\n")[0] : err}); пришлите своё фото: --photo фото.jpg`);
      }
      await preparePortrait(raw, png);
      await fs.rm(raw, { force: true });
      portrait = "generated";
      await addCost(job.id, { step: "design", provider: "antigravity-cli", model: "image", units: { images: 1, subscription: 1 }, usd: 0 });
    }
  }

  // 3. voice
  let voice: AvatarState["voice"] = "default";
  let voiceRef: string | undefined;
  let speech: string | undefined;
  let speechMeta: AvatarScript["speech_meta"];
  if (o.speech) {
    const d = await prepareAudio(o.speech, path.join(stage, "speech_in.wav"));
    speech = "speech_in.wav";
    voice = "own-recording";
    if (d > 180) warnings.push(`запись ${d.toFixed(0)} с — в Colab анимация займёт ~${Math.ceil(d / 20)} кусков; для рилса хватит 30–60 с`);
  } else if (o.voice) {
    const d = await prepareAudio(o.voice, path.join(stage, "voice_ref.wav"), VOICE_REF_SECONDS);
    voiceRef = "voice_ref.wav";
    voice = "clone";
    if (d < 5) warnings.push(`образец голоса всего ${d.toFixed(1)} с — клон будет неточным, лучше 5–10 с чистой речи`);
    warnings.push("образец голоса должен быть на том же языке, что и текст (иначе появится акцент)");
  } else if (catalogVoice?.engine === "piper") {
    // the whole speech is made here, on the CPU: the notebook skips Chatterbox entirely
    if (!lines.length) throw new Error("нечего озвучивать: нет текста");
    if (catalogVoice.language !== languageCode(language)) warnings.push(`голос ${catalogVoice.id} говорит на «${catalogVoice.language}», а текст на «${language}» — будет акцент`);
    say(`▸ речь локально (Piper, ${catalogVoice.id})…`);
    const raw = path.join(stage, "piper_speech.wav");
    const r = await synthesize(lines, catalogVoice.id, raw, { synth: o.voiceSynth, onEvent: (l) => say(`  ${l.trim()}`) });
    await ffmpeg(["-i", raw, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", path.join(stage, "speech_in.wav")]);
    await fs.rm(raw, { force: true });
    speech = "speech_in.wav";
    voice = "library";
    speechMeta = { engine: "piper", voice: catalogVoice.id, model: catalogVoice.piper?.key ?? "", license: catalogVoice.license, lines: r.lines };
    await addCost(job.id, { step: "design", provider: "piper (local)", model: catalogVoice.piper?.key ?? catalogVoice.id, units: { voice_seconds: r.duration }, usd: 0 });
  } else if (catalogVoice?.refFrom) {
    // a Chatterbox clone preset: Piper reads a neutral paragraph, Chatterbox clones that timbre in Colab
    const src = getVoice(catalogVoice.refFrom);
    if (!src) throw new Error(`голос ${catalogVoice.id}: нет источника ${catalogVoice.refFrom}`);
    say(`▸ образец голоса ${src.id} для клона (Piper)…`);
    const raw = path.join(stage, "piper_ref.wav");
    await synthesize(REF_TEXT[src.language] ?? REF_TEXT.en, src.id, raw, { synth: o.voiceSynth, onEvent: (l) => say(`  ${l.trim()}`) });
    await prepareAudio(raw, path.join(stage, "voice_ref.wav"), VOICE_REF_SECONDS);
    await fs.rm(raw, { force: true });
    voiceRef = "voice_ref.wav";
    voice = "clone";
    if (src.language !== languageCode(language)) warnings.push(`образец ${src.id} на «${src.language}», текст на «${language}» — будет акцент`);
  }

  const script = AvatarScriptSchema.parse({
    version: 1,
    job: job.id,
    title,
    language,
    lines,
    ...(voiceRef ? { voice_ref: voiceRef } : {}),
    ...(speech ? { speech } : {}),
    ...(speechMeta ? { speech_meta: speechMeta } : {}),
    ...(catalogVoice ? { voice_id: catalogVoice.id } : {}),
    portrait: "portrait.png",
    mode,
    tts: TTS_DEFAULTS,
    animate: ANIMATE_DEFAULTS,
  });
  await fs.writeFile(path.join(stage, "script.json"), JSON.stringify(script, null, 2));

  // 4. bundle
  const entries: ZipInput[] = [{ name: "script.json", file: path.join(stage, "script.json") }];
  if (mode === "avatar") entries.push({ name: "portrait.png", file: path.join(stage, "portrait.png"), store: true });
  if (voiceRef) entries.push({ name: voiceRef, file: path.join(stage, voiceRef) });
  if (speech) entries.push({ name: speech, file: path.join(stage, speech) });
  entries.push({ name: "vedit_avatar.py", file: SIDECAR });
  const bundle = path.join(dir, "avatar_job.zip");
  const { bytes } = await writeZip(bundle, entries);

  const state = await writeJson(path.join(dir, "avatar.json"), AvatarStateSchema, {
    job: job.id,
    created_at: new Date().toISOString(),
    source: o.speech ? "recording" : text ? "text" : "topic",
    ...(topic ? { topic } : {}),
    title,
    language,
    lines,
    hashtags,
    mode,
    portrait,
    voice,
    ...(catalogVoice ? { voice_id: catalogVoice.id } : {}),
    bundle,
    bundle_bytes: bytes,
    estimated_seconds: lines.length ? estimateSeconds(lines) : 0,
    warnings,
  });
  return { jobId: job.id, bundle, bytes, script, state, warnings };
}

/** What to do with avatar_job.zip, for the CLI and the bot. */
export function colabSteps(jobId: string, bundle = "avatar_job.zip"): string[] {
  return [
    `1. Откройте в Google Colab ноутбук tools/avatar/${NOTEBOOK_NAME} (File → Upload notebook).`,
    "2. Runtime → Change runtime type → T4 GPU, затем Runtime → Run all.",
    `3. Когда ячейка «Загрузка» попросит файл — выберите ${bundle}.`,
    "4. Первый запуск ставит окружения и качает модели (~10 минут), дальше — 2–5 минут на ролик.",
    "5. В конце скачается avatar_result.zip.",
    `6. Монтаж: vedit avatar import ${jobId} avatar_result.zip (или пришлите архив боту).`,
  ];
}
