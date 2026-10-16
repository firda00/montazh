// Stage 23 check: do captions / titles of a rendered reel cover a face? Faces are detected on the FINAL video
// (what the viewer sees; MediaPipe BlazeFace through tools/matte, 8 fps) and, for a full-frame layout, on the rough
// cut as well (a caption over the mouth can hide a face from the detector); caption and title boxes come from the
// project's layout.json + design.json. Writes a contact sheet — one frame per caption page start (+ titles), face
// boxes red, caption boxes green (yellow when they overlap) — and prints / saves the numbers.
//
//   npx tsx tests/caption-check.ts --project workspace/<job>/design/<id> --video workspace/<job>/output_<id>.mp4 \
//       --sheet workspace/captions_v2_x.jpg [--rough workspace/<job>/rough_<id>.mp4] [--json out.json] [--label "…"]
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpeg, runProcess } from "../src/lib/ffmpeg.ts";
import { boxesBetween, detectFaces, smoothFaceTrack, type FaceBox, type FaceTrack } from "../src/design/faces.ts";
import { captionBlock, loadFontMetrics, outroText, titleBlock } from "../src/design/layout.ts";
import { DesignSpecSchema } from "../src/schemas/index.ts";
import type { Layout } from "../src/design/layout-types.ts";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const project = arg("project");
const video = arg("video");
const sheet = arg("sheet");
if (!project || !video || !sheet) throw new Error("usage: tsx tests/caption-check.ts --project <design dir> --video <mp4> --sheet <jpg> [--rough <mp4>] [--json <file>]");
const layout = JSON.parse(await fs.readFile(path.join(project, "layout.json"), "utf8")) as Layout;
const job = JSON.parse(await fs.readFile(path.join(project, "design.json"), "utf8")) as { design: unknown };
const D = DesignSpecSchema.parse(job.design ?? {});
const W = layout.frame.width;
const H = layout.frame.height;
const cache = path.join(os.tmpdir(), "vedit-caption-check");

async function track(file: string): Promise<FaceTrack> {
  const { raw } = await detectFaces(file, cache, {});
  return { source: "mediapipe", fps: raw.fps, samples: smoothFaceTrack(raw.samples, { fps: raw.fps }) };
}
const tracks = [await track(video)];
const rough = arg("rough");
if (rough && D.layout !== "split") tracks.push(await track(rough));
const facesAt = (t0: number, t1: number): FaceBox[] => tracks.flatMap((tr) => boxesBetween(tr, t0, t1));

type Rect = { x0: number; y0: number; x1: number; y1: number };
const hit = (r: Rect, b: FaceBox, pad = 0) => r.x0 < b[2] + pad && r.x1 > b[0] - pad && r.y0 < b[3] + pad && r.y1 > b[1] - pad;
const metrics = await loadFontMetrics(D.font.file, { family: D.font.family, weight: D.font.weight });

interface Item {
  kind: "page" | "title" | "outro";
  index: number;
  text: string;
  start: number;
  end: number;
  rect: Rect;
  place?: string;
  overlap: boolean;
  near: boolean;
  faces: number;
}
const items: Item[] = [];
for (const p of layout.pages) {
  const b = captionBlock(D, p, W, H);
  const y = p.anchorY ?? layout.captions.anchorY;
  // the visible block: without the pop / margin allowance
  const h = b.height - (0.06 * p.fontSize + 8) / H;
  const rect = { x0: 0.5 - b.width / 2, x1: 0.5 + b.width / 2, y0: y - h / 2, y1: y + h / 2 };
  const fb = facesAt(p.dispStart, p.dispEnd);
  items.push({ kind: "page", index: p.index, text: p.lines.map((l) => l.words.map((w) => w.text).join(" ")).join(" / "), start: p.dispStart, end: p.dispEnd, rect, place: p.place, overlap: fb.some((f) => hit(rect, f)), near: fb.some((f) => hit(rect, f, 0.03)), faces: fb.length });
}
if (D.layout !== "split") {
  for (const t of layout.titlesOut) {
    const b = titleBlock(D, t, W, H, metrics.measure);
    const y = t.anchorY ?? (t.style === "lower" ? D.captions.anchor_y : t.style === "callout" ? 0.3 : layout.titles.anchorY);
    const rect = { x0: 0.5 - b.width / 2, x1: 0.5 + b.width / 2, y0: y - b.height / 2, y1: y + b.height / 2 };
    const fb = facesAt(t.at, t.at + t.duration);
    items.push({ kind: "title", index: t.index, text: t.text, start: t.at, end: t.at + t.duration, rect, place: t.place, overlap: fb.some((f) => hit(rect, f)), near: fb.some((f) => hit(rect, f, 0.03)), faces: fb.length });
  }
}

