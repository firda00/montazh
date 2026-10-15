import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { exists, jobDir, readJson, writeJson } from "../lib/workspace.ts";
import { addCost } from "../lib/cost.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import type { StructuredFn } from "../lib/llm.ts";
import { zodToApiSchema } from "../plan/schema-sanitize.ts";
import { EdlSchema, TranscriptSchema, type Edl, type Media } from "../schemas/index.ts";
import type { EventsFile, SportEvent } from "../understand/events.ts";
import { buildHighlightEdl, estimateSeconds, isMake, makeScore, makeTimes, type HighlightPick } from "./plan.ts";
import { applyFixes, attributePlayers, loadFixes, loadPlayers, shotTime, type Person, type PlayersFile } from "./people.ts";
import { chooseMusic, ensureEvents, isJunkText, localPass, LOCAL_VERSION, transcribeSpeech, type HighlightsOptions } from "./index.ts";
import { sportOf } from "./intent.ts";

/**
 * PER-PERSON REELS: one 60–90 s reel for every person who plays — their arrival (natural audio + a line),
 * then all their best makes building up (rim-outs and good attempts when they have few makes), the best
 * make last with a replay, a longer reaction to close. Same edit language as the single highlights reel.
 */

export const PersonDirectionSchema = z.object({
  reels: z.array(
    z.object({
      id: z.string().describe("person id, e.g. P2"),
      title: z.string().describe("2–4 words, uppercase, a neutral descriptor of the person by appearance in the language of the instruction, e.g. «ИГРОК В БЕЛОЙ РУБАШКЕ»; no names unless they are known"),
      arrival_line: z.string().describe("≤ 40 chars: what happens when they join (from the arrival description), or empty when they played from the start"),
    }),
  ),
  reasoning: z.string().describe("1–2 sentences for the user"),
});
export type PersonDirection = z.infer<typeof PersonDirectionSchema>;

export const PersonsReportSchema = z.object({
  reels: z.array(
    z.object({
      id: z.string(),
      person: z.string(),
      look: z.string(),
      title: z.string(),
      joined_at: z.number().nullable(),
      arrival_event: z.string().nullable(),
      makes: z.number(),
      makes_in_reel: z.number(),
      misses_in_reel: z.number(),
      duration: z.number(),
      music: z.string().nullable(),
      music_attribution: z.string(),
      bpm: z.number().nullable(),
      timeline: z.array(z.object({ id: z.string(), role: z.string(), start: z.number(), end: z.number(), impact: z.number().nullable(), replay: z.boolean(), callout: z.string().optional() })),
    }),
  ),
  skipped: z.array(z.object({ person: z.string(), look: z.string(), shots: z.number(), why: z.string() })),
  notes: z.array(z.string()),
});
export type PersonsReport = z.infer<typeof PersonsReportSchema>;

