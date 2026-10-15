// Music under a voiceover is audible but does not fight it: the real ffmpeg graph of buildMixGraph on a
// synthetic voice (2 s talk / 1.5 s pause) and a pink-noise "music" bed, measured with ebur128 on the stems.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildMixGraph, VOICE_BED } from "../src/audio/mix.ts";

const ff = (args: string[]) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(r.stderr.slice(-600));
  return r.stderr;
};
const lufs = (file: string, t0: number, t1: number) => {
  const e = ff(["-ss", String(t0), "-t", String(t1 - t0), "-i", file, "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
  return Number(/I:\s+(-?[\d.]+) LUFS/.exec(e.split("Summary:").pop() ?? "")![1]);
};

test("mix levels: bed ≈ −16…−22 dB under the talking voice, clearly louder in the pauses", async () => {
  assert.equal(VOICE_BED.ratio, 3);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-mix-"));
  const D = 14;
  const video = path.join(dir, "v.mp4");
  const voice = path.join(dir, "voice.wav");
  const music = path.join(dir, "music.wav");
  ff(["-f", "lavfi", "-i", `color=c=black:s=64x64:d=${D}`, "-c:v", "libx264", "-t", String(D), video]);
  // a voice-like signal: harmonics with a syllable-rate tremolo, 2 s on / 1.5 s off, starting at 0.5 s
  const on = "between(mod(t-0.5,3.5),0,2)*gte(t,0.5)";
  ff(["-f", "lavfi", "-i", `aevalsrc='${on}*(0.5*sin(2*PI*180*t)+0.3*sin(2*PI*360*t)+0.2*sin(2*PI*720*t))*gt(sin(2*PI*3.3*t)+0.4*sin(2*PI*1.1*t),0.15)*(0.6+0.4*sin(2*PI*7*t))':s=48000:d=${D}`, "-ac", "1", voice]);
  ff(["-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.3:d=${D}:r=48000`, "-ac", "2", music]);
  const g = buildMixGraph({ video, out: path.join(dir, "o.mp4"), duration: D, music, voice, speech: false, sfx: [] }, { hasAudio: false, sfxFile: () => "" });
  const at = g.args.indexOf("-filter_complex");
  const fc = g.args[at + 1];
  const inputs = g.args.slice(0, at);
  // stems from the same graph: the ducked music alone (the voice still keys the compressor) and the voice alone
  const stem = (keep: "duck" | "vo") => fc.replace(/\[vo\]\[duck\]amix=inputs=2/, keep === "duck" ? "[vo]anullsink;[duck]amix=inputs=1" : "[duck]anullsink;[vo]amix=inputs=1").replace(/,loudnorm=I=-14[^[]*\[aout\]/, "[aout]");
  for (const k of ["duck", "vo"] as const) ff([...inputs, "-filter_complex", stem(k), "-map", "[aout]", "-t", String(D), path.join(dir, `${k}.wav`)]);
  // talk windows: 0.5–2.5, 4–6, 7.5–9.5, 11–13; pauses: 2.6–3.9, 6.1–7.4, 9.6–10.9
  const talkVoice = lufs(path.join(dir, "vo.wav"), 4.3, 5.8);
  const talkMusic = lufs(path.join(dir, "duck.wav"), 4.3, 5.8);
  const gapMusic = lufs(path.join(dir, "duck.wav"), 6.4, 7.3);
  const rel = talkMusic - talkVoice;
  // a synthetic voice is denser than speech, so it ducks a little deeper (real narration measured −18.8 dB, see VOICE_BED)
  assert.ok(rel <= -14 && rel >= -25, `music under the voice ${rel.toFixed(1)} dB (want −14…−25)`);
  assert.ok(gapMusic - talkMusic >= 5, `music swells in the pauses: ${talkMusic.toFixed(1)} → ${gapMusic.toFixed(1)} LUFS`);
  await fs.rm(dir, { recursive: true, force: true });
});
