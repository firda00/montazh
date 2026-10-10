import { EdlSchema, type Edl, type EdlDiff } from "../schemas/index.ts";

/** Which pipeline stages a change of this EDL field invalidates. */
export const FIELD_STAGES: Record<string, string[]> = {
  clips: ["cut", "design", "render"],
  aspect: ["cut", "design", "render"],
  target_duration: ["cut", "design", "render"],
  transitions: ["cut", "design", "render"],
  captions: ["design", "render"],
  titles: ["design", "render"],
  music: ["design", "render"],
};

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function diffEdl(prevIn: Edl, nextIn: Edl): EdlDiff {
  const prev = EdlSchema.parse(prevIn);
  const next = EdlSchema.parse(nextIn);
  const prevById = new Map(prev.outputs.map((o) => [o.id, o]));
  const nextById = new Map(next.outputs.map((o) => [o.id, o]));
  const diff: EdlDiff = { added: [], removed: [], changed: [], unchanged: [], stages: {} };
  for (const [id, o] of nextById) {
    const p = prevById.get(id);
    if (!p) {
      diff.added.push(id);
      diff.stages[id] = ["cut", "design", "render"];
      continue;
    }
    const fields = (Object.keys(o) as (keyof typeof o)[]).filter((k) => k !== "id" && stable(o[k]) !== stable(p[k])).map(String);
    if (fields.length === 0) diff.unchanged.push(id);
    else {
      diff.changed.push({ id, fields });
      diff.stages[id] = [...new Set(fields.flatMap((f) => FIELD_STAGES[f] ?? ["cut", "design", "render"]))];
    }
  }
  for (const id of prevById.keys()) if (!nextById.has(id)) diff.removed.push(id);
  return diff;
}

/** Output ids whose rough cut must be redone. */
export function needsCut(diff: EdlDiff): string[] {
  return [...diff.added, ...diff.changed.filter((c) => (diff.stages[c.id] ?? []).includes("cut")).map((c) => c.id)];
}
