// Repro for: "contract fallback reuses the first attempt's tool adapters".
// Drives plan() -> runPlanning() with a stubbed Anthropic client.
//   request 1: throws BadRequestError  (format contract) -> PlanError("contract") -> fallback attempt("submit")
//   request 2: the stub "calls" get_scene_details through the adapter the API received, then returns end_turn prose
//   request 3+: end_turn prose
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-ws-skeptic-"));

const { createJob, jobDir, readJson, writeJson } = await import("../src/lib/workspace.ts");
const { MediaSchema, TranscriptSchema, ScenesSchema, HighlightsSchema, PlanReportSchema } = await import("../src/schemas/index.ts");
const { plan } = await import("../src/plan/index.ts");
const { AnthropicApiBackend } = await import("../src/plan/backend/anthropic.ts");
const Anthropic = (await import("@anthropic-ai/sdk")).default;
const { MEDIA, SCENES, HIGHLIGHTS, TINY_JPEG, makeTranscript } = await import("../tests/helpers/plan-fixture.ts");

const job = await createJob("C:/fixture/cafe.mp4");
const dir = jobDir(job.id);
await writeJson(path.join(dir, "media.json"), MediaSchema, MEDIA);
await writeJson(path.join(dir, "transcript.json"), TranscriptSchema, makeTranscript());
await writeJson(path.join(dir, "scenes.json"), ScenesSchema, SCENES);
await writeJson(path.join(dir, "highlights.json"), HighlightsSchema, HIGHLIGHTS);
const extractFrame = async (_v: string, _t: number, file: string) => (await fs.writeFile(file, TINY_JPEG), file);

const sentTools: string[][] = [];
const sentContract: string[] = [];
const toolRunResults: string[] = [];
let n = 0;

const fakeClient = {
  beta: {
    messages: {
      toolRunner(params: any, _opts: any) {
        const callNo = ++n;
        sentTools.push(params.tools.map((t: any) => t.name));
        sentContract.push(params.output_config?.format ? "format" : "no-format");
        return {
          params,
          async *[Symbol.asyncIterator]() {
            if (callNo === 1) {
              throw new Anthropic.BadRequestError(
                400,
                { type: "error", error: { type: "invalid_request_error", message: "output_config.format cannot be combined with tools" } },
                undefined,
                new Headers(),
              );
            }
            if (callNo === 2) {
              // what the real BetaToolRunner does for a tool_use block: parse + run on the adapter it was given
              const t = params.tools.find((x: any) => x.name === "get_scene_details");
              const out = await t.run(t.parse({ id: "s0" }), { signal: undefined });
              toolRunResults.push(typeof out === "string" ? out.slice(0, 60) : JSON.stringify(out).slice(0, 60));
            }
            const content = [{ type: "text", text: "Plan ready; submitting via submit_edl now." }];
            params.messages.push({ role: "assistant", content });
            yield {
              id: `msg_${callNo}`,
              type: "message",
              role: "assistant",
              model: params.model,
              content,
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            };
          },
        };
      },
    },
  },
};

const backend = new AnthropicApiBackend({ model: "claude-opus-5-5", effort: "medium", client: fakeClient as any });

let thrown: any = null;
try {
  await plan(job.id, { instruction: "2 рилса", backendInstance: backend, extractFrame });
} catch (e) {
  thrown = e;
}
const report = await readJson(path.join(dir, "plan.json"), PlanReportSchema);

console.log("plan() threw:", thrown ? `${thrown.name} code=${thrown.code}: ${thrown.message}` : "no");
console.log("report.status      :", report.status);
console.log("report.contract    :", report.contract);
console.log("report.error_code  :", report.error_code);
console.log("report.calls       :", report.calls);
console.log("report.warnings    :", JSON.stringify(report.warnings));
console.log("report.tool_calls  :", JSON.stringify(report.tool_calls));
console.log("tool actually ran  :", JSON.stringify(toolRunResults));
console.log("requests made      :", n);
for (let i = 0; i < sentTools.length; i++) console.log(`  request ${i + 1}: contract=${sentContract[i]} tools=[${sentTools[i].join(", ")}]`);
console.log("submit_edl sent on any request after the first:", sentTools.slice(1).some((l) => l.includes("submit_edl")));
