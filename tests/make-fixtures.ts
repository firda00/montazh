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
  return { landscape, portrait };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  makeFixtures().then((f) => console.log(f));
}
