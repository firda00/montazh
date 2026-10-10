import { EdlSchema } from "../src/schemas/index.ts";
import { resolveDraft } from "../src/plan/resolve.ts";
import { draftFromEdl } from "../src/plan/refs.ts";
import { BUILTIN_PRESETS } from "../src/plan/presets.ts";
import { makeFixtureContext } from "../tests/helpers/plan-fixture.ts";

const calm = makeFixtureContext({ preset: BUILTIN_PRESETS.calm });
const current = EdlSchema.parse({
  outputs: [{ id: "wide_1", aspect: "16:9", clips: [{ src_start: 29.37, src_end: 32.07 }], captions: { enabled: false } }],
  reasoning: "r",
});
const d = draftFromEdl(current, calm);
d.outputs[0].captions = { enabled: true, language: "en" };
d.outputs[0].titles = [{ at: 0, text: "See you soon" }];

for (const mode of ["revise", "plan"] as const) {
  const r = resolveDraft(d, calm, mode === "revise" ? { mode, currentEdl: current } : { mode });
  const o = r.edl!.outputs[0];
  console.log(mode, "errors:", r.errors.length, "captions:", JSON.stringify(o.captions), "titles:", JSON.stringify(o.titles));
  const parsed = EdlSchema.parse(r.edl!).outputs[0];
  console.log(mode, "after EdlSchema.parse captions:", JSON.stringify(parsed.captions), "titles:", JSON.stringify(parsed.titles));
}

// Also: brand-new output id added during revise -> does it get defaults?
const d2 = draftFromEdl(current, calm);
d2.outputs.push({ id: "new_1", aspect: "16:9", clips: [{ start: "p0", end: "p0" }], captions: { enabled: true, language: "ru" }, titles: [{ at: 0, text: "Hi" }], music: { enabled: false } });
d2.brief.outputs_requested = 2;
const r2 = resolveDraft(d2, calm, { mode: "revise", currentEdl: current });
console.log("new output in revise:", JSON.stringify(r2.edl!.outputs[1].captions), JSON.stringify(r2.edl!.outputs[1].titles));
