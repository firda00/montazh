import path from "node:path";
import { CostSchema, type Cost } from "../schemas/index.ts";
import { exists, jobDir, readJson, writeJson } from "./workspace.ts";

export type CostEntry = Cost["entries"][number];

/** Appends one API/compute cost record to workspace/<job>/cost.json. Local work is logged with usd: 0. */
export async function addCost(jobId: string, entry: Omit<CostEntry, "at">) {
  const file = path.join(jobDir(jobId), "cost.json");
  const cost: Cost = (await exists(file)) ? await readJson(file, CostSchema) : { total_usd: 0, entries: [] };
  cost.entries.push({ at: new Date().toISOString(), ...entry });
  cost.total_usd = cost.entries.reduce((s, e) => s + e.usd, 0);
  await writeJson(file, CostSchema, cost);
}
