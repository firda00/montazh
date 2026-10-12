import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prompts live in prompts/*.md so they can be read and edited without touching code.
 * A file is a template: `{{name}}` is replaced by fill(); everything else is sent verbatim.
 * Lines starting with `<!--` and ending with `-->` are comments for editors and are stripped.
 * Files are read once per process; PROMPTS_HASH changes whenever any prompt file changes.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PROMPTS_DIR = process.env.VEDIT_PROMPTS_DIR || path.join(ROOT, "prompts");

const cache = new Map<string, string>();

function strip(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !/^\s*<!--.*-->\s*$/.test(l))
    .join("\n")
    .replace(/\n+$/, "");
}

/** The prompt text of prompts/<name>.md (comments stripped, no trailing newline). */
export function loadPrompt(name: string): string {
  let text = cache.get(name);
  if (text === undefined) {
    const file = path.join(PROMPTS_DIR, `${name}.md`);
    try {
      text = strip(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`prompt file missing: ${file} (${err instanceof Error ? err.message : err})`);
    }
    cache.set(name, text);
  }
  return text;
}

/** Replaces every {{key}} with vars[key]; an unknown key is an error, never silently sent to the model. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) => {
    if (!(k in vars)) throw new Error(`prompt template: no value for {{${k}}}`);
    return String(vars[k]);
  });
}

export function promptNames(): string[] {
  return fs
    .readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

/** Short hash over all prompt files — part of the plan report's prompt version. */
export function promptsHash(): string {
  const h = createHash("sha256");
  for (const n of promptNames()) h.update(n).update("\0").update(loadPrompt(n)).update("\0");
  return h.digest("hex").slice(0, 10);
}
