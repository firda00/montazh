import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Stage 31, offline: the "promo" make format (reference #16 16:9 SaaS launch, #17 its vertical sibling). The writer's
 * answer normalised into a renderable promo (every UI kind gets the data it animates), the scene plan and its beat
 * structure, cuts snapped to the music, the composition contract (every animation target exists, no CSS transform on
 * tweened nodes, tweens inside the timeline), word rotation timing, count-up values, typing, aspect layouts, the SFX
 * bed, the site brief, the writer with a stubbed model, the narration script, and one end-to-end run with a fake render.
 */
process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s31-ws-"));
process.env.VEDIT_MUSIC_OFFLINE = "1";
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s31-"));
const { normalizePromo, normalizeUi, fallbackPromo, parseCount, formatCount, PromoSchema, UI_KINDS, promoLines } = await import("../src/make/promo/schema.ts");
const { planPromo, timeScenes, snapScenesToBeats, composePromo, textWidthEm, OVERLAP, cameraTweens } = await import("../src/make/promo/compose.ts");
const { buildUi, uiSeconds, statusColor, smoothPath } = await import("../src/make/promo/ui.ts");
const { renderSfxBed, dedupeCues, readWav, writeWav } = await import("../src/make/promo/sfxbed.ts");
const { pageCopy, usableAccent, dominantColor, briefText } = await import("../src/make/promo/site.ts");
const { writePromo, featuresFor, promoAsScript } = await import("../src/make/promo/write.ts");
const { narrationScript, brandCandidates } = await import("../src/make/promo/index.ts");
const { ScriptSchema } = await import("../src/make/script.ts");
const { frameFor } = await import("../src/lib/aspect.ts");
const { SFX_KINDS } = await import("../src/audio/sfx.ts");

const F169 = frameFor("16:9");
const F916 = frameFor("9:16");
const ICONS = new Proxy({} as Record<string, string>, { get: () => '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/></svg>' });
const BRANDS = { instagram: { path: "M0 0h24v24H0z", hex: "#E4405F" }, gmail: { path: "M0 0h24v24H0z", hex: "#EA4335" }, "google sheets": { path: "M0 0h24v24H0z", hex: "#34A853" } };
const compose = (p: ReturnType<typeof fallbackPromo>, frame = F169) => {
  const scenes = planPromo(p, { frame });
  return { scenes, c: composePromo(p, scenes, { frame, fontFaces: "", gsapRel: "assets/gsap.min.js", icons: ICONS, brands: BRANDS }) };
};

/** A stub writer speaking the two-call protocol: the story first (lines + UI kinds), then the screens. */
function mockLlm(base: ReturnType<typeof fallbackPromo>, o: { title?: (call: number) => string; calls?: string[] } = {}) {
  let n = 0;
  return async (q: { prompt: string; schema: Record<string, unknown> }) => {
    o.calls?.push(q.prompt);
    n++;
    const screens = "screens" in ((q.schema as { properties?: Record<string, unknown> }).properties ?? {});
    const data = screens
      ? { screens: [...base.features.map((f) => f.ui), ...(base.proof ? [base.proof.ui] : [])] }
      : { ...base, title: o.title?.(n) ?? base.title, product: { ...base.product }, features: base.features.map((f) => ({ a: f.a, b: f.b, dim: f.dim, theme: f.theme, prop: f.prop, labels: f.labels, ui_kind: f.ui.kind, ui_brief: "" })), proof: base.proof ? { a: base.proof.a, b: base.proof.b, dim: base.proof.dim, ui_kind: base.proof.ui.kind, ui_brief: "" } : { a: "", b: "", dim: "", ui_kind: "", ui_brief: "" } };
    return { data, usage: { input_tokens: 10, output_tokens: 10 } as never, usd: 0.01, estimate: false, model: "mock", provider: "mock" as const };
  };
}

/** every `#id` a tween or helper addresses exists in the markup; tweens sit inside [0, duration] */
function checkContract(html: string, duration: number) {
  const script = html.slice(html.indexOf("const tl = gsap.timeline"));
  const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const ids = new Set(all);
  // ids are unique (a scene's background blob once shared an id with a chat bubble and dragged it sideways)
  assert.equal(ids.size, all.length, `duplicate ids: ${[...new Set(all.filter((x, k) => all.indexOf(x) !== k))].join(", ")}`);
  const sels = [...script.matchAll(/(?:tl\.(?:to|fromTo|set)|__cnt|__type)\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sels.length > 50, `tweens: ${sels.length}`);
  for (const sel of sels) {
    const id = /^#([\w-]+)/.exec(sel)?.[1];
    assert.ok(id, `selector by id: ${sel}`);
    assert.ok(ids.has(id), `animation target exists: ${sel}`);
  }
  // positions (the last numeric argument) are inside the video
  for (const m of script.matchAll(/(?:tl\.(?:to|fromTo|set)\(.*\}),\s*([\d.]+)\);/g)) assert.ok(Number(m[1]) >= 0 && Number(m[1]) <= duration + OVERLAP + 0.01, `tween at ${m[1]} within ${duration}`);
  // nodes the timeline moves never carry a CSS transform of their own
  for (const id of new Set(sels.map((s) => /^#([\w-]+)/.exec(s)![1]))) {
    const tag = new RegExp(`id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
    assert.ok(!/style="[^"]*transform\s*:/.test(tag), `no inline transform on #${id}`);
  }
  assert.equal((html.match(/gsap\.timeline\(/g) ?? []).length, 1, "one timeline");
  assert.match(html, /window\.__timelines\["main"\] = tl;/);
  assert.match(html, new RegExp(`data-duration="${String(Math.round(duration * 1000) / 1000).replace(".", "\\.")}"`));
  assert.ok(!/Math\.random|Date\.now|performance\.now|repeat: -1/.test(script), "deterministic");
}

test("count-up values: currency, grouping, percent, decimals, ru decimal comma, no number", () => {
  const c = parseCount("$2,000")!;
  assert.deepEqual([c.prefix, c.value, c.suffix, c.group], ["$", 2000, "", ","]);
  assert.equal(formatCount(c, 1234.4), "$1,234");
  assert.equal(formatCount(parseCount("75%")!, 41.6), "42%");
  const m = parseCount("€1.2M")!;
  assert.deepEqual([m.prefix, m.value, m.decimals, m.suffix], ["€", 1.2, 1, "M"]);
  assert.equal(formatCount(m, 0.55), "€0.6M");
  const r = parseCount("12,5 млрд ₽")!;
  assert.deepEqual([r.value, r.point, r.suffix], [12.5, ",", " млрд ₽"]);
  assert.equal(formatCount(r, 3.25), "3,3 млрд ₽");
  assert.equal(parseCount("1 500 ₽")!.value, 1500);
  assert.equal(formatCount(parseCount("1 500 ₽")!, 1500), "1 500 ₽");
  assert.equal(parseCount("1,234.5")!.value, 1234.5);
  assert.equal(parseCount("2 и 20"), null);
  assert.equal(parseCount("Instagram"), null);
});

test("normalisation: a sparse writer answer becomes a full promo; lines clamped, dim words checked, UI kinds filled", () => {
  const p = normalizePromo({ title: "T", language: "en", product: { name: "Tracker", accent: "blue" }, hook: { a: "Stop right now please okay", b: "using this." }, pains: [{ a: "Spreadsheets forget", b: "follow-ups.", prop: "weird" }], features: [{ a: "Save any lead", b: "in one click.", dim: "nope", ui: { kind: "form" } }, { a: "x", b: "y", ui: { kind: "unknown" } }, { a: "Track", b: "deals.", ui: { kind: "kanban", rows: [["A", "$1", "Nope"]] } }], outro: { a: "Bye" } });
  assert.equal(p.product.mark, "T");
  assert.equal(p.product.accent, "#2563EB", "invalid colour → default");
  assert.equal(p.hook.a, "Stop right now please", "the hook's bold line keeps 4 words");
  assert.equal(p.pains[0].prop, "none");
  assert.equal(p.features.length, 2, "an unknown UI kind is dropped");
  assert.equal(p.features[0].dim, "", "dim words must be inside b");
  assert.ok(p.features[1].ui.rows.every((r) => p.features[1].ui.columns.includes(r[2])), "kanban cards sit in real columns");
  assert.ok(p.audience.items.length >= 2 && p.outro.cta.includes("Tracker"));
  for (const kind of UI_KINDS) {
    const u = normalizeUi({ kind }, "ru");
    assert.ok(u.items.length || u.rows.length || u.action, `${kind} has data`);
    const b = buildUi({ id: `t-${kind}`, t0: 1, dur: uiSeconds(u), accent: "#2563EB", lang: "ru", icon: () => "<svg></svg>", brand: () => null, product: { name: "X", mark: "X" } }, u);
    assert.ok(b.w > 0 && b.h > 0 && b.html.length > 200 && b.cam.length >= 2, kind);
    for (const k of b.cam) assert.ok(k.t >= 0 && k.t <= uiSeconds(u) + 1e-9 && k.zw > 0, `${kind} camera key in its scene`);
  }
  for (const title of ["table", "slides", "files", "text"]) assert.equal(normalizeUi({ kind: "prompt", title }, "en").title, title);
  assert.equal(normalizeUi({ kind: "prompt", items: [{ label: "a.pdf", value: "", sub: "", icon: "" }, { label: "b.xlsx", value: "", sub: "", icon: "" }] }).title, "files");
  assert.equal(statusColor("Replied")[0], "#16A34A");
  assert.ok(PromoSchema.safeParse(p).success);
});

test("beat structure: hook → dark pains → reveal → rotation → summary → (text → UI) per feature → proof → cloud → tagline → CTA", () => {
  const p = fallbackPromo("Tracker", "Leads, outreach, CRM and invoices.", "en");
  const s = planPromo(p, { frame: F169 });
  const kinds = s.map((x) => x.kind);
  assert.equal(kinds[0], "hook");
  assert.deepEqual(kinds.slice(1, 1 + p.pains.length), p.pains.map(() => "text"));
  assert.ok(s.slice(1, 1 + p.pains.length).every((x) => x.theme === "dark"), "pains on dark");
  assert.deepEqual(kinds.slice(1 + p.pains.length, 4 + p.pains.length), ["logo", "rotate", "text"]);
  const featStart = 4 + p.pains.length;
  for (let k = 0; k < p.features.length; k++) assert.deepEqual([kinds[featStart + 2 * k], kinds[featStart + 2 * k + 1]], ["text", "ui"]);
  assert.deepEqual(kinds.slice(-4), ["ui", "cloud", "tagline", "cta"]);
  const { duration } = timeScenes(s);
  assert.ok(duration > 45 && duration < 80, `length ${duration}`);
  const mean = duration / s.length;
  assert.ok(mean >= 2 && mean <= 3.6, `a new card every 2–3.5 s (${mean.toFixed(2)})`);
  assert.ok(s.every((x) => x.dur >= x.min - 1e-9 && Math.abs(x.dur * 30 - Math.round(x.dur * 30)) < 1e-6), "frame grid, minimum lengths");
  assert.ok(new Set(s.map((x) => x.group)).size <= 10, "narration groups ≤ 10");
  assert.equal(featuresFor(60), 5, "60 s → 5 features");
  assert.equal(featuresFor(45), 3);
  // optional parts: no pains, no rotation, no reveal card (the Gemini-style film)
  const g = normalizePromo({ ...p, pains: [], audience: { lead: "", items: [] }, reveal: { intro: "", show: false }, hook: { ...p.hook, kind: "stack", items: ["Google Sheets", "Gmail"] } }, { language: "en" });
  const gk = planPromo(g, { frame: F916 }).map((x) => x.kind);
  assert.ok(!gk.includes("logo") && !gk.includes("rotate"), gk.join(","));
  assert.equal(gk[1], "text", "straight into the summary");
});

test("composition contract (16:9 and 9:16): every target exists, no CSS transform on tweened nodes, one paused timeline", () => {
  const p = fallbackPromo("Tracker", "Leads, outreach, CRM and invoices.", "en");
  p.integrations = ["Gmail", "Instagram", "LinkedIn", "HubSpot"];
  for (const frame of [F169, F916]) {
    const { scenes, c } = compose(p, frame);
    checkContract(c.html, c.duration);
    assert.match(c.html, new RegExp(`data-width="${frame.w}" data-height="${frame.h}"`));
    assert.equal(c.timings.length, scenes.length);
    // scenes overlap by OVERLAP for the crossfade (except into a hard cut), on alternating tracks
    const clips = [...c.html.matchAll(/<section class="clip scene" id="(s\d+)-clip" data-start="([\d.]+)" data-duration="([\d.]+)" data-track-index="(\d)"/g)];
    assert.equal(clips.length, scenes.length);
    clips.forEach((m, i) => {
      assert.equal(Number(m[4]), 1 + (i % 2));
      const next = scenes[i + 1];
      const want = next && next.trans !== "cut" ? scenes[i].dur + OVERLAP : scenes[i].dur;
      assert.ok(Math.abs(Number(m[3]) - Math.min(want, c.duration - Number(m[2]))) < 0.002, `${m[1]} clip length`);
    });
    // SFX: about one sound per visual event
    assert.ok(c.cues.length >= c.duration * 1.4, `cues ${c.cues.length} over ${c.duration}s`);
    assert.ok(c.cues.every((x) => (SFX_KINDS as readonly string[]).includes(x.kind) && x.t >= 0 && x.t <= c.duration));
    for (const k of ["click", "key", "pop", "whoosh", "chime"]) assert.ok(c.cues.some((x) => x.kind === k), `has ${k}`);
  }
  // 9:16 streams a short line word by word (reference #17), 16:9 stacks two lines
  p.features[0] = { ...p.features[0], a: "Save", b: "fast." };
  const v = compose(p, F916);
  assert.ok(v.scenes.some((x) => x.style === "stream") && compose(p, F169).scenes.every((x) => x.style !== "stream"));
  assert.match(v.c.html, /class="strip /);
});

test("word rotation: each ending blurs in on its slot, the previous one leaves before the next arrives, the last stays", () => {
  const p = fallbackPromo("Tracker", "", "en");
  const { scenes, c } = compose(p);
  const i = scenes.findIndex((x) => x.kind === "rotate");
  const t0 = c.timings[i].start;
  const ins: number[] = [];
  const outs: number[] = [];
  p.audience.items.forEach((_, j) => {
    const mi = new RegExp(`tl\\.fromTo\\("#s${i}-it${j}", \\{ opacity: 0[^\\n]*?, ([\\d.]+)\\);`).exec(c.html);
    assert.ok(mi, `item ${j} enters`);
    ins.push(Number(mi![1]));
    const mo = new RegExp(`tl\\.to\\("#s${i}-it${j}", \\{ opacity: 0[^\\n]*?, ([\\d.]+)\\);`).exec(c.html);
    if (mo) outs.push(Number(mo[1]));
  });
  assert.ok(Math.abs(ins[0] - (t0 + 0.55)) < 0.002);
  for (let j = 1; j < ins.length; j++) {
    assert.ok(Math.abs(ins[j] - ins[j - 1] - 0.95) < 0.002, "one ending every 0.95 s");
    assert.ok(outs[j - 1] < ins[j] && outs[j - 1] + 0.3 <= ins[j] + 0.1, "the old word is leaving as the new one comes");
  }
  assert.equal(outs.length, p.audience.items.length - 1, "the last ending stays on screen");
  assert.ok(ins.at(-1)! + 0.42 < t0 + c.timings[i].duration, "the last word lands inside the scene");
});

test("count-ups land on the written values; typing and the cursor click are on the timeline", () => {
  const p = fallbackPromo("Tracker", "", "en");
  p.proof = { a: "Hit your", b: "daily targets.", dim: "", say: "", ui: normalizeUi({ kind: "metrics", items: [{ label: "Monthly income", value: "$2,000", sub: "", icon: "" }, { label: "Win rate", value: "75%", sub: "", icon: "" }, { label: "Avg deal", value: "$7,700", sub: "", icon: "" }] }) };
  const { c } = compose(p);
  const finals = Object.values(c.counts);
  for (const v of ["$2,000", "75%", "$7,700"]) assert.ok(finals.includes(v), `${v} in ${finals.join(" ")}`);
  for (const [sel, v] of Object.entries(c.counts)) {
    const m = new RegExp(`__cnt\\("${sel}", (\\[[^\\]]*\\]), ([\\d.-]+), ([\\d.-]+),`).exec(c.html);
    assert.ok(m, `count-up for ${sel}`);
    const cv = JSON.parse(m![1]) as [string, string, number, string, string];
    assert.equal(formatCount({ prefix: cv[0], suffix: cv[1], decimals: cv[2], group: cv[3], point: cv[4], value: 0 }, Number(m![3])), v, `${sel} ends on ${v}`);
  }
  // the kanban totals: the dragged card's value leaves one column and joins the next
  const k = normalizeUi({ kind: "kanban", columns: ["New", "Qualified", "Won"], rows: [["A", "$1,000", "New"], ["B", "$2,500", "New"], ["C", "$4,000", "Qualified"]], result: "B" });
  const kb = buildUi({ id: "kb", t0: 0, dur: 4.4, accent: "#2563EB", lang: "en", icon: () => "", brand: () => null, product: { name: "X", mark: "X" } }, k);
  assert.deepEqual(Object.values(kb.counts).sort(), ["$1,000", "$6,500"]);
  // typing: the intro and the name are typed after the logo lands, the caret blinks after
  assert.match(c.html, /__type\("#s\d+-ti", "Introducing ", [\d.]+, [\d.]+\);/);
  assert.match(c.html, /__type\("#s\d+-tn", "Tracker\.", [\d.]+, [\d.]+\);/);
  assert.ok(c.cues.filter((x) => x.kind === "key").length >= 8, "keys while typing");
  assert.ok((c.html.match(/class="u-rip"/g) ?? []).length >= 4, "click ripples");
  assert.ok(smoothPath([[0, 0], [100, 0], [200, 50]]).length >= 200);
});

test("cuts move onto the beat: nearest beat within ±0.3 s, minimum lengths kept, grow-only with a narrator", () => {
  const p = fallbackPromo("Tracker", "", "en");
  const s = planPromo(p, { frame: F169 });
  const beats = Array.from({ length: 200 }, (_, k) => Math.round(k * 0.5 * 1000) / 1000 + 0.11);
  const r = snapScenesToBeats(s, beats);
  assert.ok(r.snapped >= s.length - 3, `snapped ${r.snapped}/${s.length - 1}`);
  let t = 0;
  for (const [i, x] of r.scenes.entries()) {
    t += x.dur;
    if (i < r.scenes.length - 1 && r.snapped === s.length - 1) assert.ok(beats.some((b) => Math.abs(b - t) < 0.02), `cut ${i} at ${t.toFixed(3)} on a beat`);
    assert.ok(x.dur >= x.min - 1e-9);
  }
  const g = snapScenesToBeats(s, beats, { growOnly: true });
  g.scenes.forEach((x, i) => assert.ok(x.dur >= s[i].dur - 1 / 30 - 1e-9, "never shorter with a narrator"));
  assert.equal(snapScenesToBeats(s, [1, 2]).snapped, 0, "too few beats: untouched");
});

test("aspect layouts: the camera frames a UI focus in 16:9 and goes closer in 9:16", () => {
  const keys = [{ t: 0, cx: 700, cy: 400, zw: 1000 }, { t: 2, cx: 800, cy: 420, zw: 900 }];
  const land = cameraTweens("x", keys, { W: 1920, H: 1080, t0: 5, D: 4, cw: 1440, ch: 860 }).join("\n");
  const port = cameraTweens("x", keys, { W: 1080, H: 1920, t0: 5, D: 4, cw: 1440, ch: 860 }).join("\n");
  const sl = Number(/scale: ([\d.]+)/.exec(land)![1]);
  const sp = Number(/scale: ([\d.]+)/.exec(port)![1]);
  assert.ok(Math.abs(sl - (1920 * 0.94) / 1000) < 0.002);
  // the focus point lands in the middle of the frame: x = W/2 − s·cx
  assert.match(land, new RegExp(`x: ${Math.round(960 - sl * 700)}, y: ${Math.round(540 - sl * 400)}`));
  assert.ok(sp > (1080 * 0.94) / 1000, "closer in a tall frame");
  assert.ok(textWidthEm("Spreadsheets") > textWidthEm("forget"));
});

test("SFX bed: same-kind cues collapse, the WAV is as long as the video and carries the sound", async () => {
  const cues = [{ t: 0.5, kind: "pop" as const }, { t: 0.52, kind: "pop" as const }, { t: 0.52, kind: "click" as const }, { t: 9, kind: "pop" as const }];
  assert.deepEqual(dedupeCues(cues, 2).map((c) => [c.t, c.kind]), [[0.5, "pop"], [0.52, "click"]]);
  const blip = new Float32Array(2 * 480).fill(0.5);
  const out = path.join(tmp, "bed.wav");
  const n = await renderSfxBed(cues, 2, out, { load: async () => blip });
  assert.equal(n, 2);
  const pcm = readWav(await fs.readFile(out));
  assert.equal(pcm.length, 2 * 96000);
  assert.ok(pcm[Math.round(0.5 * 48000) * 2 + 10] > 0.05 && Math.abs(pcm[100]) < 1e-6);
  assert.equal(readWav(writeWav(new Float32Array([0.5, -0.5]))).length, 2);
});

test("site brief: copy from the page, a brand colour that is not grey", () => {
  const html = `<html><head><title>Tracker | CRM for freelancers</title><meta name="description" content="Leads, outreach &amp; invoices."><meta name="theme-color" content="#4F46E5"><style>p{}</style></head><body><script>var x="<p>no</p>"</script><h1>Never miss a follow-up</h1><p>Save any lead in one click.</p><li>No duplicates</li></body></html>`;
  const c = pageCopy(html);
  assert.equal(c.name, "Tracker");
  assert.equal(c.description, "Leads, outreach & invoices.");
  assert.match(c.text, /# Never miss a follow-up\nSave any lead in one click\.\nNo duplicates/);
  assert.ok(!c.text.includes("no"), "scripts dropped");
  assert.equal(c.themeColor, "#4F46E5");
  assert.ok(usableAccent("#4F46E5") && !usableAccent("#FFFFFF") && !usableAccent("#777777") && !usableAccent("#111111"));
  const px = new Uint8Array(3 * 400);
  for (let i = 0; i < 400; i++) px.set(i < 300 ? [250, 250, 250] : [40, 90, 220], i * 3);
  const dom = dominantColor(px)!;
  assert.ok(usableAccent(dom) && parseInt(dom.slice(5, 7), 16) > parseInt(dom.slice(1, 3), 16), dom);
  assert.match(briefText({ url: "https://t.test", domain: "t.test", name: "Tracker", title: "", description: "d", text: "", accent: null, accentFrom: null, screenshot: null }), /^SITE \(t\.test\)/);
});

test("writer: story then screens, normalised; a banned phrase sends the promo back once", async () => {
  const calls: string[] = [];
  const base = fallbackPromo("Tracker", "", "en");
  const llm = mockLlm(base, { calls, title: (n) => (n === 1 ? "A game changer for freelancers" : "Tracker for freelancers") });
  const r = await writePromo("Tracker — CRM for freelancers", llm as never, { language: "en", seconds: 60, site: { url: "https://t.test", domain: "t.test", name: "Tracker", title: "", description: "", text: "Save leads.", accent: "#4F46E5", accentFrom: "theme-color", screenshot: null } });
  assert.equal(calls.length, 4, "story + screens, then once more after the cliché");
  assert.match(calls[0], /SITE \(t\.test\)/);
  assert.match(calls[0], /5 features/);
  assert.match(calls[1], /1\. form — «Save any lead in one click\.»/, "the screens call carries the plan");
  assert.equal(r.promo.title, "Tracker for freelancers");
  assert.equal(r.promo.product.accent, "#4F46E5", "the site's colour wins");
  assert.deepEqual(r.promo.features.map((f) => f.ui.kind), base.features.map((f) => f.ui.kind));
  assert.equal(r.promo.proof?.ui.kind, "tiles");
  assert.equal(r.remaining.length, 0);
  assert.equal(r.usd, 0.04);
  assert.ok(promoAsScript(r.promo).beats.length === promoLines(r.promo).length);
});

test("narration: one beat per scene group (≤ 10), valid as a make script; brand candidates include the struck-out apps", () => {
  const p = fallbackPromo("Tracker", "", "en");
  p.features[0] = { ...p.features[0], prop: "strike", labels: ["Google Sheets"] };
  const scenes = planPromo(p, { frame: F169 });
  const s = narrationScript(p, scenes);
  assert.ok(ScriptSchema.safeParse(s).success);
  assert.equal(s.beats.length, new Set(scenes.map((x) => x.group)).size);
  assert.ok(s.beats.every((b) => b.voiceover && b.voiceover.length > 3));
  const sum = s.beats.reduce((n, b) => n + b.seconds, 0);
  assert.ok(Math.abs(sum - timeScenes(scenes).duration) < 0.05, "the narration beats cover the film");
  assert.ok(brandCandidates(p).includes("Google Sheets"));
});

test("end to end (fake render, no network): promo.json, project, lint, SFX bed and mix, report", { timeout: 300_000 }, async () => {
  const { make } = await import("../src/make/index.ts");
  const { ffmpeg } = await import("../src/lib/ffmpeg.ts");
  const base = fallbackPromo("Tracker", "Leads, outreach, CRM and invoices.", "en");
  const llm = mockLlm(base);
  const r = await make("Tracker — CRM for freelancers", {
    format: "promo",
    aspect: "9:16",
    language: "en",
    llm: llm as never,
    music: "none",
    fakeRender: async (_dir, out) => {
      await fs.mkdir(path.dirname(out), { recursive: true });
      await ffmpeg(["-f", "lavfi", "-i", "color=c=white:s=180x320:r=10:d=70", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out]);
    },
  });
  assert.equal(r.format, "promo");
  assert.equal(r.aspect, "9:16");
  assert.ok(r.sfx > 40, `sfx ${r.sfx}`);
  assert.ok(r.duration > 40);
  const dir = path.dirname(r.output);
  const promo = PromoSchema.parse(JSON.parse(await fs.readFile(path.join(dir, "promo.json"), "utf8")));
  assert.equal(promo.product.name, "Tracker");
  const lint = JSON.parse(await fs.readFile(path.join(dir, "make", "project", "lint.json"), "utf8")) as { errorCount: number };
  assert.equal(lint.errorCount, 0, "lint: no errors");
  const html = await fs.readFile(path.join(dir, "make", "project", "index.html"), "utf8");
  assert.match(html, /data-fit="s\d+-tx"/);
  assert.match(html, /@font-face \{ font-family: "VInter"/);
});

test("bot: «🎬 Промо / объяснялка (YouTube)» on the make card → a promo job, 16:9, no voice; the other frame keeps the format", async () => {
  const { createBot, MSG } = await import("../src/bot/index.ts");
  const { fakeTelegram } = await import("./helpers/fake-telegram.ts");
  const tg = fakeTelegram();
  const out = path.join(tmp, "output_make.mp4");
  await fs.writeFile(out, "mp4");
  const makes: { topic: string; aspect?: string; voice?: string; format?: string; fromJob?: string }[] = [];
  const bot = await createBot({
    token: "t",
    workspace: await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s31-bot-")),
    callMethod: tg.callMethod,
    download: tg.download,
    onLog: () => {},
    statusEditMs: 0,
    cleanupIntervalMs: 0,
    broadcastDelayMs: 0,
    albumDelayMs: 0,
    onboarding: false,
    quotas: false,
    make: async (a) => {
      makes.push(a);
      a.onJob(`20261019-p${makes.length}`);
      return { jobId: `20261019-p${makes.length}`, title: a.topic, outputs: [{ id: "make", file: out, duration: 60, aspect: a.aspect }] };
    },
  });
  await bot.handleUpdate(tg.text(4, MSG.menu.make));
  await bot.handleUpdate(tg.text(4, "Tracker — CRM для фрилансеров"));
  const card = tg.sent(4, "Тема: «Tracker — CRM для фрилансеров»")!;
  const id = tg.messageIdOf(card)!;
  const kb = tg.buttons(tg.keyboardOf(card));
  assert.ok(kb.includes("🎬 Промо / объяснялка (YouTube)=K:f:promo"), kb.join(" | "));
  assert.equal(kb.at(-1), "▶️ Начать=K:go", "Start stays last");
  await bot.handleUpdate(tg.press(4, "K:f:promo", id));
  await bot.handleUpdate(tg.press(4, "K:go", id));
  await bot.idle();
  assert.deepEqual([makes[0].format, makes[0].aspect, makes[0].voice], ["promo", "16:9", undefined]);
  const jobId = bot.db.lastJob(4)!.id;
  await bot.handleUpdate(tg.press(4, `F:${jobId}`, 1));
  await bot.idle();
  assert.deepEqual([makes[1].format, makes[1].aspect, makes[1].fromJob], ["promo", "9:16", "20261019-p1"]);
  bot.close();
});

test("narration: groups describe what is on screen, the writer fits each line to its seconds", async () => {
  const { narrationGroups } = await import("../src/make/promo/index.ts");
  const { writeNarration, narrationWords } = await import("../src/make/promo/write.ts");
  const p = fallbackPromo("Tracker", "", "ru");
  const scenes = planPromo(p, { frame: F169 });
  const groups = narrationGroups(p, scenes);
  assert.equal(groups.length, new Set(scenes.map((s) => s.group)).size);
  assert.match(groups[0].screen, /^hook: «/);
  assert.ok(groups.some((g) => /UI form: /.test(g.screen)));
  let asked = "";
  const llm = async (q: { prompt: string }) => {
    asked = q.prompt;
    return { data: { lines: groups.map((_, k) => (k === 0 ? "Слишком длинная строка ".repeat(20) : `Строка ${k + 1}.`)) }, usage: { input_tokens: 1, output_tokens: 1 } as never, usd: 0.002, estimate: false, model: "mock", provider: "mock" as const };
  };
  const n = await writeNarration(p, groups, llm as never);
  assert.match(asked, new RegExp(`Exactly ${groups.length} lines`));
  assert.equal(n.lines.length, groups.length);
  assert.ok(n.lines[0].split(" ").length <= narrationWords(groups[0].seconds), "cut back to the budget");
  const s = narrationScript({ ...p, narration: n.lines }, scenes);
  assert.equal(s.beats[1].voiceover, "Строка 2.");
});

test("9:16 rules: a line streams only when it fits, UI built for the vertical frame keeps its whole width in view", async () => {
  const { vcam } = await import("../src/make/promo/ui.ts");
  const p = fallbackPromo("Tracker", "", "en");
  p.outro = { ...p.outro, a: "Stop running your outreach", b: "from a spreadsheet." };
  p.features[0] = { ...p.features[0], a: "Save", b: "fast." };
  const s = planPromo(p, { frame: F916 });
  assert.equal(s.find((x) => x.kind === "tagline")!.style, "stack", "a long line is stacked, not panned off the edge");
  assert.equal(s.find((x) => x.text?.a === "Save")!.style, "stream");
  assert.ok(s.every((x) => x.trans !== "iris"), "no iris circle over words");
  // the vertical camera shows the whole canvas width (UI ≈ 87 % of the frame)
  const keys = vcam(860, 900, 4);
  assert.ok(keys.every((k) => k.zw >= 860 - 40));
  const tall = vcam(820, 2400, 4);
  assert.ok(tall[0].cy < tall.at(-1)!.cy, "a tall canvas is travelled top → bottom");
  for (const kind of ["prompt", "table", "tiles", "metrics", "list", "chat", "form", "search", "folders", "chart", "invoice"] as const) {
    const u = normalizeUi({ kind }, "ru");
    const b = buildUi({ id: `v-${kind}`, t0: 0, dur: 4.5, accent: "#2563EB", lang: "ru", icon: () => "<svg></svg>", brand: () => null, product: { name: "X", mark: "X" }, portrait: true }, u);
    assert.ok(b.fitsPortrait, `${kind} has a vertical layout`);
    assert.ok(b.w <= 1000, `${kind}: narrow canvas (${b.w})`);
  }
});

test("sound design: deterministic variation, motion pan, risers into reveals, ticks on counters", async () => {
  const { cueVariation, BED_UNDER_MUSIC_LU } = await import("../src/make/promo/sfxbed.ts");
  const a = cueVariation({ t: 1.234, kind: "key" }, 3);
  assert.deepEqual(cueVariation({ t: 1.234, kind: "key" }, 3), a, "same cue → same variation (re-renders sound the same)");
  const keys = Array.from({ length: 12 }, (_, k) => cueVariation({ t: 1 + k * 0.08, kind: "key" }, k).rate);
  assert.ok(new Set(keys.map((r) => r.toFixed(3))).size >= 8, "keys do not repeat identically");
  assert.ok(keys.every((r) => r > 0.92 && r < 1.08));
  assert.equal(cueVariation({ t: 2, kind: "whoosh", pan: 0.35 }, 0).pan, 0.35, "a motion pan is kept");
  assert.ok(BED_UNDER_MUSIC_LU >= 5 && BED_UNDER_MUSIC_LU <= 10);
  const p = fallbackPromo("Tracker", "", "en");
  p.proof = { a: "Hit your", b: "targets.", dim: "", say: "", ui: normalizeUi({ kind: "tiles" }) };
  const { scenes, c } = compose(p);
  const logo = c.timings[scenes.findIndex((x) => x.kind === "logo")].start;
  assert.ok(c.cues.some((x) => x.kind === "riser" && Math.abs(x.t - (logo - 1.15)) < 0.01), "a riser into the logo");
  assert.ok(c.cues.some((x) => x.kind === "impact" && Math.abs(x.t - (logo + 0.05)) < 0.01), "a low hit on it");
  const tiles = c.timings[scenes.findIndex((x) => x.ui?.kind === "tiles")];
  assert.ok(c.cues.filter((x) => x.kind === "tick" && x.t >= tiles.start && x.t <= tiles.start + tiles.duration).length >= 6, "ticks while counting");
  assert.ok(c.cues.some((x) => x.kind === "swipe" && (x as { pan?: number }).pan === 0.3), "the drag pans with the card");
});

test("anti-slop visuals: «strike» is drawn as the swap flip (no red slash), emoji never reach the screen", async () => {
  const { BANNED_VISUAL_TROPES } = await import("../src/make/promo/schema.ts");
  const p = normalizePromo({ ...fallbackPromo("Gemini", "", "ru"), product: { name: "Gemini", mark: "G", logo: "sparkle", accent: "#4285F4" }, features: [{ a: "Google Sheets? 🚀", b: "Теперь — через Gemini. ✨", prop: "strike", labels: ["Google Sheets"], ui: { kind: "prompt", title: "table" } }, { a: "Gmail?", b: "Письмо напишет Gemini.", prop: "swap", labels: ["Gmail"], ui: { kind: "prompt", title: "text" } }] }, { language: "ru" });
  assert.deepEqual(p.features.map((f) => f.prop), ["swap", "swap"]);
  assert.equal(p.features[0].a, "Google Sheets?");
  assert.equal(p.features[0].b, "Теперь — через Gemini.");
  const { c } = compose(p, F916);
  assert.ok(!/class="sline"|#EF4444/.test(c.html), "no red slash");
  assert.match(c.html, /class="swap" id="s\d+-sw"/);
  assert.match(c.html, /tl\.fromTo\("#s\d+-sf", \{ rotationY: 0 \}, \{ rotationY: 180/);
  // the back face carries a static CSS transform, the tweened node (the flip wrapper) does not
  assert.ok(!/id="s\d+-sf"[^>]*style="[^"]*transform/.test(c.html));
  assert.ok(BANNED_VISUAL_TROPES.some((t) => /strike/.test(t)));
  assert.match(fs ? await fs.readFile("prompts/make.promo.system.md", "utf8") : "", /NEVER \(cheap/);
});
