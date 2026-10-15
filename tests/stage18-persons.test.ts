import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-ws-"));

const { mergeChunk, normId, reconcile, rosterText } = await import("../src/highlights/people.ts");
const { personPicks, arrivalEvent, fallbackTitle } = await import("../src/highlights/perperson.ts");
const { perPersonIntent } = await import("../src/highlights/intent.ts");
const { estimateSeconds } = await import("../src/highlights/plan.ts");
type SportEvent = import("../src/understand/events.ts").SportEvent;
type ShotOwner = import("../src/highlights/people.ts").ShotOwner;
type PlayersFile = import("../src/highlights/people.ts").PlayersFile;

function shot(id: string, key: number, make: boolean, o: Partial<SportEvent> = {}): SportEvent {
  return {
    id,
    type: make ? "shot_make" : "shot_miss",
    outcome: make ? "make" : "miss",
    start: key - 2,
    end: key + 1,
    key,
    confidence: 0.9,
    quality: 0.5,
    distance: "mid",
    description: id,
    target: null,
    speech: false,
    chunk: 0,
    refined: { key, method: "ball", motion_t: key, audio_t: null, motion_peak: 0.8, net_motion: 0.3, local_verdict: make ? "make" : "miss", through_t: make ? key + 0.1 : null, rolled: false },
    ...o,
  };
}

test("normId and the roster carried between chunks", () => {
  assert.equal(normId("p3"), "P3");
  assert.equal(normId("Person 03"), "P3");
  const roster = new Map<string, { look: string; first_seen: number | null; joined_at: number | null }>();
  const a = shot("a", 100, true);
  const b = shot("b", 130, false);
  const r1 = mergeChunk(roster, { people: [{ id: "P1", look: "чёрная футболка", first_seen: null, joined: false }], shots: [{ shot: "S1", person: "p1", x: 0.3, y: 0.6, sure: 0.9 }, { shot: "S9", person: "P1", x: 0, y: 0, sure: 1 }] }, { start: 0, end: 480 }, new Map([["S1", a]]));
  assert.equal(r1.owners.length, 1, "unknown shot ids are ignored");
  assert.equal(r1.owners[0].release_t, 99);
  const r2 = mergeChunk(roster, { people: [{ id: "P2", look: "белая рубашка", first_seen: "01:30", joined: true }], shots: [{ shot: "S1", person: "P2", x: 0.5, y: 0.6, sure: 0.7 }] }, { start: 480, end: 960 }, new Map([["S1", b]]));
  assert.equal(r2.owners[0].person, "P2");
  assert.deepEqual(roster.get("P2"), { look: "белая рубашка", first_seen: 570, joined_at: 570 });
  assert.match(rosterText(roster), /P1: чёрная футболка\n  P2: белая рубашка/);
});

test("reconcile: a shot whose torso colour belongs to another player present at that time is moved", () => {
  const o = (event: string, t: number, person: string, color: number[], sure = 0.9): ShotOwner => ({ event, t, person, model_person: person, x: 0.5, y: 0.6, sure, color, box: null, release_t: t - 1, moved: false, by: "players" as const });
  const black = [20, 22, 25];
  const white = [215, 215, 210];
  const shots = [o("a", 10, "P1", black), o("b", 20, "P1", black), o("c", 30, "P1", [25, 24, 28]), o("d", 40, "P2", white), o("e", 50, "P2", white), o("f", 60, "P2", [210, 212, 205]), o("x", 70, "P1", [212, 214, 208], 0.4)];
  const r = reconcile(shots);
  assert.equal(r.shots.find((s) => s.event === "x")!.person, "P2");
  assert.equal(r.shots.find((s) => s.event === "x")!.moved, true);
  assert.equal(r.shots.filter((s) => s.moved).length, 1);
});