const ot = D.outro.enabled && layout.frame.duration > D.outro.duration + 1 ? outroText(D, layout.captions.language || "ru", W, H) : null;
if (ot) {
  const y = layout.outroAnchorY ?? 0.5;
  const w = Math.max(...ot.lines.map((l) => metrics.measure(l, ot.fontSize))) / W;
  const h = (ot.lines.length * ot.fontSize * 1.1) / H;
  const rect = { x0: 0.5 - w / 2, x1: 0.5 + w / 2, y0: y - h / 2, y1: y + h / 2 };
  const start = layout.frame.duration - D.outro.duration;
  const fb = facesAt(start, layout.frame.duration);
  items.push({ kind: "outro", index: 0, text: ot.lines.join(" / "), start, end: layout.frame.duration, rect, place: layout.outroAnchorY !== undefined ? "moved" : "centre", overlap: fb.some((f) => hit(rect, f)), near: fb.some((f) => hit(rect, f, 0.03)), faces: fb.length });
}

// contact sheet: the frame a bit after each block appears (fade-in done), boxes drawn
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-sheet-"));
// drawtext needs a font file; ffmpeg runs inside tmp so the filter sees a plain relative name
await fs.copyFile(path.resolve(D.font.file), path.join(tmp, "font.ttf"));
const FF = process.env.FFMPEG_PATH || "ffmpeg";
const TW = 216;
const TH = Math.round((TW * H) / W / 2) * 2;
let n = 0;
for (const it of items) {
  const at = Math.min(it.start + Math.min(0.3, (it.end - it.start) / 2), layout.frame.duration - 0.05);
  const box = (x0: number, y0: number, x1: number, y1: number, c: string, th: number) => `drawbox=x=${(x0 * W).toFixed(0)}:y=${(y0 * H).toFixed(0)}:w=${((x1 - x0) * W).toFixed(0)}:h=${((y1 - y0) * H).toFixed(0)}:color=${c}:t=${th}`;
  const fb = facesAt(at - 0.07, at + 0.07);
  const draws = [...fb.map((f) => box(f[0], f[1], f[2], f[3], "red", 8)), box(it.rect.x0, it.rect.y0, it.rect.x1, it.rect.y1, it.overlap ? "yellow" : "lime", 6)];
  const label = `drawtext=fontfile=font.ttf:text='${it.kind === "page" ? "p" : it.kind === "outro" ? "O" : "T"}${it.index} ${at.toFixed(1)}s${it.overlap ? " OVERLAP" : ""}':x=12:y=12:fontsize=44:fontcolor=white:box=1:boxcolor=black@0.6`;
  await runProcess(FF, ["-hide_banner", "-loglevel", "error", "-y", "-ss", at.toFixed(3), "-i", path.resolve(video), "-frames:v", "1", "-vf", `${draws.join(",")},${label},scale=${TW}:${TH}`, `${String(n++).padStart(3, "0")}.png`], { cwd: tmp });
}
const cols = Math.min(10, Math.max(1, n));
const rows = Math.ceil(n / cols);
await fs.mkdir(path.dirname(path.resolve(sheet)), { recursive: true });
await ffmpeg(["-framerate", "1", "-i", path.join(tmp, "%03d.png"), "-vf", `tile=${cols}x${rows}:padding=4:color=white`, "-frames:v", "1", "-q:v", "3", sheet]);
await fs.rm(tmp, { recursive: true, force: true });

const pages = items.filter((i) => i.kind === "page");
const titles = items.filter((i) => i.kind !== "page");
const summary = {
  label: arg("label") ?? path.basename(video),
  video,
  pages: pages.length,
  pages_with_face: pages.filter((p) => p.faces > 0).length,
  page_overlaps: pages.filter((p) => p.overlap).length,
  page_near: pages.filter((p) => p.near && !p.overlap).length,
  titles: titles.length,
  title_overlaps: titles.filter((t) => t.overlap).length,
  moved: pages.filter((p) => p.place && p.place !== "preferred").length,
  rules: Object.fromEntries([...new Set(items.map((i) => i.place ?? "-"))].map((r) => [r, items.filter((i) => (i.place ?? "-") === r).length])),
  overlaps: items.filter((i) => i.overlap).map((i) => `${i.kind}${i.index} ${i.start.toFixed(2)}s «${i.text}»`),
  sheet,
};
console.log(JSON.stringify(summary, null, 1));
const json = arg("json");
if (json) await fs.writeFile(json, JSON.stringify({ ...summary, items }, null, 1));
