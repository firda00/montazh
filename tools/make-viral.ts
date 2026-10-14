// Runs the bot's multi-video pipeline from the console: npx tsx tools/make-viral.ts <video1> <video2> [...] [-- "instruction"]
import { MSG, runFullPipeline } from "../src/bot/index.ts";
const args = process.argv.slice(2);
const dash = args.indexOf("--");
const files = dash >= 0 ? args.slice(0, dash) : args;
const instruction = dash >= 0 ? args.slice(dash + 1).join(" ") : MSG.viral;
const ac = new AbortController();
const r = await runFullPipeline({
  source: files[0],
  sources: files,
  instruction,
  preset: "bold_pop",
  progress: async (t) => console.log(t),
  onJob: (id) => console.log(`job ${id}`),
  signal: ac.signal,
  log: (l) => console.log(l),
});
console.log(JSON.stringify({ jobId: r.jobId, outputs: r.outputs, failed: r.failed, reasoning: r.reasoning }, null, 1));