test("personPicks: arrival first, makes in order, the best make last with a replay, rim-outs fill a short reel", () => {
  const events: SportEvent[] = [
    { id: "arr", type: "people_approach", outcome: "none", start: 880, end: 892, key: 885, confidence: 0.9, quality: 0.8, distance: "unknown", description: "подходит, не играл с 2008 года", target: null, speech: true, chunk: 1 },
    shot("m1", 950, true),
    shot("m2", 1000, true, { distance: "long", quality: 0.9 }),
    shot("m3", 1100, true),
    shot("x1", 1050, false),
    shot("x2", 1150, false, { refined: undefined }),
    shot("other", 1200, true),
  ];
  const owners = ["m1", "m2", "m3", "x1", "x2"].map((id) => ({ event: id, t: 0, person: "P2", model_person: "P2", x: 0.5, y: 0.6, sure: 0.8, color: null, box: null, release_t: 0, moved: false, by: "players" as const }));
  const players: PlayersFile = { version: 1, persons: [], shots: [...owners, { ...owners[0], event: "other", person: "P1" }], usage: { requests: 0, input_tokens: 0, output_tokens: 0, cached_chunks: 0 }, warnings: [] };
  const person = { id: "P2", look: "белая рубашка, тёмные брюки", first_seen: 885, joined_at: 886, color: null, shots: 5, makes: 3 };
  assert.equal(arrivalEvent(person, events)?.id, "arr");
  const r = personPicks(person, players, events, { min: 30, max: 90 });
  assert.deepEqual(r.picks.map((p) => p.event.id), ["arr", "m1", "x1", "m3", "x2", "m2"].filter((id) => r.picks.some((p) => p.event.id === id)));
  assert.equal(r.picks[0].role, "social");
  assert.equal(r.picks[r.picks.length - 1].event.id, "m2");
  assert.equal(r.picks[r.picks.length - 1].replay, true);
  assert.ok(!r.picks.some((p) => p.event.id === "other"), "another person's make stays out");
  assert.ok(r.picks.some((p) => p.role === "miss" && p.event.id === "x1"), "a rim-out fills the short reel first");
  const long = personPicks(person, players, events, { min: 10, max: 90 });
  assert.ok(!long.picks.some((p) => p.role === "miss"), "no fillers when the makes reach the minimum");
  assert.ok(estimateSeconds(r.picks[1]) > 3);
  assert.equal(fallbackTitle(person, 0), "ИГРОК: БЕЛАЯ РУБАШКА");
});

test("perPersonIntent: separate reels for every player", () => {
  assert.ok(perPersonIntent("нужны отдельные ролики на каждого, по отдельности"));
  assert.ok(perPersonIntent("нарезка на каждого игрока"));
  assert.ok(!perPersonIntent("нарезка лучших моментов баскетбола"));
});

test("applyFixes: corrections after looking at the sheets move shots and merge people; lookKey finds a person in descriptions", async () => {
  const { applyFixes } = await import("../src/highlights/people.ts");
  const { lookKey } = await import("../src/highlights/perperson.ts");
  const o = (event: string, person: string) => ({ event, t: 0, person, model_person: person, x: 0.5, y: 0.5, sure: 0.8, color: null, box: null, release_t: 0, moved: false, by: "players" as const });
  const p = { version: 1 as const, persons: ["P1", "P2", "P3"].map((id) => ({ id, look: "", first_seen: null, joined_at: null, color: null, shots: 0, makes: 0 })), shots: [o("a", "P1"), o("b", "P2"), o("c", "P3")], usage: { requests: 0, input_tokens: 0, output_tokens: 0, cached_chunks: 0 }, warnings: [] };
  const r = applyFixes(p, { shots: { a: "P2" }, merge: { P3: "P2" }, looks: { P2: "чёрная футболка" } }, new Set(["a", "c"]));
  assert.deepEqual(r.persons.map((x) => [x.id, x.shots, x.makes]), [["P1", 0, 0], ["P2", 3, 2]]);
  assert.equal(r.persons[1].look, "чёрная футболка");
  assert.deepEqual(lookKey("Голубая рубашка, белые штаны"), ["голуб", "рубаш"]);
  assert.equal(lookKey("крупный"), null);
});
