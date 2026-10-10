import { AnthropicApiBackend } from "../src/plan/backend/anthropic.ts";
import { runPlannerLoop } from "../src/plan/loop.ts";
import { BudgetTracker } from "../src/plan/budget.ts";
import { SYSTEM_PROMPT } from "../src/plan/prompt.ts";
import { draftJsonSchema } from "../src/plan/schema-sanitize.ts";
import { makePlannerTools, newToolState } from "../src/plan/tools.ts";
import { GOOD_DRAFT, makeFixtureContext } from "../tests/helpers/plan-fixture.ts";

const ctx = makeFixtureContext();

function fakeClient(messages: any[]) {
  let i = 0;
  return {
    beta: {
      messages: {
        toolRunner(params: any, _opts: any) {
          const runner: any = {
            params: { ...params, messages: [...params.messages] },
            async *[Symbol.asyncIterator]() {
              while (i < messages.length) {
                const m = messages[i++];
                yield m;
                // mimic SDK: after yield, the assistant message is appended; tools would run here
                runner.params.messages.push({ role: "assistant", content: m.content });
                if (m.stop_reason !== "tool_use") break;
              }
            },
          };
          return runner;
        },
      },
    },
  } as any;
}

async function run(label: string, budget: Partial<ConstructorParameters<typeof BudgetTracker>[0]>, contract: "format" | "submit" = "format") {
  const msg = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text: JSON.stringify(GOOD_DRAFT) }],
    usage: { input_tokens: 18000, output_tokens: 15000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
  const backend = new AnthropicApiBackend({ model: "claude-opus-5-5", effort: "medium", client: fakeClient([msg]) });
  const tracker = new BudgetTracker(budget);
  const state = newToolState();
  const tools = makePlannerTools(ctx, state, { framesDir: "/tmp/x", extractFrame: async (_v, _t, f) => f }, { contract, mode: "plan", maxRepairs: 2 });
  const r = await runPlannerLoop(backend, ctx, { kind: "plan", instruction: "2 рилса", presetName: "bold_pop" }, {
    budget: tracker, maxRepairs: 2, contract, tools, state, system: SYSTEM_PROMPT, draftJsonSchema: draftJsonSchema(),
  });
  console.log(`[${label}] status=${r.status} errorCode=${r.errorCode ?? "-"} stopReason=${r.stopReason} usd=${r.usd.toFixed(3)} calls=${r.calls} draft=${!!r.draft} edl=${!!r.resolved?.edl} turn.text=${r.turns[0].text === null ? "null" : "present"} error=${r.error ?? "-"}`);
}

await run("maxUsd=0.30 (one end_turn request costs 0.372)", { maxUsd: 0.30 });
await run("maxUsd=1.50 default (control)", {});
await run("maxCalls=1, default usd (end_turn on the 1st and only allowed call)", { maxCalls: 1 });

// Variant: valid plan arrives on the LAST allowed call (defaults: maxCalls 12), after 11 prior calls
{
  const tracker = new BudgetTracker({});
  for (let k = 0; k < 11; k++) tracker.addRequest(0.05); // 11 earlier calls, $0.55 total, well under maxUsd 1.5
  const msg = { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "text", text: JSON.stringify(GOOD_DRAFT) }], usage: { input_tokens: 18000, output_tokens: 15000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  const backend = new AnthropicApiBackend({ model: "claude-opus-5-5", effort: "medium", client: fakeClient([msg]) });
  const state = newToolState();
  const tools = makePlannerTools(ctx, state, { framesDir: "/tmp/x", extractFrame: async (_v, _t, f) => f }, { contract: "format", mode: "plan", maxRepairs: 2 });
  const r = await runPlannerLoop(backend, ctx, { kind: "plan", instruction: "2 рилса", presetName: "bold_pop" }, { budget: tracker, maxRepairs: 2, contract: "format", tools, state, system: SYSTEM_PROMPT, draftJsonSchema: draftJsonSchema() });
  console.log(`[12th call at defaults] exceeded=${tracker.exceeded()} status=${r.status} errorCode=${r.errorCode ?? "-"} draft=${!!r.draft} edl=${!!r.resolved?.edl} usd=${tracker.usd.toFixed(3)}`);
}
