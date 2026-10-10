import { test } from "node:test";
import assert from "node:assert/strict";
import { planWorkers } from "../src/render/workers.ts";
import { parseProgress, describeFinding } from "../src/render/cli-runner.ts";

test("workers are planned from free memory and CPUs, never below 1", () => {
  assert.deepEqual(planWorkers({ freeMemMB: 2048, totalMemMB: 7860, cpus: 24 }).workers, 3);
  assert.equal(planWorkers({ freeMemMB: 2048, totalMemMB: 7860, cpus: 24 }).lowMemory, false);
  const tight = planWorkers({ freeMemMB: 1200, totalMemMB: 7860, cpus: 24 });
  assert.equal(tight.workers, 1);
  assert.equal(tight.lowMemory, true);
  assert.equal(planWorkers({ freeMemMB: 20000, totalMemMB: 32000, cpus: 16 }).workers, 8, "capped by half the CPUs");
  assert.equal(planWorkers({ freeMemMB: 64000, totalMemMB: 64000, cpus: 64 }).workers, 12, "hard cap");
  assert.equal(planWorkers({ freeMemMB: 2048, totalMemMB: 7860, cpus: 24 }, 2).workers, 2, "explicit request wins");
});

test("progress lines and lint findings are parsed", () => {
  assert.deepEqual(parseProgress('@hf-progress {"code":"encode","done":262,"total":300,"pct":89}'), { code: "encode", done: 262, total: 300, pct: 89 });
  assert.equal(parseProgress("[INFO] something else"), null);
  assert.equal(describeFinding({ severity: "warning", rule: "timeline_track_too_dense", message: "15 clips", line: 40 }), "warning timeline_track_too_dense: 15 clips (line 40)");
});
