#!/usr/bin/env node
// Thin launcher: runs the TypeScript CLI through tsx without a build step.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const res = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "src", "cli.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);
