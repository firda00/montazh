// Stage 27 helper: a contact sheet of a rendered montage with B-roll inserts — for every insert a frame just after it
// starts and one in its middle (chips: one per chip), each labelled with the time, the kind and the word that triggered
// it; plus frames of the head between inserts.
//   npx tsx tests/inserts-sheet.ts <output.mp4> <design/<id>.inserts.json> <sheet.jpg> [--cols 6]
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpeg, ffprobe } from "../src/lib/ffmpeg.ts";
import type { InsertsTrack } from "../src/design/inserts.ts";

const args = process.argv.slice(2);
const [video, insertsFile, out] = args.filter((a) => !a.startsWith("--"));
if (!video || !insertsFile || !out) throw new Error("usage: tsx tests/inserts-sheet.ts <output.mp4> <inserts.json> <sheet.jpg> [--cols 6]");
const cols = Number(args[args.indexOf("--cols") + 1]) || 6;
const track = JSON.parse(await fs.readFile(insertsFile, "utf8")) as InsertsTrack;
const duration = Number((await ffprobe(video)).format.duration) || 0;

const shots: { t: number; label: string }[] = [];
for (const it of track.items) {
  if (it.kind === "chips") for (const c of it.chips?.items ?? []) shots.push({ t: Math.min(it.end - 0.05, c.at + 0.45), label: `${c.at.toFixed(2)} chip «${c.text}»` });
  else {
    shots.push({ t: it.start + 0.45, label: `${it.start.toFixed(2)}–${it.end.toFixed(2)} ${it.kind} «${it.word}»` });
    shots.push({ t: (it.start + it.end) / 2 + 0.3, label: `${it.kind}: ${it.label}`.slice(0, 44) });
  }
}
// the head: between inserts (and the hook)
const busy = (t: number) => track.items.some((i) => t >= i.start - 0.2 && t <= i.end + 0.2);
for (let t = 0.6; t < duration - 0.3; t += 4) if (!busy(t)) shots.push({ t, label: `${t.toFixed(2)} голова` });
shots.sort((a, b) => a.t - b.t);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-isheet-"));
// drawtext paths without a drive colon: relative to the repo root (run from there)
const font = "assets/fonts/Inter-Variable.ttf";
try {
  for (const [i, s] of shots.entries()) {
    const txt = path.join(tmp, `l${i}.txt`);
    await fs.writeFile(txt, s.label);
    const txtArg = path.relative(process.cwd(), txt).replace(/\\/g, "/");
    await ffmpeg(["-ss", s.t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=300:-2,pad=300:584:0:0:black,drawtext=fontfile=${font}:textfile=${txtArg}:x=6:y=544:fontsize=15:fontcolor=white`, "-q:v", "3", path.join(tmp, `f${String(i).padStart(3, "0")}.jpg`)]);
  }
  const rows = Math.ceil(shots.length / cols);
  await ffmpeg(["-framerate", "1", "-i", path.join(tmp, "f%03d.jpg"), "-vf", `tile=${cols}x${rows}:padding=4:color=gray`, "-frames:v", "1", "-q:v", "3", out]);
  console.log(`${shots.length} кадров → ${out}`);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
