// Several videos → one: the combiner (real ffmpeg) and the bot's batching (fake Bot API, fake pipeline).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-multi-ws-"));

const { combineSources, chooseCanvas } = await import("../src/ingest/combine.ts");
const { startBot, MSG } = await import("../src/bot/index.ts");
const { ffmpeg, ffprobe } = await import("../src/lib/ffmpeg.ts");
const { buildPlanContext } = await import("../src/plan/context.ts");
const { BUILTIN_PRESETS } = await import("../src/plan/presets.ts");
const { PresetSchema } = await import("../src/schemas/index.ts");
const { MEDIA, makeTranscript } = await import("./helpers/plan-fixture.ts");
type CallMethod = import("../src/bot/telegram-api.ts").CallMethod;
type TgUpdate = import("../src/bot/telegram-api.ts").TgUpdate;
type PipelineArgs = import("../src/bot/index.ts").PipelineArgs;

test("chooseCanvas follows the majority orientation (ties go portrait)", () => {
  assert.deepEqual(chooseCanvas([{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }]), { width: 1080, height: 1920 });
  assert.deepEqual(chooseCanvas([{ width: 1920, height: 1080 }, { width: 1280, height: 720 }, { width: 1080, height: 1920 }]), { width: 1920, height: 1080 });
});

test("combineSources: mixed sizes and a silent clip become one 30 fps source with a source map", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-comb-"));
  const a = path.join(dir, "a.mp4");
  const b = path.join(dir, "b.mp4");
  const c = path.join(dir, "c.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=360x640:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", a]);
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=1.5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", b]); // no audio
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=1", "-f", "lavfi", "-i", "sine=frequency=880:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", c]);
  const out = path.join(dir, "combined.mp4");
  const map = await combineSources([a, b, c], out);
  assert.deepEqual(map.canvas, { width: 1080, height: 1920 });
  assert.deepEqual(map.sources.map((s) => s.id), ["v1", "v2", "v3"]);
  assert.equal(map.sources[1].cropped, true, "the landscape clip is cropped to the portrait canvas");
  assert.equal(map.sources[0].cropped, false);
  assert.ok(Math.abs(map.sources[1].start - map.sources[0].end) < 1e-6);
  const p = await ffprobe(out);
  const v = p.streams.find((s) => s.codec_type === "video") as { width: number; height: number; r_frame_rate: string };
  assert.deepEqual([v.width, v.height, v.r_frame_rate], [1080, 1920, "30/1"]);
  assert.ok(p.streams.some((s) => s.codec_type === "audio"));
  assert.ok(Math.abs(Number(p.format.duration) - 4.5) < 0.2, String(p.format.duration));
  await assert.rejects(() => combineSources([a], out), /минимум два/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("the planner pack carries the source map only for real compilations", () => {
  const preset = PresetSchema.parse(BUILTIN_PRESETS.bold_pop);
  const one = buildPlanContext({ media: MEDIA, transcript: makeTranscript(), scenes: [], highlights: [], preset, sources: [{ id: "v1", name: "a.mp4", start: 0, end: 35 }] });
  assert.ok(!("sources" in JSON.parse(one.packText)));
  const two = buildPlanContext({ media: MEDIA, transcript: makeTranscript(), scenes: [], highlights: [], preset, sources: [{ id: "v1", name: "a.mp4", start: 0, end: 20 }, { id: "v2", name: "b.mp4", start: 20, end: 35 }] });
  assert.deepEqual(JSON.parse(two.packText).sources.map((s: { id: string }) => s.id), ["v1", "v2"]);
});

// ---- bot batching against a fake Bot API ----
function fakeTelegram() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const queue: TgUpdate[] = [];
  let wake: (() => void) | null = null;
  let next = 1;
  const callMethod: CallMethod = async <T,>(_t: string, method: string, params: Record<string, unknown> = {}, opts: { signal?: AbortSignal } = {}) => {
    if (method === "getUpdates") {
      for (;;) {
        const pending = queue.filter((u) => u.update_id >= (params.offset as number));
        if (pending.length) return pending as T;
        await new Promise<void>((resolve, reject) => {
          wake = resolve;
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    }
    calls.push({ method, params });
    if (method === "getFile") return { file_id: params.file_id, file_size: 1000, file_path: `v/${params.file_id}.mp4` } as T;
    if (method === "sendChatAction") return true as T;
    return { message_id: 1, chat: { id: params.chat_id, type: "private" } } as T;
  };
  const download = async (_t: string, _f: unknown, dest: string) => {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, "fake");
  };
  const push = (message: Record<string, unknown>) => {
    queue.push({ update_id: next++, message: { message_id: next, chat: { id: 9, type: "private" }, from: { id: 9 }, ...message } } as TgUpdate);
    const w = wake;
    wake = null;
    w?.();
  };
  const messages = () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.params.text));
  return { callMethod, download, push, messages };
}

async function waitFor(pred: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("bot: several videos then /viral → one run with all sources; the next video starts a new batch; /clear resets", async () => {
  const tg = fakeTelegram();
  const runs: PipelineArgs[] = [];
  const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "vedit-out-")), "output_reel_1.mp4");
  await fs.writeFile(out, "x");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-bot-"));
  const running = await startBot({ token: "T", workspace, callMethod: tg.callMethod, download: tg.download, onLog: () => {}, pollTimeout: 1, onboarding: false, quotas: false, cleanupIntervalMs: 0, albumDelayMs: 50, pipeline: async (a) => (runs.push(a), { jobId: "j", outputs: [{ id: "reel_1", file: out }] }) });
  tg.push({ video: { file_id: "A", file_size: 1000 } });
  tg.push({ video: { file_id: "B", file_size: 1000 } });
  await waitFor(() => tg.messages().some((m) => m === MSG.batchSaved(2)), "batch of 2");
  tg.push({ text: "/viral" });
  await waitFor(() => runs.length === 1, "run");
  assert.equal(runs[0].sources?.length, 2);
  assert.match(runs[0].instruction, /самый вирусный/);
  await waitFor(() => tg.messages().some((m) => /Готово/.test(m)), "done");
  // after a run the batch is closed: a new video starts over
  tg.push({ video: { file_id: "C", file_size: 1000 } });
  await waitFor(() => tg.messages().filter((m) => m === MSG.videoSaved).length === 1, "new single video");
  tg.push({ text: "/clear" });
  await waitFor(() => tg.messages().includes(MSG.cleared), "cleared");
  await running.stop();
});

test("bot: an album with a caption runs once with every video of the album", async () => {
  const tg = fakeTelegram();
  const runs: PipelineArgs[] = [];
  const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "vedit-out-")), "output_reel_1.mp4");
  await fs.writeFile(out, "x");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-bot-"));
  const running = await startBot({ token: "T", workspace, callMethod: tg.callMethod, download: tg.download, onLog: () => {}, pollTimeout: 1, onboarding: false, quotas: false, cleanupIntervalMs: 0, albumDelayMs: 80, pipeline: async (a) => (runs.push(a), { jobId: "j", outputs: [{ id: "reel_1", file: out }] }) });
  tg.push({ media_group_id: "G1", caption: "лучшее в один рилс", video: { file_id: "X1", file_size: 1000 } });
  tg.push({ media_group_id: "G1", video: { file_id: "X2", file_size: 1000 } });
  tg.push({ media_group_id: "G1", video: { file_id: "X3", file_size: 1000 } });
  await waitFor(() => runs.length === 1, "album run");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(runs.length, 1, "one run per album");
  assert.equal(runs[0].sources?.length, 3);
  assert.equal(runs[0].instruction, "лучшее в один рилс");
  await running.stop();
});
