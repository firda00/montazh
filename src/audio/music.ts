import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { WORKSPACE_ROOT } from "../lib/workspace.ts";

/**
 * Background music: a track for a mood. Sources, in order:
 *   1. assets/music/ — the user's own tracks (library.json with moods/attribution, or any audio files)
 *   2. Openverse (api.openverse.org, no key): CC0 / CC-BY music from Jamendo (full songs) and
 *      Freesound (loops); downloaded once into workspace/_cache/music/
 * CC-BY needs attribution: the returned `attribution` goes into the caption and make.json.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MUSIC_LIBRARY = process.env.VEDIT_MUSIC_DIR || path.join(ROOT, "assets", "music");
export const MUSIC_CACHE = path.join(WORKSPACE_ROOT, "_cache", "music");

export const MOODS = ["upbeat", "chill", "dramatic", "inspiring", "tech", "funky", "emotional"] as const;
export type Mood = (typeof MOODS)[number];

/** search terms per mood (English, what music on Jamendo/Freesound is tagged with) */
export const MOOD_QUERIES: Record<Mood, string[]> = {
  upbeat: ["upbeat pop", "energetic", "happy upbeat"],
  chill: ["lofi", "chill", "lounge"],
  dramatic: ["cinematic", "epic", "dramatic"],
  inspiring: ["inspiring", "uplifting", "motivational"],
  tech: ["electronic", "synthwave", "future"],
  funky: ["funk", "groove", "funky"],
  emotional: ["piano", "emotional", "ambient piano"],
};

export interface MusicTrack {
  file: string;
  title: string;
  creator: string;
  license: string;
  source: string;
  url: string;
  /** text to credit the track (empty for the user's own / CC0) */
  attribution: string;
  duration?: number;
}

const LibrarySchema = z.array(
  z.object({ file: z.string(), moods: z.array(z.string()).default([]), title: z.string().default(""), artist: z.string().default(""), license: z.string().default("own"), attribution: z.string().default("") }),
);

const hashPick = <T>(items: T[], seed: string): T => items[parseInt(createHash("sha1").update(seed).digest("hex").slice(0, 8), 16) % items.length];

async function fromLibrary(mood: Mood, seed: string, dir = MUSIC_LIBRARY): Promise<MusicTrack | null> {
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => /\.(mp3|wav|ogg|m4a|flac)$/i.test(f));
  if (!files.length) return null;
  let entries: z.infer<typeof LibrarySchema> = files.map((f) => ({ file: f, moods: [], title: path.parse(f).name, artist: "", license: "own", attribution: "" }));
  try {
    entries = LibrarySchema.parse(JSON.parse(await fs.readFile(path.join(dir, "library.json"), "utf8"))).filter((e) => files.includes(e.file));
  } catch {}
  const fit = entries.filter((e) => e.moods.includes(mood) || path.parse(e.file).name.toLowerCase().includes(mood));
  const e = hashPick(fit.length ? fit : entries, seed);
  return { file: path.join(dir, e.file), title: e.title, creator: e.artist, license: e.license, source: "library", url: "", attribution: e.attribution };
}

const OpenverseResult = z.object({
  id: z.string(),
  title: z.string().default(""),
  creator: z.string().nullable().default(""),
  license: z.string(),
  license_version: z.string().nullable().default(""),
  url: z.string(),
  foreign_landing_url: z.string().nullable().default(""),
  source: z.string().default(""),
  duration: z.number().nullable().default(null),
  category: z.string().nullable().default(null),
});
type OpenverseResult = z.infer<typeof OpenverseResult>;

export interface OpenverseOptions {
  fetchFn?: typeof fetch;
  cacheDir?: string;
  /** minimum track length in seconds (shorter loops are looped by the mixer) */
  minSeconds?: number;
}

/** Ranks results: full songs from Jamendo first, then long loops; skips SFX-length clips. */
export function rankResults(rs: OpenverseResult[], minSeconds: number): OpenverseResult[] {
  const ok = rs.filter((r) => (r.duration ?? 0) / 1000 >= Math.min(minSeconds, 20) && /^(cc0|by)$/.test(r.license) && !/sfx|effect|whoosh|hit|impact/i.test(r.title));
  const score = (r: OpenverseResult) => (r.source === "jamendo" ? 2 : 0) + (r.category === "music" ? 1 : 0) + ((r.duration ?? 0) / 1000 >= minSeconds ? 1 : 0);
  return ok.sort((a, b) => score(b) - score(a) || (b.duration ?? 0) - (a.duration ?? 0));
}

export function attributionFor(r: Pick<OpenverseResult, "title" | "creator" | "license" | "license_version" | "foreign_landing_url" | "source">): string {
  if (r.license === "cc0") return "";
  return `Музыка: «${r.title}» — ${r.creator || "unknown"} (CC ${r.license.toUpperCase()} ${r.license_version ?? ""}`.trimEnd() + `, ${r.source}) ${r.foreign_landing_url ?? ""}`.trimEnd();
}

async function fromOpenverse(mood: Mood, seed: string, o: OpenverseOptions = {}): Promise<MusicTrack | null> {
  const f = o.fetchFn ?? fetch;
  const cache = o.cacheDir ?? MUSIC_CACHE;
  const minSeconds = o.minSeconds ?? 30;
  for (const q of MOOD_QUERIES[mood]) {
    const url = `https://api.openverse.org/v1/audio/?q=${encodeURIComponent(q)}&license=cc0,by&page_size=20&mature=false`;
    let results: OpenverseResult[];
    try {
      const res = await f(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const json = (await res.json()) as { results?: unknown[] };
      results = (json.results ?? []).map((r) => OpenverseResult.safeParse(r)).filter((p) => p.success).map((p) => p.data!);
    } catch {
      continue;
    }
    const ranked = rankResults(results, minSeconds);
    if (!ranked.length) continue;
    // stable choice among the top few, so the same topic gets the same track
    const pick = hashPick(ranked.slice(0, 5), seed);
    const ext = /format=mp3|\.mp3/i.test(pick.url) ? ".mp3" : path.extname(new URL(pick.url).pathname) || ".mp3";
    const file = path.join(cache, `${pick.id}${ext}`);
    try {
      await fs.access(file);
    } catch {
      try {
        const res = await f(pick.url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) continue;
        await fs.mkdir(cache, { recursive: true });
        await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      } catch {
        continue;
      }
    }
    return { file, title: pick.title, creator: pick.creator ?? "", license: `${pick.license} ${pick.license_version ?? ""}`.trim(), source: pick.source, url: pick.foreign_landing_url ?? "", attribution: attributionFor(pick), duration: (pick.duration ?? 0) / 1000 };
  }
  return null;
}

/** A track for the mood: the user's library first, then Openverse; null when nothing is reachable. */
export async function pickMusic(mood: Mood, seed: string, o: OpenverseOptions & { libraryDir?: string; offline?: boolean } = {}): Promise<MusicTrack | null> {
  // VEDIT_MUSIC_OFFLINE=1: library only (tests, no network)
  const offline = o.offline ?? process.env.VEDIT_MUSIC_OFFLINE === "1";
  return (await fromLibrary(mood, seed, o.libraryDir)) ?? (offline ? null : await fromOpenverse(mood, seed, o));
}

export function isMood(s: string): s is Mood {
  return (MOODS as readonly string[]).includes(s);
}
