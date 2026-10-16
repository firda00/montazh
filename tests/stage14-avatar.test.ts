// Stage 14: talking-head avatars. Bundle export (script.json, portrait, voice reference), result import
// (validated against a synthetic ffmpeg talking-head stand-in), the Colab notebook's structure, the sidecar's
// own selftest (fake TTS/animation), bot routing. No network, no Colab, no models.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-avatar-ws-"));

const { ffmpeg, ffprobe } = await import("../src/lib/ffmpeg.ts");
const { writeZip, readZip } = await import("../src/lib/zip.ts");
const { createJob, jobDir, readJson } = await import("../src/lib/workspace.ts");
const { loadPrompt, fill } = await import("../src/lib/prompts.ts");
const { CostSchema } = await import("../src/schemas/index.ts");
const { AvatarScriptSchema, AvatarStateSchema, TTS_LANGUAGES } = await import("../src/avatar/schema.ts");
const { classifyAvatarInput, linesFromText, estimateSeconds, writeMonologue } = await import("../src/avatar/script.ts");
const { exportAvatarJob, SIDECAR, NOTEBOOK, colabSteps } = await import("../src/avatar/export.ts");
const { importAvatarResult, scriptMatch, AvatarImportError, defaultAvatarPrompt } = await import("../src/avatar/import.ts");
const { createBot, isAvatarResult, MSG } = await import("../src/bot/index.ts");
const { MODULES } = await import("../src/modules.ts");
type StructuredFn = import("../src/lib/llm.ts").StructuredFn;
type CallMethod = import("../src/bot/telegram-api.ts").CallMethod;
type TgUpdate = import("../src/bot/telegram-api.ts").TgUpdate;
type TgMessage = import("../src/bot/telegram-api.ts").TgMessage;

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-avatar-"));
const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 };