export interface PersonPlanOptions {
  min?: number;
  max?: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The people moment that starts a person's story: a social event near the time they joined (±90 s), with speech first. */
export function arrivalEvent(person: Person, events: SportEvent[]): SportEvent | null {
  const at = person.joined_at;
  if (at === null) return null;
  const social = events.filter((e) => (e.type === "people_approach" || e.type === "other" || e.type === "celebration") && Math.abs(e.start - at) <= 90);
  social.sort((a, b) => Number(b.type === "people_approach") - Number(a.type === "people_approach") || Math.abs(a.start - at) - Math.abs(b.start - at));
  return social[0] ?? null;
}

/**
 * Picks for one person: arrival → makes in source order building up → the best make last with a replay.
 * Too few makes for `min` seconds: their shots that reached the rim (rim-outs) fill in, chronologically.
 * Too many for `max`: the weakest makes go (rolled-on-rim first).
 */
export function personPicks(person: Person, players: PlayersFile, events: SportEvent[], o: PersonPlanOptions = {}): { picks: HighlightPick[]; arrival: SportEvent | null; seconds: number } {
  const min = o.min ?? 60;
  const max = o.max ?? 90;
  const mine = new Set(players.shots.filter((s) => s.person === person.id).map((s) => s.event));
  const byId = new Map(events.map((e) => [e.id, e]));
  const shots = [...mine].map((id) => byId.get(id)!).filter(Boolean).sort((a, b) => shotTime(a) - shotTime(b));
  const arrival = arrivalEvent(person, events);
  // streaks of this person's own shots
  let run = 0;
  const streak = new Map<string, number>();
  for (const s of shots) {
    run = isMake(s) ? run + 1 : 0;
    if (isMake(s)) streak.set(s.id, run);
  }
  const overlaps = (a: SportEvent, b: SportEvent) => a.start - 1 < b.end && b.start - 1 < a.end;
  let makes: HighlightPick[] = shots.filter(isMake).map((e) => ({ event: e, role: "make" as const, score: makeScore(e), replay: false, streak: streak.get(e.id) ?? 1 }));
  // the same make logged twice / two makes in 3 s: keep the better
  makes = makes.filter((p, i) => !makes.some((q, j) => j !== i && overlaps(p.event, q.event) && (q.score > p.score || (q.score === p.score && j < i))));
  const arrivalPick: HighlightPick[] = arrival ? [{ event: arrival, role: "social", score: arrival.quality, replay: false, streak: 0 }] : [];
  const sum = (ps: HighlightPick[]) => 2.5 + ps.reduce((s, p) => s + estimateSeconds(p), 0);
  // trim to max: drop the lowest-scoring makes (the best stays)
  while (makes.length > 2 && sum([...arrivalPick, ...makes]) + 2.2 > max) {
    const worst = [...makes].sort((a, b) => a.score - b.score)[0];
    makes = makes.filter((p) => p !== worst);
  }
  // fill to min with rim-outs (shots that reached the rim), then other attempts
  const fillers: HighlightPick[] = [];
  const pool = shots
    .filter((s) => !isMake(s) && !makes.some((m) => overlaps(m.event, s)) && !(arrival && overlaps(arrival, s)))
    .sort((a, b) => Number(!!b.refined?.motion_t) - Number(!!a.refined?.motion_t) || b.quality - a.quality);
  for (const s of pool) {
    if (sum([...arrivalPick, ...makes, ...fillers]) + 2.2 >= min) break;
    if (fillers.some((f) => overlaps(f.event, s))) continue;
    fillers.push({ event: s, role: "miss", score: s.quality, replay: false, streak: 0 });
  }
  const best = [...makes].sort((a, b) => b.score - a.score)[0];
  if (best) best.replay = true;
  // still short: their own people moments (talking, arguing about the score, reacting), found by their clothing in the description
  const moments: HighlightPick[] = [];
  const key = lookKey(person.look);
  if (key) {
    for (const e of events.filter((x) => x !== arrival && (x.type === "people_approach" || x.type === "other" || x.type === "funny" || x.type === "celebration") && key.every((k) => x.description.toLowerCase().replace(/ё/g, "е").includes(k)))) {
      if (sum([...arrivalPick, ...makes, ...fillers, ...moments]) + 2.2 >= min || moments.length >= 3) break;
      if ([...makes, ...fillers, ...moments].some((p) => overlaps(p.event, e))) continue;
      moments.push({ event: e, role: "social", score: e.quality, replay: false, streak: 0 });
    }
  }
  const middle = [...makes.filter((p) => p !== best), ...fillers, ...moments].sort((a, b) => a.event.start - b.event.start);
  const picks = [...arrivalPick, ...middle, ...(best ? [best] : [])];
  // callouts: a personal streak of 3+, a clean long make — at most 2 per reel
  let n = 0;
  for (const p of [...makes].sort((a, b) => b.score - a.score)) {
    if (n >= 2) break;
    const { K, T } = makeTimes(p.event);
    if (p.streak >= 3) p.callout = `x${p.streak}`;
    else if (p.event.distance === "long" && T - K <= 0.12) p.callout = "ЧИСТЫЙ";
    if (p.callout) n++;
  }
  return { picks, arrival, seconds: r2(sum(picks)) };
}

/** Default reel title from the person's look ("белая рубашка, тёмные брюки" → «ИГРОК В БЕЛОЙ РУБАШКЕ» is the editor's job; this is the fallback). */
export function fallbackTitle(p: Person, i: number): string {
  const first = p.look.split(/[,;(]/)[0].trim();
  return (first ? `ИГРОК: ${first}` : `ИГРОК ${i + 1}`).toUpperCase().slice(0, 30);
}

export interface PerPersonOptions extends HighlightsOptions {
  /** persons with fewer shots are not given a reel */
  minShots?: number;
  min?: number;
  max?: number;
}

export async function planPerPerson(jobId: string, media: Media, o: PerPersonOptions = {}): Promise<{ edl: Edl; report: PersonsReport; players: PlayersFile }> {
  const log = o.onLog ?? (() => {});
  const dir = jobDir(jobId);
  const instruction = o.instruction ?? "";
  let ev = await ensureEvents(jobId, media, o);
  if (ev.local?.version !== LOCAL_VERSION) ev = await localPass(jobId, ev, media, log);
  let players = await loadPlayers(jobId);
  const shotsNow = ev.events.filter((e) => e.type.startsWith("shot") || e.type === "dunk_layup").map((e) => e.id).sort().join(",");
  const playersFor = path.join(dir, "players.for");
  const stale = !players || !(await exists(playersFor)) || (await fs.readFile(playersFor, "utf8")) !== shotsNow;
  if (stale) {
    players = await attributePlayers(jobId, ev, media, { onLog: log });
    await fs.writeFile(playersFor, shotsNow);
  }
  // corrections from looking at the sheets (players.fix.json), on top of the automatic passes
  const fix = await loadFixes(jobId);
  const makeIds = new Set(ev.events.filter((e) => isMake(e)).map((e) => e.id));
  const P = fix ? applyFixes(players!, fix, makeIds) : players!;
  if (fix) log(`правки по просмотру: бросков ${Object.keys(fix.shots).length}, слияний ${Object.keys(fix.merge).length}`);
  const notes: string[] = [...P.warnings];
  const minShots = o.minShots ?? 3;
  const eligible = P.persons.filter((p) => p.shots >= minShots).sort((a, b) => (a.joined_at ?? a.first_seen ?? 0) - (b.joined_at ?? b.first_seen ?? 0));
  const skipped = P.persons.filter((p) => p.shots < minShots).map((p) => ({ person: p.id, look: p.look, shots: p.shots, why: `бросков ${p.shots} < ${minShots}` }));
  log(`людей: ${P.persons.length}, роликов: ${eligible.length} (${eligible.map((p) => `${p.id} ${p.makes}/${p.shots}`).join(", ")})`);

  // the editor names the reels (neutral descriptors) and writes the arrival lines
  const plans = eligible.map((p) => ({ person: p, ...personPicks(p, P, ev.events, { min: o.min ?? 60, max: o.max ?? 90 }) }));
  const direction = new Map<string, { title: string; line: string }>();
  if (o.llm && plans.length) {
    try {
      const lines = plans.map((x) => `${x.person.id}: ${x.person.look || "(нет описания)"}; ${x.person.joined_at !== null ? `присоединился в ${fmt(x.person.joined_at)}` : "играет с начала"}; попаданий ${x.person.makes} из ${x.person.shots}${x.arrival ? `; момент прихода: ${x.arrival.description}` : ""}`).join("\n");
      const r = await o.llm({ system: loadPrompt("highlights.persons.system"), prompt: fill(loadPrompt("highlights.persons.user"), { instruction: instruction || "(нет)", sport: sportOf(instruction), persons: lines }), schema: zodToApiSchema(PersonDirectionSchema), effort: "low", maxTokens: 3000, maxBudgetUsd: 0.5 });
      const d = PersonDirectionSchema.parse(r.data);
      for (const x of d.reels) direction.set(x.id.trim().toUpperCase(), { title: x.title.replace(/\p{Extended_Pictographic}/gu, "").trim().toUpperCase().slice(0, 32), line: x.arrival_line.replace(/\p{Extended_Pictographic}/gu, "").trim().slice(0, 48) });
      await addCost(jobId, { step: "plan", provider: r.provider === "anthropic" ? "anthropic" : r.provider, model: r.model, units: { ...r.usage, calls: 1, estimate: r.estimate ? 1 : 0 }, usd: r.usd });
      log(`редактор (${r.model}): ${d.reasoning}`);
    } catch (err) {
      notes.push(`редактор не ответил, названия по описанию: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
  }

  const outputs: Edl["outputs"] = [];
  const reels: PersonsReport["reels"] = [];
  const speechRanges: { start: number; end: number }[] = [];
  for (const [i, x] of plans.entries()) {
    const id = `reel_${x.person.id.toLowerCase()}`;
    const d = direction.get(x.person.id);
    const title = d?.title || fallbackTitle(x.person, i);
    for (const p of x.picks) if (p.role === "social" && d?.line) p.label = d.line;
    const music = await chooseMusic(jobId, o.music ?? "auto", x.seconds + 15, `${jobId}-${x.person.id}`).catch(() => null);
    const beats = music?.grid && music.grid.strength > 0.05 ? music.grid.beats : [];
    const plan = buildHighlightEdl(x.picks, { id, aspect: o.aspect ?? "9:16", target: x.seconds, hoops: ev.hoops, frame: { width: media.width, height: media.height }, beats, title, music: music ? { file: music.track.file, offset: music.offset } : undefined, closingTail: 1.6 });
    outputs.push(plan.output);
    for (const c of plan.output.clips) if (c.volume === 1) speechRanges.push({ start: c.src_start, end: c.src_end });
    const dur = plan.timeline.length ? plan.timeline[plan.timeline.length - 1].end : 0;
    reels.push({
      id,
      person: x.person.id,
      look: x.person.look,
      title,
      joined_at: x.person.joined_at,
      arrival_event: x.arrival?.id ?? null,
      makes: x.person.makes,
      makes_in_reel: x.picks.filter((p) => p.role === "make").length,
      misses_in_reel: x.picks.filter((p) => p.role === "miss").length,
      duration: r2(dur),
      music: music?.track.title ?? null,
      music_attribution: music?.track.attribution ?? "",
      bpm: music?.grid?.bpm ?? null,
      timeline: plan.timeline.map((t) => ({ id: t.id, role: t.role, start: t.start, end: t.end, impact: t.impact, replay: t.replay, callout: t.callout })),
    });
    log(`${id} «${title}»: ${reels[reels.length - 1].makes_in_reel} попаданий${reels[reels.length - 1].misses_in_reel ? ` + ${reels[reels.length - 1].misses_in_reel} у дужки` : ""}${x.arrival ? ", приход" : ""}, ${dur.toFixed(1)} с${music ? `, «${music.track.title}» ${music.grid?.bpm ?? "?"} BPM` : ""}`);
  }

  // captions only where the arrival speech is clean; otherwise the editor's line stays
  if (speechRanges.length && o.captions !== false) {
    const tr = await transcribeSpeech(jobId, media, speechRanges, log);
    for (const out of outputs) {
      const ranges = out.clips.filter((c) => c.volume === 1);
      const has = tr.segments.some((s) => ranges.some((c) => s.start < c.src_end && s.end > c.src_start) && !isJunkText(s.text));
      out.captions = has ? { enabled: true, language: /[а-яё]/i.test(instruction) ? "ru" : tr.language, style: "bold_pop" } : { enabled: false };
      if (has) out.titles = out.titles.filter((t) => t.style !== "lower");
    }
  } else await writeJson(path.join(dir, "transcript.json"), TranscriptSchema, { language: "unknown", segments: [] });

  const edl = await writeJson(path.join(dir, "edl.json"), EdlSchema, { outputs, reasoning: `Отдельный ролик на каждого игрока: ${reels.map((r) => `«${r.title}» (${r.makes_in_reel} попаданий)`).join(", ")}.` });
  const report: PersonsReport = { reels, skipped, notes };
  await writeJson(path.join(dir, "persons.json"), PersonsReportSchema, report);
  return { edl, report, players: P };
}

function fmt(t: number) {
  return `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`;
}

const run = promisify(execFile);

/**
 * "Who is who": one row per person — up to `per` cut-outs of them at their shots' release (the boxes
 * the colour check measured) with the id, the look and the counts. For checking the attribution by eye.
 */
export async function whoIsWhoSheet(source: string, players: PlayersFile, out: string, o: { per?: number; persons?: string[] } = {}): Promise<string> {
  const per = o.per ?? 8;
  const tmp = path.join(os.tmpdir(), `vedit-who-${process.pid}-${Date.now()}`);
  await fs.mkdir(tmp, { recursive: true });
  const ff = process.env.FFMPEG_PATH || "ffmpeg";
  const font = "fontfile='C\\:/Windows/Fonts/arial.ttf'";
  const rows: string[] = [];
  const persons = players.persons.filter((p) => !o.persons || o.persons.includes(p.id));
  for (const p of persons) {
    // shots where the ball led back to the shooter first (they show who it is), then the rest
    const all = players.shots.filter((s) => s.person === p.id).sort((a, b) => a.t - b.t);
    const shots = all.filter((s) => s.box).length >= per ? all.filter((s) => s.box) : [...all.filter((s) => s.box), ...all.filter((s) => !s.box)].sort((a, b) => a.t - b.t);
    if (!shots.length) continue;
    const step = Math.max(1, Math.floor(shots.length / per));
    const sel = shots.filter((_, i) => i % step === 0).slice(0, per);
    const cells: string[] = [];
    for (const [k, s] of sel.entries()) {
      const cell = path.join(tmp, `${p.id}_${k}.png`);
      // no ":" in drawtext text (it separates filter options)
      const label = `${fmt(s.t).replace(":", "m")}${s.moved ? " *" : ""}`;
      // the whole frame at the release with a box where the model put the shooter: who it is, at a glance
      // red: the shooter found by following the ball back; blue: only the model's guess of where they stood
      const fw = 720;
      const fh = 1280;
      const box = s.box ?? { x: (s.x - 0.12) * fw, y: (s.y - 0.17) * fh, w: 0.24 * fw, h: 0.34 * fh };
      const sc = 180 / fw;
      const bx = Math.max(0, Math.round(box.x * sc));
      const by = Math.max(0, Math.round(box.y * sc));
      await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-ss", s.release_t.toFixed(2), "-i", source, "-frames:v", "1", "-vf", `scale=180:320,drawbox=x=${bx}:y=${by}:w=${Math.min(180 - bx, Math.round(box.w * sc))}:h=${Math.min(320 - by, Math.round(box.h * sc))}:color=${s.box ? "red" : "blue"}@0.9:t=2,drawtext=${font}:text='${label}':x=3:y=302:fontsize=14:fontcolor=yellow:box=1:boxcolor=black@0.6`, cell]);
      cells.push(cell);
    }
    while (cells.length < per) cells.push(cells[cells.length - 1]);
    const strip = path.join(tmp, `${p.id}_strip.png`);
    await run(ff, ["-hide_banner", "-loglevel", "error", "-y", ...cells.flatMap((c) => ["-i", c]), "-filter_complex", `hstack=${cells.length}`, strip]);
    const head = path.join(tmp, `${p.id}_head.png`);
    const txt = path.join(tmp, `${p.id}.txt`);
    await fs.writeFile(txt, `${p.id}  ${p.makes}/${p.shots}\n${p.look.slice(0, 60)}\n${p.joined_at !== null ? `пришёл ${fmt(p.joined_at)}` : "с начала"}`);
    const txtPath = txt.replace(/\\/g, "/").replace(/:/g, "\\:");
    await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x202020:s=300x320", "-frames:v", "1", "-vf", `drawtext=${font}:textfile='${txtPath}':x=8:y=12:fontsize=15:line_spacing=8:fontcolor=white`, head]);
    const row = path.join(tmp, `${p.id}_row.png`);
    await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", head, "-i", strip, "-filter_complex", "hstack=2", row]);
    rows.push(row);
  }
  if (!rows.length) throw new Error("нет вырезок игроков для листа");
  await run(ff, ["-hide_banner", "-loglevel", "error", "-y", ...rows.flatMap((r) => ["-i", r]), "-filter_complex", rows.length > 1 ? `vstack=${rows.length}` : "null", out]);
  await fs.rm(tmp, { recursive: true, force: true });
  return out;
}

export async function loadPersonsReport(jobId: string): Promise<PersonsReport | null> {
  const f = path.join(jobDir(jobId), "persons.json");
  return (await exists(f)) ? readJson(f, PersonsReportSchema) : null;
}

export type { EventsFile };

/** Stems that find a person in event descriptions: their colour and garment ("голубая рубашка" → ["голуб", "рубаш"]). */
export function lookKey(look: string): string[] | null {
  const l = look.toLowerCase().replace(/ё/g, "е");
  const color = /(бел|черн|сер|голуб|син|красн|зелен|желт|оранж|коричн|бежев)\S*/.exec(l)?.[1];
  const garment = /(футбол|рубаш|кофт|худи|толстов|майк|куртк|свитер|лонгслив)\S*/.exec(l)?.[1];
  return color && garment ? [color, garment] : null;
}
