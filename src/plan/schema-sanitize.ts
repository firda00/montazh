import { z } from "zod";
import { PlanDraftSchema } from "../schemas/index.ts";

const DROP = new Set(["$schema", "default", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "multipleOf", "uniqueItems", "maxItems"]);
const KEEP_FORMATS = new Set(["date-time", "date", "time", "email", "uri", "uuid", "ipv4", "ipv6"]);

/**
 * Makes a zod-generated JSON Schema acceptable for tool input_schema / output_config.format:
 * drops numeric/string constraints the API rejects, keeps enum/const/anyOf/$ref,
 * forces additionalProperties:false on every object.
 */
export function sanitizeJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeJsonSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (DROP.has(k)) continue;
    if (k === "minItems" && typeof v === "number" && v > 1) continue;
    if (k === "format" && typeof v === "string" && !KEEP_FORMATS.has(v)) continue;
    if (k === "properties" && v && typeof v === "object") {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, sanitizeJsonSchema(pv)]));
      continue;
    }
    if (k === "$defs" || k === "definitions") {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([dk, dv]) => [dk, sanitizeJsonSchema(dv)]));
      continue;
    }
    out[k] = typeof v === "object" ? sanitizeJsonSchema(v) : v;
  }
  if (out.type === "object" || out.properties) out.additionalProperties = false;
  return out;
}

export function zodToApiSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitizeJsonSchema(z.toJSONSchema(schema, { reused: "ref" })) as Record<string, unknown>;
}

export function draftJsonSchema(): Record<string, unknown> {
  return zodToApiSchema(PlanDraftSchema);
}
