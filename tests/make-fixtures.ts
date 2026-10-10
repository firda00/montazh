// Generates synthetic fixtures with a large on-screen timecode, so every cut can be
// checked by eye: the frame shows exactly which source second it came from.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ffmpeg } from "../src/lib/ffmpeg.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "fixtures");

const fontCandidates = ["C:/Windows/Fonts/arialbd.ttf", "/System/Library/Fonts/Helvetica.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"];
const font = fontCandidates.find((f) => fs.existsSync(f));

function overlay(label: string) {
  if (!font) return "null";
  const ff = font.replace(/:/g, "\\:");
  return [
    `drawtext=fontfile='${ff}':text='%{pts\\:hms}':fontsize=h/6:fontcolor=white:borderw=8:bordercolor=black:x=(w-tw)/2:y=(h-th)/2`,
    `drawtext=fontfile='${ff}':text='${label}':fontsize=h/18:fontcolor=yellow:borderw=4:bordercolor=black:x=(w-tw)/2:y=h*0.72`,
  ].join(",");
}

export async function makeFixtures() {
  fs.mkdirSync(dir, { recursive: true });

  // 60 s landscape, 25 fps (normalization should bring it to 30), beep every second
  const landscape = path.join(dir, "timecode_60s_1080p25.mp4");
  if (!fs.existsSync(landscape)) {
    await ffmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=25:duration=60",
      "-f", "lavfi", "-i", "sine=frequency=660:beep_factor=3:sample_rate=48000:duration=60",
      "-vf", overlay("LANDSCAPE 16x9"),
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", landscape,
    ]);
  }

  // 20 s portrait without an audio track — exercises the silent-audio path
  const portrait = path.join(dir, "timecode_20s_portrait_noaudio.mp4");
  if (!fs.existsSync(portrait)) {
    await ffmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30:duration=20",
      "-vf", overlay("PORTRAIT"),
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", portrait,
    ]);
  }
  const speech = await makeSpeechFixture();
  return { landscape, portrait, speech };
}

// Russian "cafe promo" voice-over with pauses + an English outro, over three visually
// distinct scenes. Writes <name>.truth.json with SAPI word starts and the scene cut times.
const SPEECH_PARTS = [
  { voice: "Microsoft Irina Desktop", text: "Добро пожаловать в наше кафе. Здесь готовят лучший плов в городе." },
  { pause_ms: 1500 },
  { voice: "Microsoft Irina Desktop", text: "Каждое утро мы закладываем рис, морковь и мясо в большой казан. Огонь, специи и много терпения." },
  { pause_ms: 2000 },
  { voice: "Microsoft Irina Desktop", text: "Попробуйте нашу самсу прямо из тандыра. Ждём вас каждый день с девяти утра до одиннадцати вечера." },
  { pause_ms: 1200 },
  { voice: "Microsoft Zira Desktop", text: "Thank you for watching. See you soon." },
];

async function makeSpeechFixture() {
  const out = path.join(dir, "cafe_speech_ru_en.mp4");
  if (fs.existsSync(out)) return out;
  if (process.platform !== "win32") {
    console.warn("speech fixture needs Windows SAPI — skipped");
    return null;
  }
  const { spawnSync } = await import("node:child_process");
  const { ffprobe } = await import("../src/lib/ffmpeg.ts");
  const tmp = fs.mkdtempSync(path.join(dir, "_speech-"));
  const specFile = path.join(tmp, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify({ parts: SPEECH_PARTS }));
  const ps = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "fixture-src", "speak.ps1"), "-In", specFile, "-OutDir", tmp], { encoding: "utf8" });
  if (ps.status !== 0) throw new Error(`speech synthesis failed: ${ps.stderr}`);
  const parts = JSON.parse(fs.readFileSync(path.join(tmp, "parts.json"), "utf8")) as { index: number; file: string; words: { w: string; start: number }[] }[];

  // Lay the parts out on one timeline: spoken parts back to back, pauses as exact silence.
  const words: { w: string; start: number }[] = [];
  const audioInputs: string[] = [];
  let offset = 0;
  for (const [i, p] of SPEECH_PARTS.entries()) {
    const pause = "pause_ms" in p ? p.pause_ms : undefined;
    if (pause) {
      audioInputs.push("-f", "lavfi", "-t", (pause / 1000).toFixed(3), "-i", "anullsrc=r=16000:cl=mono");
      offset += pause / 1000;
    } else {
      const part = parts.find((x) => x.index === i)!;
      audioInputs.push("-i", part.file);
      for (const w of part.words) words.push({ w: w.w, start: Math.round((w.start + offset) * 1000) / 1000 });
      offset += Number((await ffprobe(part.file)).format.duration);
    }
  }
  const wav = path.join(tmp, "speech.wav");
  const n = SPEECH_PARTS.length;
  const fmt = Array.from({ length: n }, (_, k) => `[${k}:a]aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=mono[a${k}]`);
  const cat = `${Array.from({ length: n }, (_, k) => `[a${k}]`).join("")}concat=n=${n}:v=0:a=1[a]`;
  await ffmpeg([...audioInputs, "-filter_complex", [...fmt, cat].join(";"), "-map", "[a]", wav]);
  const speechDur = Number((await ffprobe(wav)).format.duration);
  const total = Math.ceil(speechDur + 1.5);
  // cut points chosen to fall inside pauses would be too convenient — put them mid-sentence
  const cuts = [0, Math.round(total * 0.33 * 10) / 10, Math.round(total * 0.66 * 10) / 10, total];
  const sources = ["testsrc2=size=1920x1080:rate=30", "smptehdbars=size=1920x1080:rate=30", "life=size=1920x1080:rate=30:mold=10:ratio=0.1:life_color=#00ff88:death_color=#203040"];
  const inputs: string[] = [];
  const chains: string[] = [];
  sources.forEach((src, i) => {
    inputs.push("-t", (cuts[i + 1] - cuts[i]).toFixed(2), "-f", "lavfi", "-i", src);
    chains.push(`[${i}:v]format=yuv420p,setpts=PTS-STARTPTS[s${i}]`);
  });
  const ov = font
    ? `,drawtext=fontfile='${font.replace(/:/g, "\\:")}':text='%{pts\\:hms}':fontsize=64:fontcolor=white:borderw=5:bordercolor=black:x=40:y=40`
    : "";
  chains.push(`[s0][s1][s2]concat=n=3:v=1:a=0${ov}[v]`);
  chains.push(`[3:a]apad=whole_dur=${total}[a]`);
  await ffmpeg([
    ...inputs, "-i", wav,
    "-filter_complex", chains.join(";"), "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-ar", "48000", "-t", String(total), out,
  ]);
  fs.writeFileSync(
    out.replace(/\.mp4$/, ".truth.json"),
    JSON.stringify({ scene_cuts: cuts.slice(1, -1), duration: total, words }, null, 2),
  );
  fs.rmSync(tmp, { recursive: true });
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  makeFixtures().then((f) => console.log(f));
}
