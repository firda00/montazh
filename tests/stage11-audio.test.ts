import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-ws-"));

const { thinCues, sfxFile, SFX_KINDS } = await import("../src/audio/sfx.ts");
const { pickMusic, rankResults, attributionFor } = await import("../src/audio/music.ts");
const { mixSoundtrack } = await import("../src/audio/mix.ts");
const { ffmpeg, ffprobe } = await import("../src/lib/ffmpeg.ts");

test("thinCues: sorted, deduped per kind within the gap, one effect per frame, inside the video", () => {
  const out = thinCues(
    [
      { t: 1.0, kind: "pop" },
      { t: 1.1, kind: "pop" },
      { t: 1.02, kind: "tick" },
      { t: 0.5, kind: "whoosh" },
      { t: -0.1, kind: "ding" },
      { t: 9.99, kind: "ding" },
    ],
    { duration: 10 },
  );
  assert.deepEqual(out.map((c) => [c.t, c.kind]), [[0.5, "whoosh"], [1.0, "pop"]]);
});

test("every sound effect synthesises to a short 48 kHz stereo WAV", async () => {
  for (const k of SFX_KINDS) {
    const f = await sfxFile(k);
    const p = await ffprobe(f);
    const a = p.streams.find((s) => s.codec_type === "audio") as { sample_rate?: string; channels?: number };
    assert.equal(a.sample_rate, "48000", k);
    assert.equal(a.channels, 2, k);
    assert.ok(Number(p.format.duration) > 0.03 && Number(p.format.duration) < 1.5, `${k} ${p.format.duration}`);
  }
});

const OV = (over: Partial<Record<string, unknown>>) => ({ id: "x", title: "t", creator: "c", license: "by", license_version: "4.0", url: "https://cdn.test/a.mp3", foreign_landing_url: "https://land.test/a", source: "freesound", duration: 60000, category: null, ...over });

test("Openverse: songs ranked over loops, SFX-length clips and non-commercial licences dropped, attribution for CC-BY only", () => {
  const ranked = rankResults(
    [OV({ id: "loop", duration: 40000 }), OV({ id: "song", source: "jamendo", category: "music", duration: 200000 }), OV({ id: "sfx", title: "whoosh 1", duration: 900 }), OV({ id: "nc", license: "by-nc" })] as never,
    30,
  );
  assert.deepEqual(ranked.map((r) => r.id), ["song", "loop"]);
  assert.match(attributionFor(OV({ title: "Song", creator: "Ann", source: "jamendo" }) as never), /^Музыка: «Song» — Ann \(CC BY 4\.0, jamendo\) https:\/\/land\.test\/a$/);
  assert.equal(attributionFor(OV({ license: "cc0" }) as never), "");
});

test("pickMusic: the user's library wins; otherwise Openverse is searched, downloaded once and cached", async () => {
  const lib = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-lib-"));
  await fs.writeFile(path.join(lib, "my_chill_track.mp3"), "x");
  const fromLib = await pickMusic("chill", "seed", { libraryDir: lib, offline: true });
  assert.equal(fromLib?.source, "library");
  assert.equal(path.basename(fromLib!.file), "my_chill_track.mp3");

  const cache = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-cache-"));
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-empty-"));
  let downloads = 0;
  const fetchFn = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.startsWith("https://api.openverse.org/")) {
      assert.match(u, /license=cc0,by/);
      return new Response(JSON.stringify({ results: [OV({ id: "s1", source: "jamendo", category: "music", duration: 180000, title: "Song", url: "https://cdn.test/s1.mp3" })] }), { status: 200 });
    }
    downloads++;
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as typeof fetch;
  const a = await pickMusic("upbeat", "seed", { libraryDir: empty, fetchFn, cacheDir: cache });
  assert.equal(a?.title, "Song");
  assert.match(a!.attribution, /CC BY/);
  assert.equal(path.basename(a!.file), "s1.mp3");
  await pickMusic("upbeat", "seed", { libraryDir: empty, fetchFn, cacheDir: cache });
  assert.equal(downloads, 1, "second pick served from the cache");
  assert.equal(await pickMusic("upbeat", "seed", { libraryDir: empty, offline: true }), null);
});

test("mixSoundtrack: silent video gets music + effects at −14 LUFS; speech video keeps speech on top", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-mix-"));
  const silent = path.join(dir, "silent.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=black:size=180x320:rate=30:duration=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", silent]);
  const music = path.join(dir, "music.wav");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=220:duration=1.5", "-ac", "2", music]);
  const out = path.join(dir, "out.mp4");
  const r = await mixSoundtrack({ video: silent, out, duration: 4, music, speech: false, sfx: [{ t: 0.5, kind: "whoosh" }, { t: 2, kind: "impact" }] });
  assert.equal(r.cues, 2);
  assert.ok(r.music);
  const p = await ffprobe(out);
  assert.ok(p.streams.some((s) => s.codec_type === "audio"));
  assert.ok(Math.abs(Number(p.format.duration) - 4) < 0.15, String(p.format.duration));
  const { stderr } = await ffmpeg(["-i", out, "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { loglevel: "info" });
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(stderr)?.[1]);
  assert.ok(Math.abs(lufs - -14) < 1.5, `loudness ${lufs}`);

  // speech + music: the result still has one audio stream and the video's length
  const talk = path.join(dir, "talk.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=black:size=180x320:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=600:duration=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", talk]);
  const out2 = path.join(dir, "out2.mp4");
  await mixSoundtrack({ video: talk, out: out2, duration: 4, music, speech: true });
  const p2 = await ffprobe(out2);
  assert.equal(p2.streams.filter((s) => s.codec_type === "audio").length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});