async function photo(name = "face.png", size = "600x900") {
  const f = path.join(tmp, name);
  await ffmpeg(["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=1`, "-frames:v", "1", f]);
  return f;
}

/** a talking-head stand-in: test pattern + a 220 Hz tone with a syllable-like tremolo */
async function talkingHead(dest: string, seconds: number, opts: { audio?: boolean; size?: string } = {}) {
  const args = ["-f", "lavfi", "-i", `testsrc2=size=${opts.size ?? "720x1280"}:rate=25:duration=${seconds}`];
  if (opts.audio !== false) args.push("-f", "lavfi", "-i", `sine=frequency=220:duration=${seconds},tremolo=f=4:d=0.9`);
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (opts.audio !== false) args.push("-c:a", "aac", "-shortest");
  await ffmpeg([...args, dest]);
}

function python(): string | null {
  for (const bin of ["python", "python3"]) {
    const r = spawnSync(bin, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "3") return bin;
  }
  return null;
}

test("script: text → lines, topic vs text, speech estimate, prompts load and fill", () => {
  assert.deepEqual(linesFromText("Привет!\n\nЭто первый абзац.\nА это второй."), ["Привет!", "Это первый абзац.", "А это второй."]);
  const long = Array.from({ length: 12 }, (_, i) => `Предложение номер ${i + 1} про кофе и цены.`).join(" ");
  const split = linesFromText(long, 120);
  assert.ok(split.length > 2 && split.every((l) => l.length <= 120), JSON.stringify(split));
  assert.equal(split.join(" "), long);
  assert.deepEqual(classifyAvatarInput("почему кофе дорожает"), { kind: "topic", value: "почему кофе дорожает" });
  assert.equal(classifyAvatarInput("Привет! Сегодня расскажу, почему кофе дорожает.").kind, "text");
  assert.deepEqual(classifyAvatarInput("текст: Коротко"), { kind: "text", value: "Коротко" });
  assert.deepEqual(classifyAvatarInput("Тема: Очень длинная тема из многих слов про то как устроен мир и почему всё так дорого сейчас стало"), { kind: "topic", value: "Очень длинная тема из многих слов про то как устроен мир и почему всё так дорого сейчас стало" });
  assert.ok(Math.abs(estimateSeconds(["а".repeat(140), "б".repeat(70)]) - (15 + 0.45 + 0.3)) < 0.1);
  assert.match(loadPrompt("avatar.script.system"), /talking-head/);
  assert.match(fill(loadPrompt("avatar.script.user"), { topic: "кофе", language: "Russian", seconds: 40, words: 100, lines: 8, audience: "все" }), /TOPIC: кофе[\s\S]*about 40 seconds/);
  assert.match(fill(loadPrompt("avatar.portrait"), { topic: "кофе" }), /fictional[\s\S]*not resembling any real or famous/);
});

test("writeMonologue: structured call with the avatar prompts, normalised lines", async () => {
  let seen: Parameters<StructuredFn>[0] | undefined;
  const llm: StructuredFn = async (q) => {
    seen = q;
    return { data: { title: "Кофе **дорожает**", language: "Russian", lines: ["Кофе подорожал на треть.", "  ", "Вот почему. Урожай упал."], hashtags: ["#Кофе", "цены"] }, usage, usd: 0.03, estimate: false, model: "m", provider: "mock" };
  };
  const r = await writeMonologue("почему кофе дорожает", llm, { language: "ru", seconds: 30 });
  assert.match(seen!.system, /talking-head presenter/);
  assert.match(seen!.prompt, /TOPIC: почему кофе дорожает\nLANGUAGE: Russian/);
  assert.deepEqual(r.monologue.lines, ["Кофе подорожал на треть.", "Вот почему. Урожай упал."]);
  assert.equal(r.monologue.title, "Кофе дорожает");
  assert.equal(r.monologue.language, "ru", "the requested code, not the model's language name");
  assert.deepEqual(r.monologue.hashtags, ["кофе", "цены"]);
});

test("zip: round trip with UTF-8 names, stored and deflated entries; Python's zipfile reads it", async () => {
  const z = path.join(tmp, "t.zip");
  await writeZip(z, [{ name: "script.json", data: JSON.stringify({ a: "привет" }) }, { name: "папка/файл.txt", data: "x".repeat(5000) }, { name: "raw.bin", data: Buffer.from([1, 2, 3]), store: true }]);
  const m = await readZip(z);
  assert.deepEqual([...m.keys()], ["script.json", "папка/файл.txt", "raw.bin"]);
  assert.equal(JSON.parse(m.get("script.json")!.toString()).a, "привет");
  assert.equal(m.get("папка/файл.txt")!.length, 5000);
  await assert.rejects(writeZip(path.join(tmp, "bad.zip"), [{ name: "../evil", data: "x" }]), /недопустимое/);
  const py = python();
  if (py) {
    const r = spawnSync(py, ["-c", "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print('|'.join(z.namelist()))", z], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "script.json|папка/файл.txt|raw.bin");
  }
});

test("exportAvatarJob: text + photo + voice → avatar_job.zip with script.json, portrait, 24 kHz voice_ref ≤ 12 s, sidecar", async () => {
  const face = await photo("face.png", "900x1600");
  const voice = path.join(tmp, "voice.ogg");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=180:duration=20", "-c:a", "libopus", "-b:a", "48k", voice]);
  const r = await exportAvatarJob({ text: "Привет! Это аватар.\nВторой абзац про кофе.", photo: face, voice, language: "ru" });
  const entries = await readZip(r.bundle);
  assert.deepEqual([...entries.keys()].sort(), ["portrait.png", "script.json", "vedit_avatar.py", "voice_ref.wav"]);
  const script = AvatarScriptSchema.parse(JSON.parse(entries.get("script.json")!.toString("utf8")));
  assert.equal(script.job, r.jobId);
  assert.deepEqual(script.lines, ["Привет! Это аватар.", "Второй абзац про кофе."]);
  assert.equal(script.voice_ref, "voice_ref.wav");
  assert.equal(script.mode, "avatar");
  assert.equal(script.tts.cfg_weight, 0.4);
  assert.equal(script.animate.cfg_scale, 2);
  assert.equal(entries.get("vedit_avatar.py")!.toString("utf8"), await fs.readFile(SIDECAR, "utf8"));

  const stage = path.join(jobDir(r.jobId), "avatar", "job");
  const p = (await ffprobe(path.join(stage, "portrait.png"))).streams[0];
  assert.deepEqual([p.width, p.height], [720, 1280], "1600 px tall photo scaled to ≤ 1280");
  const v = await ffprobe(path.join(stage, "voice_ref.wav"));
  const a = v.streams.find((s) => s.codec_type === "audio") as { sample_rate?: string; channels?: number };
  assert.equal(a.sample_rate, "24000");
  assert.equal(a.channels, 1);
  assert.ok(Number(v.format.duration) <= 12.05 && Number(v.format.duration) > 11, String(v.format.duration));

  const state = await readJson(path.join(jobDir(r.jobId), "avatar.json"), AvatarStateSchema);
  assert.deepEqual([state.portrait, state.voice, state.source, state.mode], ["photo", "clone", "text", "avatar"]);
  assert.ok(state.warnings.some((w) => /том же языке/.test(w)));
  const job = await readJson(path.join(jobDir(r.jobId), "job.json"), (await import("../src/schemas/index.ts")).JobSchema);
  assert.match(job.source, /avatar:/);
  assert.equal(job.preset, "split_news");
  assert.match(colabSteps(r.jobId).join("\n"), new RegExp(`vedit avatar import ${r.jobId} avatar_result\\.zip`));
});

test("exportAvatarJob: topic → Claude monologue, generated fictional portrait; own recording; refusals", async () => {
  let portraitPrompt = "";
  const llm: StructuredFn = async () => ({ data: { title: "Кофе", language: "ru", lines: ["Кофе дорожает.", "Подпишитесь."], hashtags: [] }, usage, usd: 0.04, estimate: false, model: "m", provider: "anthropic" });
  const gen = async (prompt: string, dest: string) => {
    portraitPrompt = prompt;
    await ffmpeg(["-f", "lavfi", "-i", "color=c=gray:size=1080x1920", "-frames:v", "1", dest]);
  };
  const r = await exportAvatarJob({ input: "почему кофе дорожает", llm, generatePortrait: gen, language: "ru" });
  assert.match(portraitPrompt, /fictional[\s\S]*почему кофе дорожает/);
  assert.deepEqual(r.script.lines, ["Кофе дорожает.", "Подпишитесь."]);
  assert.equal(r.state.portrait, "generated");
  assert.equal(r.state.voice, "default");
  assert.equal(r.script.voice_ref, undefined);
  const cost = await readJson(path.join(jobDir(r.jobId), "cost.json"), CostSchema);
  assert.ok(cost.entries.some((e) => e.units.avatar_script === 1 && e.usd === 0.04));

  // own recording, voice only: no portrait, no TTS language check (Uzbek is fine)
  const rec = path.join(tmp, "rec.wav");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=200:duration=5", rec]);
  const own = await exportAvatarJob({ speech: rec, language: "uz", mode: "voice_only" });
  const names = [...(await readZip(own.bundle)).keys()].sort();
  assert.deepEqual(names, ["script.json", "speech_in.wav", "vedit_avatar.py"]);
  assert.equal(own.script.speech, "speech_in.wav");
  assert.equal(own.state.voice, "own-recording");

  assert.ok(!(TTS_LANGUAGES as readonly string[]).includes("uz"));
  await assert.rejects(exportAvatarJob({ text: "Salom!", language: "uz", photo: await photo("f2.png") }), /не знает язык «uz»/);
  await assert.rejects(exportAvatarJob({ text: "Привет", images: false }), /нужен портрет/);
  await assert.rejects(exportAvatarJob({ language: "ru" }), /нужен текст/);
});

test("importAvatarResult: synthetic talking head accepted and placed as the job's source; bad results refused", async () => {
  const face = await photo("face3.png");
  const exp = await exportAvatarJob({ text: "Кофе дорожает. Урожай упал.", photo: face });
  const video = path.join(tmp, "avatar.mp4");
  await talkingHead(video, 6);
  const meta = { version: 1, job: exp.jobId, mode: "avatar", language: "ru", duration: 6, lines: [{ i: 0, text: "Кофе дорожает. Урожай упал.", start: 0, end: 5.7 }], fps: 25, width: 720, height: 1280, tts: { engine: "chatterbox-multilingual", voice: "default", wall_seconds: 20 }, animate: { engine: "joyvasa", device: "Tesla T4", wall_seconds: 70, chunks: [{ start: 0, end: 6 }] } };
  const speech = path.join(tmp, "speech.wav");
  await ffmpeg(["-i", video, "-vn", "-ac", "1", "-ar", "24000", speech]);
  const zip = path.join(tmp, "avatar_result.zip");
  await writeZip(zip, [{ name: "avatar.mp4", file: video, store: true }, { name: "speech.wav", file: speech }, { name: "meta.json", data: JSON.stringify(meta) }]);

  const r = await importAvatarResult(exp.jobId, zip);
  assert.equal(r.warnings.length, 0);
  assert.deepEqual([r.width, r.height], [720, 1280]);
  assert.ok(Math.abs(r.duration - 6) < 0.1);
  assert.equal(r.video, path.join(jobDir(exp.jobId), "avatar.mp4"));
  await fs.access(path.join(jobDir(exp.jobId), "avatar", "result", "meta.json"));
  const st = await readJson(path.join(jobDir(exp.jobId), "avatar.json"), AvatarStateSchema);
  assert.ok(st.imported_at && st.meta?.animate?.engine === "joyvasa");
  const cost = await readJson(path.join(jobDir(exp.jobId), "cost.json"), CostSchema);
  assert.ok(cost.entries.some((e) => e.provider === "colab" && e.usd === 0 && e.units.gpu === 1));

  // a result made for another job: imported with a warning
  const other = await createJob("C:/x/other.mp4");
  assert.match((await importAvatarResult(other.id, zip)).warnings[0], /сделан для задачи/);

  const bad = async (name: string, files: Parameters<typeof writeZip>[1]) => {
    const f = path.join(tmp, name);
    await writeZip(f, files);
    return importAvatarResult(exp.jobId, f);
  };
  await assert.rejects(bad("r1.zip", [{ name: "avatar.mp4", file: video, store: true }, { name: "meta.json", data: JSON.stringify({ ...meta, duration: 9 }) }]), (e: unknown) => e instanceof AvatarImportError && e.code === "video" && /не совпадает/.test(e.message));
  const mute = path.join(tmp, "mute.mp4");
  await talkingHead(mute, 6, { audio: false });
  await assert.rejects(bad("r2.zip", [{ name: "avatar.mp4", file: mute, store: true }, { name: "meta.json", data: JSON.stringify(meta) }]), /нет звука/);
  await assert.rejects(bad("r3.zip", [{ name: "speech.wav", file: speech }, { name: "meta.json", data: JSON.stringify({ ...meta, mode: "voice_only" }) }]), (e: unknown) => e instanceof AvatarImportError && e.code === "voice_only");
  await assert.rejects(bad("r4.zip", [{ name: "avatar.mp4", file: video, store: true }]), /нет meta\.json/);
  // a folder with one top-level directory inside the zip also works
  const nested = path.join(tmp, "nested.zip");
  await writeZip(nested, [{ name: "out/avatar.mp4", file: video, store: true }, { name: "out/meta.json", data: JSON.stringify(meta) }]);
  assert.equal((await importAvatarResult(exp.jobId, nested)).width, 720);
  assert.match(defaultAvatarPrompt(17), /примерно 16 секунд из всего монолога/);
});

test("scriptMatch: share of the script's words heard by whisper", () => {
  const t = { language: "ru", segments: [{ start: 0, end: 2, text: "Кофе дорожает. Урожай упал", words: [] }] } as never;
  assert.deepEqual(scriptMatch(["Кофе дорожает.", "Урожай упал, цены растут."], t), { words: 6, matched: 4, ratio: 0.67 });
});

test("sidecar selftest: fake TTS + fake animation, chunking at pauses, concat, mux, zip, re-run skip", { timeout: 120_000 }, (t) => {
  const py = python();
  if (!py) return t.skip("python не найден");
  const r = spawnSync(py, [SIDECAR, "selftest"], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr.slice(-2000)}`);
  assert.match(r.stdout, /selftest ok/);
});

test("Colab notebook: valid nbformat 4, requirements embedded verbatim, sidecar commands that exist, JoyVASA pinned", async () => {
  const nb = JSON.parse(await fs.readFile(NOTEBOOK, "utf8"));
  assert.equal(nb.nbformat, 4);
  assert.equal(nb.metadata.accelerator, "GPU");
  assert.equal(nb.metadata.colab.gpuType, "T4");
  const code = nb.cells.filter((c: { cell_type: string }) => c.cell_type === "code");
  for (const c of nb.cells) {
    assert.ok(Array.isArray(c.source) && c.source.every((s: unknown) => typeof s === "string"));
    if (c.cell_type === "code") assert.ok(Array.isArray(c.outputs) && c.outputs.length === 0 && c.execution_count === null);
  }
  const all = code.map((c: { source: string[] }) => c.source.join("")).join("\n");
  for (const name of ["tts", "joyvasa"]) {
    const req = (await fs.readFile(path.join(path.dirname(NOTEBOOK), `requirements-${name}.txt`), "utf8")).replace(/\r\n/g, "\n").trim();
    assert.ok(all.includes(req), `requirements-${name}.txt is embedded as is`);
  }
  for (const cmd of ["'tts'", "'animate'", "'finalize'"]) assert.ok(all.includes(cmd), cmd);
  const sidecar = await fs.readFile(SIDECAR, "utf8");
  for (const cmd of ["tts", "animate", "finalize", "pipeline", "selftest"]) assert.match(sidecar, new RegExp(`add_parser\\("${cmd}"`));
  assert.match(all, /JOYVASA_COMMIT = '[0-9a-f]{40}'/);
  assert.match(all, /allow_patterns=\['insightface\/models\/buffalo_l\/\*', 'liveportrait\/base_models\/\*'/);
  const patterns = all.split("\n").filter((l: string) => /allow_patterns/.test(l)).join("\n");
  assert.ok(patterns && !/xpose|animals/i.test(patterns), "no animal mode / XPose downloads");
  assert.match(all, /uv', 'venv'/);
  const md = nb.cells.filter((c: { cell_type: string }) => c.cell_type === "markdown").map((c: { source: string[] }) => c.source.join("")).join("\n");
  assert.match(md, /InsightFace[\s\S]*некоммерческих/);
  assert.match(md, /Perth/);
});

test("registry: avatar module with licences, InsightFace marked non-commercial with a TODO", () => {
  const m = MODULES.find((x) => x.id === "avatar")!;
  assert.ok(m);
  assert.equal(m.stage, "source");
  assert.ok(m.backends.some((b) => b.id === "insightface" && /некоммерческ/i.test(b.license) && /TODO/.test(b.license) && /MediaPipe/.test(b.license)));
  assert.ok(m.backends.some((b) => b.id === "chatterbox" && /MIT/.test(b.license) && /Perth/.test(b.license)));
  assert.ok(m.backends.some((b) => b.id === "joyvasa" && /MIT/.test(b.license)));
  assert.ok(m.job!({ id: "x", created_at: "", source: "C:/repo/avatar:кофе", steps: {} }));
  const cli = MODULES.find((x) => x.id === "cli")!;
  assert.ok(!cli.job!({ id: "x", created_at: "", source: "C:/repo/avatar:кофе", steps: {} }));
});

// ── bot ──────────────────────────────────────────────────────────────────────

function fakeApi(files: Map<string, string>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const callMethod: CallMethod = async <T,>(_t: string, method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    if (method === "getFile") return { file_id: params.file_id, file_size: 1000, file_path: `docs/${params.file_id}` } as T;
    if (method === "sendChatAction") return true as T;
    return { message_id: calls.length, chat: { id: params.chat_id, type: "private" } } as T;
  };
  const download = async (_t: string, file: { file_id: string }, dest: string) => {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const src = files.get(file.file_id);
    if (src) await fs.copyFile(src, dest);
    else await fs.writeFile(dest, "data");
  };
  const texts = () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.params.text));
  return { calls, callMethod, download, texts };
}

let nextId = 1;
const msg = (m: Partial<TgMessage>): TgUpdate => ({ update_id: nextId++, message: { message_id: nextId, chat: { id: 7, type: "private" }, from: { id: 1 }, ...m } });

test("bot: photo + voice are kept for /avatar; /avatar sends avatar_job.zip; avatar_result*.zip is routed to the montage", async () => {
  assert.ok(isAvatarResult("avatar_result.zip") && isAvatarResult("avatar_result (1).zip") && isAvatarResult("AVATAR_RESULT-2.zip"));
  assert.ok(!isAvatarResult("avatar_job.zip") && !isAvatarResult("result.zip") && !isAvatarResult("avatar_result.zip.exe"));

  const job = await createJob("C:/bot/avatar:кофе", { preset: "split_news" });
  const resultZip = path.join(tmp, "bot_result.zip");
  await writeZip(resultZip, [{ name: "meta.json", data: JSON.stringify({ version: 1, job: job.id, mode: "avatar", duration: 5, tts: {} }) }]);
  const fake = fakeApi(new Map([["doc-result", resultZip]]));
  const exports: { input: string; photo?: string; voice?: string; sourceLabel: string }[] = [];
  const imports: { jobId: string; result: string; preset: string; instruction?: string }[] = [];
  const bot = await createBot({
    token: "t",
    workspace: await fs.mkdtemp(path.join(os.tmpdir(), "vedit-avatar-bot-")),
    callMethod: fake.callMethod,
    download: fake.download,
    onLog: () => {},
    onboarding: false,
    quotas: false,
    cleanupIntervalMs: 0,
    avatarExport: async (a) => {
      exports.push({ input: a.input, photo: a.photo, voice: a.voice, sourceLabel: a.sourceLabel });
      a.onJob(job.id);
      return { jobId: job.id, outputs: [], documents: [{ file: resultZip, caption: "avatar_job.zip" }], message: MSG.avatarInstructions(job.id, ["Привет"], []) };
    },
    avatarImport: async (a) => {
      imports.push({ jobId: a.jobId, result: a.result, preset: a.preset, instruction: a.instruction });
      return { jobId: a.jobId, outputs: [] };
    },
    pipeline: async () => {
      throw new Error("montage pipeline must not run");
    },
  });

  await bot.handleUpdate(msg({ photo: [{ file_id: "ph-small", width: 90, height: 160 }, { file_id: "ph-big", width: 720, height: 1280 }] }));
  await bot.handleUpdate(msg({ voice: { file_id: "vo-1", duration: 7, mime_type: "audio/ogg" } }));
  assert.ok(fake.texts().includes(MSG.avatarPhotoSaved) && fake.texts().includes(MSG.avatarVoiceSaved));
  assert.match(bot.session(1).avatar_photo!, /avatar_photo_ph-big\.jpg$/);

  await bot.handleUpdate(msg({ text: "/avatar почему кофе дорожает" }));
  await bot.idle();
  assert.equal(exports.length, 1);
  assert.equal(exports[0].input, "почему кофе дорожает");
  assert.match(exports[0].photo!, /ph-big/);
  assert.match(exports[0].voice!, /vo-1/);
  assert.match(exports[0].sourceLabel, /users[\\/]1[\\/]avatar$/);
  assert.ok(fake.calls.some((c) => c.method === "sendDocument"), "the bundle goes out as a document");
  assert.ok(fake.texts().some((t) => /Задание для аватара готово/.test(t) && /Run all/.test(t)));
  assert.ok(!fake.texts().some((t) => /^Готово: /.test(t)), "no 'Готово: 0 роликов' after an export");
  assert.equal(bot.session(1).avatar_job, job.id);

  await bot.handleUpdate(msg({ document: { file_id: "doc-result", file_name: "avatar_result (1).zip", mime_type: "application/zip" }, caption: "как у aleko, 20 секунд" }));
  await bot.idle();
  assert.deepEqual(imports.map((i) => [i.jobId, i.preset, i.instruction]), [[job.id, "split_news", "как у aleko, 20 секунд"]]);
  assert.ok(fake.texts().includes(MSG.avatarImportStart(job.id)));

  // other documents keep the old answer; /avatar without text explains itself; reset forgets the media
  await bot.handleUpdate(msg({ document: { file_id: "doc-x", file_name: "notes.pdf", mime_type: "application/pdf" } }));
  assert.equal(fake.texts().at(-1), MSG.notVideo);
  await bot.handleUpdate(msg({ text: "/avatar" }));
  assert.equal(fake.texts().at(-1), MSG.avatarUsage);
  await bot.handleUpdate(msg({ text: "/avatar сброс" }));
  assert.equal(fake.texts().at(-1), MSG.avatarReset);
  assert.equal(bot.session(1).avatar_photo, undefined);
  await bot.idle();
});

test("bot: a result zip without a known job asks for /avatar first", async () => {
  const zip = path.join(tmp, "orphan.zip");
  await writeZip(zip, [{ name: "meta.json", data: JSON.stringify({ version: 1, job: "20990101-ffffff", mode: "avatar", duration: 5, tts: {} }) }]);
  const fake = fakeApi(new Map([["doc-o", zip]]));
  let called = false;
  const bot = await createBot({ token: "t", workspace: await fs.mkdtemp(path.join(os.tmpdir(), "vedit-avatar-bot2-")), callMethod: fake.callMethod, download: fake.download, onLog: () => {}, onboarding: false, quotas: false, cleanupIntervalMs: 0, avatarImport: async (a) => ((called = true), { jobId: a.jobId, outputs: [] }) });
  await bot.handleUpdate(msg({ chat: { id: 9, type: "private" }, document: { file_id: "doc-o", file_name: "avatar_result.zip" } }));
  await bot.idle();
  assert.equal(called, false);
  assert.equal(fake.texts().at(-1), MSG.avatarNoJob);
});
