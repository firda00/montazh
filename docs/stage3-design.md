# Stage 3 design — EDL planner agent (workflow synthesis, 2026-10-10)

**Decision:** FINAL = context-first (winner by 2 of 3 judges and highest total) with these grafts: hybrid-budget's BudgetTracker (USD + wall clock via AbortSignal + calls/repairs/tools/frames), credential-based backend auto-selection, FIELD_STAGES diff→stage mapping for revise, heuristic '[mock]' planner, cache-health warning, per-tool-call trace; tools-first's sanitizeJsonSchema (+snapshot test), one-shot max_tokens retry, preview-frame ms cache/semaphore/previews_left, non-error budget texts, --dry-run with countTokens, per-iteration usage in plan.json, is_stub flag; judges' gap refs (gN) and word refs (pN.wK) so dynamic 2–6 s cuts stay expressible. Factual fixes applied: max_iterations semantics (last iteration's tools DO run), no runner.params.messages append after a consumer break, VEDIT_WORKSPACE must be set before a dynamic import, no unsourced prices (only claude-opus-5-5 priced; others logged unpriced), no require.resolve-in-ESM / binary-presence auth probe, class-based (never string-matched) feature detection, ~300 tokens per 640×360 frame, Agent SDK effort/thinking/outputFormat/resume verified to exist, MCP SDK already installed, explicit client timeout bypasses the 21333 non-streaming guard, SDK betaZodOutputFormat strips enum/const (send a raw json_schema format instead), --skip-understand + --prompt is a nothing_to_plan error, server-side fallbacks opt-in only. Contract: structured output (output_config.format) + the four SPEC tools, with class-based feature detection that flips to a submit_edl tool contract if the API rejects the combination.

# Stage 3 — Planner agent: final design (synthesis)

Base: **context-first** (ids-not-seconds draft, structured output, harness-side validation, repair-on-failure). Grafted: budget tracker with wall clock, credential-based backend selection, FIELD_STAGES revise diff, heuristic mock, schema sanitizer, gap/word refs, max_tokens retry, preview-frame cache, cache-health reporting. Every factual error the judges found is corrected in §12.

Verified in this session against the installed code (not from memory): `@anthropic-ai/sdk` 0.133.0 `BetaToolRunner.js` iterator, `messages.js` timeout guard, `transformJSONSchema` behaviour, `@anthropic-ai/claude-agent-sdk` 0.3.296 `sdk.d.ts` option/result types, `@modelcontextprotocol/sdk` 1.32.1 presence, `npm run typecheck` (green today), credential files on this machine (existence only).

---

## 1. Architecture in one paragraph

`plan(jobId, opts)` loads `media.json`, `transcript.json`, `scenes.json`, `highlights.json` and a preset, builds one deterministic **pack** (every phrase `pN`, scene `sN`, silence gap `gN`, ranked highlight `hN`), and asks `claude-opus-5-5` for a `PlanDraft` whose clips are **refs, not seconds** (`{start:"p3", end:"p5"}`). The harness resolves refs to times (SPEC §5.3's "phrase or scene boundary" holds by construction), snaps scene edges that land inside a word (`snapClipsToWords`, ≤0.4 s), runs all other checks, and writes `edl.json`. Only when errors remain does it append the issue list to the same conversation and ask for a corrected full plan (max 2 repairs). Happy path = 1 API request; with a frame check or a repair = 2. The four SPEC tools (`get_transcript_range`, `get_scene_details`, `preview_frame`, `validate_edl`) are always declared; the prompt says when each is worth a round trip. Backends: `api` (Anthropic SDK beta toolRunner, needs ANTHROPIC_API_KEY), `agent` (Claude Agent SDK on the Claude Code login), `mock` (tests/demo). Stage 5 `revise()` reuses the pack, tools, loop and validator; `diffEdl` + `FIELD_STAGES` decide which outputs to re-cut.

```
vedit run/plan/revise ─► plan()/revise() ─► buildPlanContext ─► selectBackend ─► runPlannerLoop
                                                                                   │  start()/continue()
                                                                     PlannerBackend ◄┘  (api | agent | mock)
                                                                                   │ tools: get_transcript_range, get_scene_details, preview_frame, validate_edl [+ submit_edl in 'submit' contract]
                                             resolveDraft ◄── PlanDraft (refs) ◄───┘
                                                 │ ok → edl.json + plan.json + cost.json
                                                 │ errors → repair (≤2) → partial (valid outputs) → failed (edl.draft.json)
```

---

## 2. Backend abstraction and default selection

### 2.1 Interface (`src/plan/backend/types.ts`)

```ts
export type BackendName = 'api' | 'agent' | 'mock';
export type Contract = 'format' | 'submit';          // 'format' = output_config.format; 'submit' = submit_edl tool (fallback, see §6.4)
export interface StartRequest {
  system: string;                                     // frozen SYSTEM_PROMPT (+ SUBMIT_ADDENDUM when contract === 'submit')
  packText: string;                                   // job-static, byte-stable (cached block)
  taskText: string;                                   // varying
  tools: PlannerTool[];                               // name-sorted; [] allowed (--no-tools)
  draftJsonSchema: Record<string, unknown>;           // sanitizeJsonSchema(z.toJSONSchema(PlanDraftSchema, { reused: 'ref' }))
  contract: Contract;
  maxTokens: number;                                  // 16000, 32000 on the max_tokens retry
  budget: BudgetTracker;                              // usd/calls accounting + AbortSignal (wall clock)
}
export interface CallUsage { model: string; usage: NormalizedUsage; usd: number; priced: boolean; stop_reason: string | null; tools: string[] }
export interface NormalizedUsage { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; thinking_tokens: number }
export interface Turn {
  text: string | null;                                // final assistant text (JSON in 'format' contract)
  stopReason: 'end_turn' | 'max_tokens' | 'refusal' | 'max_iterations' | 'budget' | 'aborted' | 'error';
  refusalCategory?: string; error?: string;
  calls: number; perCall: CallUsage[]; toolCalls: ToolCallRecord[];
  handle: unknown;                                    // backend-private continuation state
}
export interface PlannerBackend {
  readonly name: BackendName; readonly model: string; readonly note: string;
  start(req: StartRequest): Promise<Turn>;
  continue(prev: Turn, userText: string, req: StartRequest): Promise<Turn>;   // repair / nudge, append-only
}
export class PlanError extends Error { constructor(msg: string, public code: 'auth'|'model'|'rate_limit'|'network'|'api'|'refusal'|'max_tokens'|'loop'|'invalid'|'nothing_to_plan'|'no_backend'|'budget'|'missing_inputs', public report?: Partial<PlanReport>) }
```

Tools are defined once (`PlannerTool = { name, description, inputShape: z.ZodRawShape, run(input, ctx: { signal?: AbortSignal }): Promise<ToolResult> }`, `ToolResult = { text: string; images?: { base64: string; mediaType: 'image/jpeg' }[]; isError?: boolean }`) and adapted per backend.

### 2.2 Selection (`src/plan/backend/index.ts`)

`selectBackend(choice: 'auto'|'api'|'agent'|'mock', opts, env = process.env, probe = { credentialsFileExists })` → `{ backend, note }`:

1. `choice === 'mock'` → only via `PlanOptions.backendInstance` (tests) or `--backend mock` (heuristic planner, reasoning prefixed `[mock]`); **never auto-selected** (same honesty rule as the `[stub]` vision provider).
2. `auto` / `api`: `env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN` set → **api** (note `backend: api — Claude API key`). `api` requested without a key → `PlanError('auth')` before any work.
3. `auto` / `agent`: `env.CLAUDE_CODE_OAUTH_TOKEN` set OR `exists(join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json'))` (existence only; the file is never read) → **agent** (note `backend: agent — вход Claude Code по подписке (ANTHROPIC_API_KEY не задан); стоимость — оценка SDK, не счёт`).
4. else `PlanError('no_backend', 'нет ANTHROPIC_API_KEY и нет входа Claude Code: задайте ключ в .env, выполните `claude /login`, или передайте --edl <file>')`.

On this machine today: no key, no `.env`, credentials file present → **agent**. `cli.ts` already calls `process.loadEnvFile()` so a future `.env` with `ANTHROPIC_API_KEY` flips the default to `api` automatically.

Policy note printed once and stored in `plan.json.backend_note`: Anthropic's Agent SDK docs state third-party developers may not offer claude.ai login in their products; personal, non-distributed use of one's own subscription is not addressed. `api` is the supported SPEC §4 path. Not legal advice (open question §13).

### 2.3 `api` backend — exact calls (`src/plan/backend/anthropic.ts`)

```ts
import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError';
import type { BetaToolRunnerParams } from '@anthropic-ai/sdk/lib/tools/BetaToolRunner';
import { z } from 'zod';

const client = opts.client ?? new Anthropic({ maxRetries: 3, timeout: 600_000 });
// explicit client timeout => messages.js:39-43 skips calculateNonstreamingTimeout, so max_tokens 32000 non-streaming is allowed.
// BetaToolRunnerRequestOptions only carries headers/signal/fallbackState, hence timeout/maxRetries live on the client.

const apiTools = req.tools
  .map((t) => ({
    ...betaZodTool({
      name: t.name, description: t.description, inputSchema: z.object(t.inputShape),
      run: async (args, c) => {
        const r = await t.run(args, { signal: c?.signal ?? undefined });
        if (r.isError) throw new ToolError(r.text);                       // is_error: true tool_result
        return r.images?.length
          ? [{ type: 'text', text: r.text }, ...r.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.base64 } }))]
          : r.text;
      },
    }),
    input_schema: sanitizeJsonSchema(z.toJSONSchema(z.object(t.inputShape), { reused: 'ref' })), // strips $schema/min/max/…, forces additionalProperties:false
    // no strict:true (unverified with zod-4 output); no cache_control on tools (system breakpoint covers tools+system)
  }))
  .sort((a, b) => a.name.localeCompare(b.name));                           // built once per backend instance, reused for every request

const systemBlocks = [{ type: 'text' as const, text: req.system, cache_control: cacheMark(ttl) }];
const seed = [{ role: 'user' as const, content: [
  { type: 'text' as const, text: req.packText, cache_control: cacheMark(ttl) },   // shared prefix
  { type: 'text' as const, text: req.taskText },                                  // varying suffix, no marker
] }];

function makeRunner(messages, maxTokens) {
  return client.beta.messages.toolRunner({
    model, max_tokens: maxTokens,
    max_iterations: Math.max(1, Math.min(8, req.budget.remainingCalls())),   // 0/undefined = unlimited, never pass 0
    stream: false as const,                                                   // object literal + as const => BetaToolRunner<false> (TS overload gotcha)
    output_config: { effort, ...(req.contract === 'format' ? { format: { type: 'json_schema' as const, schema: req.draftJsonSchema } } : {}) },
    cache_control: { type: 'ephemeral' as const },                            // automatic breakpoint walks the tool_use/tool_result tail
    system: systemBlocks, tools: apiTools, messages,
    // thinking omitted (= adaptive, always on for Opus 5.5); no tool_choice (any/tool => 400); no temperature/top_p/top_k; no prefill;
    // fallbacks only when VEDIT_FALLBACKS=1: betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'
  } satisfies BetaToolRunnerParams, { signal: req.budget.signal });
}

for await (const message of runner) {                     // one API request per iteration, yielded BEFORE its tools run
  const priced = usdForUsage(message.model, message.usage);
  req.budget.addRequest(priced.usd); perCall.push({ model: message.model, usage: normalizeUsage(message.usage), ...priced, stop_reason: message.stop_reason, tools: toolNames(message) });
  last = message;
  if (req.budget.exceeded()) { stopped = 'budget'; break; }   // consumer break: this message's tools never run and nothing is appended to runner.params.messages
}
```

After a natural end: `history = [...runner.params.messages]` (append-only; includes every assistant message and the tool_result user messages the runner pushed). Stop mapping: `end_turn`→`end_turn`; `max_tokens`→`max_tokens`; `refusal`→`refusal` (+ `last.stop_details?.category`); `tool_use` at loop end → `max_iterations` — **the cap check sits at the top of the runner loop, so the last allowed iteration's tools did run and `history` ends with their `tool_result` message** (verified in `BetaToolRunner.js`). Never `await runner.done()` after a consumer break (completion resolves only on a normal loop end).

`continue(prev, text)`: `makeRunner([...prev.handle.history, { role: 'user', content: text }], maxTokens)` — identical tools/system/effort/model objects ⇒ tools+system+pack are cache reads; append-only keeps Opus 5.5 thinking-block binding valid. If `prev.stopReason === 'max_iterations'` the history ends with an **unsent** tool_result user message, so the repair text is appended as a text block to that message (it was never sent, so it is not a history edit). `max_tokens`: retry once with `maxTokens = 32000` on `history` minus the trailing truncated assistant message (received, never sent back ⇒ not an edit); second truncation → `stopReason 'max_tokens'`.

Typed error mapping (most specific first, never string-matched): `AuthenticationError`→`PlanError('auth')`; `NotFoundError`→`'model'`; `RateLimitError` (after SDK retries)→`'rate_limit'`; `APIConnectionError` (checked before `APIError`)→`'network'`; `BadRequestError` on the **first request of a job** with `contract === 'format'` and `tools.length > 0` → feature detection: rebuild with `contract = 'submit'` (§6.4) and retry once, recording warning `api_rejected_format_with_tools`; any other `BadRequestError`/`APIError`→`'api'` with status + requestID; `APIUserAbortError`→`'budget'` (wall clock). Usage accrued before an error is still returned on the thrown `PlanError.report` so cost.json gets it.

### 2.4 `agent` backend — exact calls (`src/plan/backend/agent.ts`)

```ts
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os';

const server = createSdkMcpServer({ name: 'vedit', version: '1.0.0',
  tools: req.tools.map((t) => tool(t.name, t.description, t.inputShape, async (args) => {
    const r = await t.run(args, {});
    return { content: [{ type: 'text', text: r.text }, ...(r.images ?? []).map((i) => ({ type: 'image', data: i.base64, mimeType: i.mediaType }))], ...(r.isError ? { isError: true } : {}) };
  }, { alwaysLoad: true })) });                                    // tool() takes the raw zod shape; alwaysLoad keeps schemas in the first prompt

const options = {
  systemPrompt: req.system + AGENT_ADDENDUM,                        // one line: tool names are prefixed mcp__vedit__
  model, effort, thinking: { type: 'adaptive' as const },           // Options.effort / Options.thinking exist in sdk.d.ts 0.3.296 (l.1918 / l.1911)
  ...(req.contract === 'format' ? { outputFormat: { type: 'json_schema' as const, schema: req.draftJsonSchema } } : {}),  // sdk.d.ts l.1980
  mcpServers: { vedit: server }, tools: [], allowedTools: ['mcp__vedit__*'], disallowedTools: ['ToolSearch'],
  permissionMode: 'dontAsk' as const, settingSources: [],
  maxTurns: 12, maxBudgetUsd: req.budget.maxUsd,
  cwd: os.tmpdir(),                                                 // ASCII cwd; the tools never touch cwd
  env: { ...process.env, CLAUDE_CODE_PROJECT_DIR_NAME: 'vedit' },   // env REPLACES the subprocess env: spread it so USERPROFILE/PATH survive and the /login credential is found
};
let sessionId: string | undefined; let text: string | null = null;
try {
  for await (const m of query({ prompt: req.packText + '\n\n' + req.taskText, options })) {
    if (m.type === 'system' && m.subtype === 'init') { sessionId = m.session_id; toolsSeen = m.tools; mcpStatus = m.mcp_servers; }
    if (m.type === 'assistant') record tool_use blocks as ToolCallRecords;
    if (m.type === 'result') {
      if (m.subtype === 'success') { text = m.structured_output != null ? JSON.stringify(m.structured_output) : m.result; usage = sum(m.modelUsage); usd = m.total_cost_usd; priced = false; stop = m.is_error ? 'error' : 'end_turn'; }
      else { stop = m.subtype === 'error_max_turns' ? 'max_iterations' : m.subtype === 'error_max_budget_usd' ? 'budget' : 'error'; error = m.errors.join('; '); usd = m.total_cost_usd; }
    }
  }
} catch (e) { /* single-prompt mode throws after an error result — keep the result already seen */ }
```

`continue()` = `query({ prompt: userText, options: { ...options, resume: sessionId } })` (`resume?: string`, sdk.d.ts l.2092); the MCP server and outputFormat are passed again in `options`, so no re-attach magic is assumed. Fallback if `resume` misbehaves live: stateless repair (fresh query with pack + previous draft JSON + issues). After the first live run, `Query.accountInfo()` (sdk.d.ts l.3139: `apiKeySource`, `subscriptionType`, `apiProvider`) is logged into `plan.json.backend_account` to prove which credential was used. `toolsSeen` is stored as `plan.json.tools_seen` and a warning is emitted if anything outside `mcp__vedit__*` is present.

### 2.5 `mock` backend (`src/plan/backend/mock.ts`)

`new MockBackend({ turns: MockTurn[] } | { heuristic: true })`. Scripted: each `MockTurn = { tools?: {name,input}[]; text: string | object; stopReason?; usage?; usd? }` — listed tools are executed through the **real** `PlannerTool.run` (zod parse first, same wrapper as real backends, so budgets/trace are exercised), then `text` becomes the Turn. `received: string[]` records every `continue()` text for assertions. Heuristic (`--backend mock`): `heuristicDraft(ctx, instruction)` parses count ('3 рилса', '2 reels'), duration ('по 30 секунд', '1 мин'), aspect words, caption language ('на узбекском' → `uz`), packs highlights by score into whole-phrase clips (`pN`→`pM` refs) per output without reuse, `reasoning` starts with `[mock]`; it goes through the same `resolveDraft`, so the offline end-to-end path covers the acceptance code.

---

## 3. Tools (zod sketches)

All four are declared on every request (fixed, name-sorted). Descriptions are prescriptive (trigger conditions). Per-tool budgets return a **normal text** result ("budget used — decide from the pack") rather than `is_error`, so the model adapts instead of retrying; invalid arguments are `is_error` (ToolError / isError). Every call is traced (`ToolCallRecord = { name, input, ok, ms, summary, image?: boolean }`) into `plan.json`.

| name | input (zod raw shape) | output | why / when |
|---|---|---|---|
| `get_transcript_range` | `{ start: z.number().describe('seconds'), end: z.number().describe('seconds, > start'), words: z.boolean().optional().describe('include word timestamps and indexes (needed for pN.wK refs)') }` — run(): clamp to `[0, duration]`; `end-start > 180` → isError | JSON `{ phrases: [{ id:'p4', start, end, lang, text, words?: [{ i, w, start, end }] }], gaps: [{ id:'g2', start, end }] }` for phrases overlapping the range | Pack has full phrase text in FULL mode but never words; call it for word indexes before a `pN.wK` cut, or in COMPACT mode (truncated text). Ask for all ranges in one turn (parallel calls). |
| `get_scene_details` | `{ id: z.string().describe('scene id, e.g. s3') }` — unknown id → isError listing the valid range | JSON `{ id, start, end, description, objects, people_count, emotion, shot_type, quality_score, is_stub, phrases:[{id,start,end,text}], edges: { start: { inside_word: {w,start,end}|null, safe: number }, end: {…} }, prev, next }` | `edges` tells the model what the harness will snap a scene-boundary cut to; `is_stub` = description starts with `[stub]`. Mostly COMPACT mode. |
| `preview_frame` | `{ t: z.number().describe('seconds in [0, duration]') }` | content blocks: image (JPEG, 640 px wide, ≈300 input tokens for 640×360) + text `frame at 12.400s — s1, p4 "…"; previews_left 5`. Over budget (6) → text only `{ "note": "frame budget used; decide from scenes" }`. | The only visual truth while vision is `[stub]`; restricted by the prompt to instructions that depend on what is visible (hook frame, 9:16 speaker-in-frame). Implementation: `extractFrame(media.normalized_path, t, <jobDir>/frames/preview_<ms padded 6>.jpg, 640)` from `src/understand/shots.ts` via injected `deps.extractFrame`; cached by ms (repeat asks free), 2-slot semaphore. |
| `validate_edl` | `{ plan: PlanDraftSchema }` (the exact draft schema; parse failures → isError with zod issues) | JSON `{ ok, errors: PlanIssue[], warnings: PlanIssue[], resolved: [{ id, duration_s, target_s, clips:[{start_s,end_s,from,to}] }] }` from the same `resolveDraft()` the harness runs | SPEC §5.3; useful before answering for unusual plans (>3 outputs, >15 clips, pN.wK cuts, after frames changed the plan). Not needed on the happy path: the harness validates the final answer for free. |
| `submit_edl` (only in `'submit'` contract, §6.4) | `{ plan: PlanDraftSchema }` | `{ accepted: true, … }` or `{ accepted: false, attempt, attempts_left, errors, warnings }`; exhausted → `{ accepted:false, final:true }` | Terminal tool when the API rejects `output_config.format` together with client tools. Records `state.submitted` on acceptance. |

Tool-side budgets (`ToolDeps`): `maxToolCalls` 16 per conversation (`validate_edl`/`submit_edl` exempt so the model can always finish), `frameBudget` 6, `onCall` trace hook, `extractFrame` injectable (tests pass a stub returning a tiny JPEG buffer).

Draft schema (`src/schemas/plan.ts`) — plain `z.number()/z.string()`, no `.min/.max/.regex/.default` (constraints live in `resolve.ts`), `.optional()` for optional fields, `.describe()` everywhere:

```ts
export const RefSchema = z.string().describe('phrase/scene/gap ref: "p12" | "s3" | "g7" | "p12.start" | "p12.end" | "p12.w4" (word 4 of phrase 12, 0-based) — never seconds');
export const DraftClipSchema = z.object({ start: RefSchema, end: RefSchema, speed: z.number().optional(), crop: z.enum(['center','auto_face']).optional(), note: z.string().optional() });
export const DraftTitleSchema = z.object({ at: z.number(), duration: z.number().optional(), text: z.string(), style: z.string().optional() });
export const DraftOutputSchema = z.object({ id: z.string(), aspect: z.enum(['9:16','1:1','16:9']), target_duration: z.number().optional(), hook: z.string().optional(),
  clips: z.array(DraftClipSchema), captions: z.object({ enabled: z.boolean(), language: z.string().optional(), style: z.string().optional() }), titles: z.array(DraftTitleSchema), music: z.object({ enabled: z.boolean() }) });
export const DraftBriefSchema = z.object({ outputs_requested: z.number().optional(), target_duration_s: z.number().optional(), aspect: z.enum(['9:16','1:1','16:9']).optional(), captions_language: z.string().optional(), style_words: z.array(z.string()) });
export const PlanDraftSchema = z.object({ brief: DraftBriefSchema, outputs: z.array(DraftOutputSchema), reasoning: z.string() });
```

`sanitizeJsonSchema(schema)` (`src/plan/schema-sanitize.ts`, used for **both** tool `input_schema` and `output_config.format.schema`): recursive; deletes `$schema`, `default`, `pattern`, `minimum`, `maximum`, `exclusiveMinimum/Maximum`, `minLength`, `maxLength`, `minItems > 1`, `format` not in the supported set; **keeps** `enum`, `const`, `anyOf`, `allOf`, `$ref/$defs`, `description`, `required`; forces `additionalProperties: false` on every object. Why not the SDK helper: `betaZodOutputFormat`'s `transformJSONSchema` (0.133.0) moves `enum`/`const` into `description` text, so the API would not enforce `aspect`/`crop`; the docs list `enum`/`const` as supported, so we send them raw and parse the reply with `PlanDraftSchema.safeParse` ourselves (the toolRunner's non-streaming iterations come from `create()` and never auto-parse anyway).

---

## 4. Context packaging and caching

### 4.1 Request layout (`api` backend; render order tools → system → messages; 3 of 4 breakpoints)

1. **tools** — 4 (or 5) definitions, name-sorted, same instances for every request of the job. No marker.
2. **system block (cached)** — exactly one text block = `SYSTEM_PROMPT` (frozen constant, English, no dates/ids/job data/conditionals; `PROMPT_VERSION` recorded in plan.json) + `cache_control`. Its breakpoint caches **tools + system** (~2.5k tokens > 512 minimum) and is shared across **all jobs** on the machine for the TTL. Nothing job-specific goes here.
3. **messages[0].content[0] (cached)** — `packText`, job-static, byte-identical for plan, repairs and revise of the same job, own `cache_control`.
4. **messages[0].content[1]** — task text (instruction / revise edit), no marker.
5. **top-level `cache_control: {type:'ephemeral'}`** — automatic breakpoint over the growing tool_use/tool_result/repair tail.

`--cache-ttl 1h` sets `{type:'ephemeral', ttl:'1h'}` on blocks 2 and 3 (longer-TTL entries precede the 5 m automatic one, as the docs require — verify live). `agent` backend: `systemPrompt = SYSTEM_PROMPT (+addendum)`, `prompt = pack + '\n\n' + task`; the CLI manages caching.

### 4.2 Pack (`src/plan/context.ts`, `renderPack`)

JSON text of an object built in fixed key order, numbers `round2`, no paths/timestamps/pids; `renderPack(ctx) === renderPack(ctx)` is a unit test:

```
media:      { duration_s, fps, w, h, has_audio, language, languages, mode: 'full'|'compact' }
preset:     { name, pace, clip_seconds:{min,max}, caption_style, title_style, default_aspect, notes[] }
phrases:    [ { id:'p0', start, end, lang, text } ]            // sorted by start; text full in FULL mode, 60 chars in COMPACT
gaps:       [ { id:'g0', start, end } ]                        // silences ≥ 0.5 s between consecutive phrases (+ leading/trailing); from transcript, cross-checked with whisper/silences.json when present
scenes:     [ { id:'s0', start, end, shot_type, people, emotion, q, is_stub, description, phrases:['p1','p2'] } ]   // description ≤ 160 chars
highlights: [ { id:'h0', rank, score, start, end, phrases:[…], reason } ]   // as sorted in highlights.json, cap 40
```

Size: 10-min video ≈ 200 phrases × ~45 tokens + 60 scenes × ~40 + 40 highlights × ~30 ≈ **13–15k tokens** (`estimateTokens = ceil(chars / 2.8)`, conservative for Cyrillic); FULL mode up to 40k tokens covers every video in the SPEC range; above that COMPACT mode truncates phrase text/descriptions and the prompt tells the model to fetch via tools. `vedit plan --dry-run` prints the pack, its sha256 (`pack_hash` in plan.json) and, when an API key exists, `client.beta.messages.countTokens({ model, system, tools, messages })` to calibrate the estimate. Frame paths are **not** in the pack (preview_frame is the only frame access), so a real vision provider changes nothing here; `frameForScene()` is not needed.

### 4.3 SYSTEM_PROMPT sections (`src/plan/prompt.ts`, ~900 tokens)

1. Role: planning stage of an automated short-form editor; outputs a cut plan as JSON; never renders.
2. Pack format legend (keys above; `[stub]` descriptions carry no visual information; highlight reasons are heuristics).
3. Honesty: never claim what is shown unless seen via `preview_frame`; never quote text not in a phrase; do not invent people/emotions.
4. Ref grammar and hard rules: refs only, never seconds (in `start` the default edge is `.start`, in `end` it is `.end`; `gN` = cut inside that silence; `pN.wK` = word boundary inside a phrase, allowed only when phrase edges cannot reach the target length, and flagged); output ids `^[a-zA-Z0-9_-]+$` unique (`reel_1`, `wide_1`); produce exactly the number of outputs requested and fill `brief`; duration within ±10 % of target (hard ±25 %); `speed` 1.0 on speech, 1.25–2.0 only on speech-free clips with dynamic pace; `crop` `auto_face` for 9:16 talking-head clips; captions language = the language the user asked for (`uz` even if speech is `ru`), style = preset caption style; ≤2 titles per output, `at` in output-timeline seconds, ≤40 chars, only facts from phrases; no phrase reused across outputs unless asked.
5. Editing heuristics by pace (dynamic: hook in first 3 s, clips 2–6 s, alternate scenes, end on a complete phrase; calm: 5–15 s, original order; 9:16 prefers scenes with people when known; mixed-language: prefer the requested caption language).
6. Tool policy: tools are optional; final answer is validated automatically and issues come back, so do not call `validate_edl` for a normal plan; `get_*` only in COMPACT mode or for word indexes; `preview_frame` only when the instruction depends on visuals, all needed frames in one turn, budget 6; `validate_edl` before answering only for unusual plans.
7. Output contract: plan JSON only; `reasoning` 2–6 sentences in the instruction's language (editorial note for the user, never a reproduction of internal reasoning — avoids reasoning_extraction declines).
8. Repair protocol: on VALIDATION ISSUES return the complete corrected plan, fix every error, keep everything else identical.
9. Revise protocol: on CURRENT PLAN + EDIT REQUEST change only what is asked, untouched outputs byte-identical, keep `t…` refs of clips you do not touch, never create new `t…` refs.

`SUBMIT_ADDENDUM` (only in `'submit'` contract): "Finish by calling `submit_edl` with the complete plan and getting `accepted: true`; after acceptance reply with one sentence." `AGENT_ADDENDUM` (agent backend): "Tool names are prefixed `mcp__vedit__`."

Task texts: `buildTaskText({ instruction, presetName, mode, toolsAvailable })` → `INSTRUCTION:\n…\nPRESET: bold_pop\nMODE: FULL\nTOOLS: available\nProduce the plan now.`; `buildRepairText(issues, k, max)` → `VALIDATION ISSUES (attempt k of 2):\n<formatIssuesForModel>\nReturn the complete corrected plan.`; `buildReviseText(currentDraft, edit)`; `NUDGE_TEXT` (submit contract only) → `You ended without an accepted plan. Call submit_edl now with the complete plan.`

---

## 5. Ref grammar and validation (`src/plan/refs.ts`, `src/plan/resolve.ts`)

`parseRef`: `^([psg])(\d+)(?:\.(start|end|mid))?$` | `^p(\d+)\.w(\d+)$` | `^t(\d+(?:\.\d+)?)$`. `resolveRef(ref, side, ctx)`: `pN` → phrase start/end by side; `sN` → scene edge; `gN` → `side==='start' ? gap.end : gap.start` (`.mid` allowed); `pN.wK` → word start/end; `tS` → seconds (revise only, see below). `nearestBoundaryRef(t, side, ctx, tol=0.03)` and `draftFromEdl(edl, ctx)` (clip edges matching a phrase/scene/gap/word boundary become ids; others become `t12.400`; `brief` filled from the EDL) serve revise.

`resolveDraft(draft, ctx, { mode, currentEdl?, maxSnap=0.4, durationTolerance })` → `{ edl: z.input<EdlSchema> | null, outputs: ResolvedOutput[], issues, errors, warnings }`. Per output, in order (each a `PlanIssue { severity, code, output?, clip?, message, suggestion? }`):

1. `bad_id` (regex) / `duplicate_id` / `no_outputs` / `no_clips` — error.
2. per clip: `unknown_ref` (error; message names the last valid id of that kind); `raw_time` (a `t…` ref in plan mode, or a new `t…` ref in revise mode not present in `currentEdl`) — error; `empty_clip` (end ≤ start, shows resolved seconds) — error; `out_of_media` (clamp ≤0.5 s overflow with warning, else error); `bad_speed` (outside 0.25–4) — error; `speech_speed` (speed ≠ 1 over a phrase) — warning; `gap_cut` (gN edge) — warning; `mid_phrase` (pN.wK edge) — warning.
3. word safety: `snapClipsToWords(resolvedClips, transcript, 0.4)` (existing `validate.ts`) — snapped edges → warning `cuts_word` with the note; unsnappable (>0.4 s) → error `cuts_word` with suggestion `use pN.start / sM.end / gK`.
4. `overlap` within an output and identical ranges across outputs — warning.
5. duration: `target = output.target_duration ?? brief.target_duration_s`; `|expected − target| > max(0.25·target, 5 s)` → error `duration_off` (message lists the 3 phrases adjacent to the last clip with their durations as add/remove candidates); `> max(0.10·target, 2 s)` → warning.
6. `count_mismatch`: `brief.outputs_requested` set and ≠ `outputs.length` → error.
7. `captions_no_language` (fill from `brief.captions_language` ?? majority phrase lang) — warning; `title_outside` (clamp) — warning; title text > 60 chars — warning.
8. Build `z.input<OutputSchema>` for outputs with zero errors; `EdlSchema.safeParse({ outputs, reasoning })` as the final guard (`schema` errors attributed to the offending output).

`formatIssuesForModel(issues)` is a compact JSON list used by both the repair message and `validate_edl`. `nothing_to_plan`: `phrases.length === 0 && scenes.length === 0` → `PlanError` before any API call (this is what `--skip-understand --prompt` produces: understand writes scenes.json too, so skipping it leaves no boundaries at all).

---

## 6. Plan loop, limits, repair (`src/plan/loop.ts`, `src/plan/budget.ts`)

### 6.1 Limits (`DEFAULT_BUDGET`)

| limit | default | enforced by |
|---|---|---|
| `maxUsd` | 1.50 | BudgetTracker after every API request (api); `maxBudgetUsd` (agent) |
| `maxWallMs` | 240 000 (SPEC §8: 10-min video ≤ 5 min end-to-end) | `AbortSignal.any([parent, AbortSignal.timeout(remaining)])` passed to `toolRunner(params, { signal })` and tool `ctx.signal` |
| `maxCalls` | 12 API requests per conversation (tool round-trips + repairs) | `remainingCalls()` → per-runner `max_iterations = max(1, min(8, remaining))`; agent `maxTurns: 12` |
| `maxRepairs` | 2 | loop |
| `maxToolCalls` | 16 (validate/submit exempt) | tool wrapper (returns budget text) |
| `frameBudget` | 6 | preview_frame |
| `maxTokens` | 16000 → 32000 once on `max_tokens` | backend |

### 6.2 `runPlannerLoop(backend, ctx, task, opts)`

```
0. nothing_to_plan guard.  taskText = plan ? buildTaskText(...) : buildReviseText(draftFromEdl(currentEdl, ctx), edit)
1. turn = backend.start(req);  calls += turn.calls;  opts.onTurn(turn)   // plan() logs cost.json entries here, so a later crash loses nothing
2. classify: 'refusal' → fail('refusal', category) (no repair: refused output is not schema-valid)
             'max_tokens' (after the backend's own one retry) → fail('max_tokens')
             'budget'/'aborted' → go to 6 with whatever draft exists (partial if possible, else fail('budget'))
             'error' → fail('api')
             'max_iterations' → treat like end_turn without text (goes to repair/nudge via continue, allowed because history ends with a tool_result)
3. draft = contract === 'submit' && state.submitted ? state.submitted : parseDraft(turn.text)
   parseDraft: strip ```json fences (agent backend may add them) → JSON.parse → PlanDraftSchema.safeParse; failure → issues [{error, 'invalid_json'|'schema'}]
4. resolved = resolveDraft(draft, ctx, { mode, currentEdl })
5. errors === 0 → status 'ok'
6. else if repairs < maxRepairs && !budget.exceeded(): repairs++; fixed.push(...errors)
        text = contract === 'submit' && !state.submitted && !draft ? NUDGE_TEXT : buildRepairText(issues, repairs, maxRepairs)
        turn = backend.continue(turn, text, req); goto 2
   else: outputs with zero errors → 'partial' (dropped outputs' issues kept in report.issues); zero valid outputs → 'failed'
7. LoopResult { status, draft, resolved, turns, calls, repairs, fixed, issues, toolCalls, usage (summed), usd, priced, error? }
```

Call accounting: happy path 1 request (~40–90 s at `medium` with 3–5k output tokens incl. thinking); frames in one turn or one repair → 2; worst case 12.

### 6.3 `plan(jobId, opts)` (`src/plan/index.ts`)

Load `media.json` (required), `transcript.json`/`scenes.json`/`highlights.json` (optional → empty + warning), `loadPreset(name)`; `ctx = buildPlanContext(...)`; `tools = opts.tools === false ? [] : makePlannerTools(ctx, deps)`; `backend = opts.backendInstance ?? selectBackend(...)`. After the loop (also in `catch`/`finally`): always write `plan.json` (`PlanReportSchema`); on ok/partial write `edl.json` via `writeJson(EdlSchema)` (atomic) and return `{ ...report, edl, partial: status === 'partial' }` so `runStep` records `ok`/`partial`; on failed write `edl.draft.json` (raw draft if any) and throw `PlanError` (runStep records `failed`; the CLI prints it with a hint; the job stays reusable via `vedit plan <id> -p …` or `vedit cut <id> --edl <file>`). An invalid EDL never reaches `cut`.

### 6.4 Contract fallback (`'submit'`)

Unverified: whether `output_config.format` and client tools are accepted in one request on claude-opus-5-5 (the docs list structured outputs as compatible with batches/streaming/token counting/thinking and say nothing about client tools). Mitigation: feature detection on the first request (class-based: `instanceof Anthropic.BadRequestError`, never message text). On rejection the job switches to the `'submit'` contract: no `output_config.format`; `submit_edl` is declared (5 tools, `SUBMIT_ADDENDUM` appended to the system text); `submit_edl.run` = `resolveDraft` → accepted (records `state.submitted`, returns resolved summary + "reply with one sentence") or rejected (returns errors; each rejection counts as one repair); exhausted → `final: true`. The loop is unchanged except step 3/6 (nudge up to 2 if the model ends without submitting; JSON found in final text is accepted as a draft too). `--contract submit` forces it for testing. `plan.json.contract` records which one ran. The agent backend's `outputFormat` + MCP tools is native to the CLI, so it always uses `'format'`.

---

## 7. Revise reuse (`src/plan/revise.ts`, `src/plan/diff.ts`) — stage 5 entry point, implemented now

`revise(jobId, { edit, ...PlanOptions })`: load `edl.json` (required), same ctx (same pack bytes ⇒ cache hit within TTL), `task = { kind:'revise', edit, currentEdl }`, same loop (resolve in revise mode accepts carried-over `t…` refs). On ok/partial: copy `edl.json` → `edl.v<N>.json`, write new `edl.json`, `diff = diffEdl(prev, next)` (outputs compared after `EdlSchema.parse` by stable-key JSON; `changed[].fields` lists differing top-level fields), `stages` from `FIELD_STAGES = { clips:['cut','design','render'], aspect:[…all], target_duration:[…all], transitions:[…all], captions:['design','render'], titles:['design','render'], music:['design','render'] }`, `affected = needsCut(diff)` = added + changed-with-cut-stage; write `revise.json` (`ReviseReportSchema` = plan report + `edit`, `diff`, `affected`, `previous_edl`); cost entries with step `'revise'`. The CLI then runs `cut(jobId, edl, media, { only: affected, transcript, snap })`. Required companion change: `cut()` currently rewrites `cut.json` whole, so a `--only` run loses the records of untouched outputs — `cut()` will merge its report into the existing `cut.json` by output id (tests updated). Removed outputs' `rough_<id>.mp4` are listed, not deleted.

---

## 8. Cost logging and caching (`src/plan/pricing.ts`)

```ts
export const PRICES = { 'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, batchIn: 2, batchOut: 10 } } as const; // USD per MTok, bundled docs 2.1.295 — confirm on the live pricing page
export function usdForUsage(model: string, u: Anthropic.Beta.BetaUsage): { usd: number; priced: boolean } {
  if (u.iterations?.length) return sum over entries: priceEntry(entry.model, entry)        // a server-side fallback rescue is billed at the fallback model's rate
  const p = PRICES[model]; if (!p) return { usd: 0, priced: false };                          // unknown model => unpriced, never a guessed number
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens ?? 0), w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const [pin, pout] = u.service_tier === 'batch' ? [p.batchIn, p.batchOut] : [p.in, p.out];
  return { usd: (u.input_tokens * pin + w5 * p.cacheWrite5m + w1 * p.cacheWrite1h + (u.cache_read_input_tokens ?? 0) * p.cacheRead + u.output_tokens * pout) / 1e6, priced: true };
}
```

`input_tokens` is the uncached remainder (never add cache fields again); `output_tokens` already includes thinking (`output_tokens_details.thinking_tokens` is recorded for the report only). Only `claude-opus-5-5` is priced; `claude-opus-5` / `claude-opus-4-8` are **not** in the research notes, so an iteration on them is logged as unpriced (`units.unpriced = 1`, warning in plan.json). Server-side fallbacks are therefore **off by default** (`VEDIT_FALLBACKS=1` opts in) so cost never silently moves to an unpriced model without thinking.

Logging: `api` → one `cost.json` entry **per API request** via `addCost(jobId, { step: 'plan'|'revise', provider: 'anthropic', model, units: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, thinking_tokens, calls: 1, tool_calls, images, unpriced: 0|1 }, usd })`, written from `onTurn` so a crash mid-loop loses nothing; `agent` → one entry per `query()` with `usd = total_cost_usd`, units from `modelUsage` (sum of `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`), `units.estimate = 1` (client-side estimate; on a subscription not a bill — `vedit status` prints `≈`); `mock` → usd 0. `plan.json` repeats totals plus `per_call[]` (`model, input, cache_read, cache_write, output, stop_reason, tools, usd`) and `pack_hash`.

Expected (10-min video, FULL, pack ≈ 15k tokens incl. system+tools, effort medium): first request writes the cache 15k × $5/M ≈ $0.075 + 3–5k output incl. thinking × $20/M ≈ $0.06–0.10 ⇒ **≈ $0.15–0.20**; a repair/frame round-trip re-reads 15k × $0.2/M ≈ $0.003 + new tail ≈ $0.08; typical job **$0.15–0.30**, revise within TTL **$0.08–0.12**. 35 s example job ≈ $0.05–0.10.

Caching invariants (unit-tested): tools name-sorted, same instances per job; `SYSTEM_PROMPT` constant with no interpolation; pack from fixed key order + `round2`; effort/model fixed per conversation; append-only history; `tool_choice` never set. Health: for call ≥ 2 `cache_read_input_tokens` must be ≥ pack size; `vedit status`/`printPlan` warn `⚠ кэш промпта не сработал` when every request after the first reports 0 cache reads (silent invalidator). `tests/live-plan.ts` asserts it.

---

## 9. CLI (`src/cli.ts`)

Shared planner options (run / plan / revise), Russian help text: `--backend <auto|api|agent|mock>` (default `auto`, env `VEDIT_PLANNER`), `--model <id>` (default `claude-opus-5-5`, env `VEDIT_PLANNER_MODEL`), `--effort <low|medium|high|xhigh|max>` (default `medium`), `--budget <usd>` (1.50), `--max-repairs <n>` (2), `--no-tools` (one structured call, no tools), `--frames <n>` (6), `--cache-ttl <5m|1h>` (5m), `--contract <format|submit>` (format), `--verbose` (one line per tool call: `  ⚙ preview_frame 12.4s 180ms`).

- `vedit run <video> -p <text> [--preset bold_pop] …`: after ingest/understand → `--edl` ⇒ existing `stageEdl` path (agent bypassed); else `--prompt` ⇒ `console.log('▸ plan')`, `r = await runStep(job.id, 'plan', () => plan(job.id, { instruction, preset, ...plannerOpts(opts), onEvent }))`, `printPlan(r)`, then the existing `▸ cut` with `r.edl`; neither ⇒ `нет инструкции: передайте --prompt "…" или готовый план --edl <file>` (exit 0, job reusable). `--skip-understand` + `--prompt` ⇒ `nothing_to_plan` error with hint `уберите --skip-understand`.
- `vedit plan <job_id> -p <text> [--preset] [--cut] [--dry-run] …`: standalone (re)planning; stores prompt/preset into `job.json` (`saveJobMeta()`); `--dry-run` prints pack, `pack_hash`, resolved backend note and the `countTokens` figure (api backend only) without calling the model; `--cut` continues into cut; else prints `нарезать: vedit cut <id>`.
- `vedit revise <job_id> -p <text> [--no-cut] [--no-snap] …`: replaces the stage-5 stub: `runStep('revise', …)`, prints `  изменено: reel_1 (clips, titles); без изменений: wide_1; добавлено: reel_3; удалено: —`, cost line, then `runStep('cut', () => cut(jobId, edl, media, { only: affected, transcript, snap }))` unless `--no-cut` or `affected` is empty. Requires `edl.json` (`сначала vedit plan <id> -p …`).
- `vedit status <job_id>`: + `план: ok, 2 вызова, 1 исправление, $0.19 (api, claude-opus-5-5, medium)` (`≈$` when estimated), first 3 warnings, cache-health warning, last revise diff summary.
- `printPlan(r)`: backend line (+ note), per output `  ✔ reel_1 9:16 29.4s/30s 5 клипов, субтитры uz` (`✖` + first error for dropped outputs in partial), `    ⚠` warnings, tool summary, cost line, `reasoning` (first 300 chars). Failures via `fail()`: `✖ plan: <message>` + hint keyed by `PlanError.code` (`no_backend` → three options; `refusal` → category; `budget` → raise `--budget`; `invalid` → `черновик: workspace/<id>/edl.draft.json — исправьте и vedit cut <id> --edl …`).
- Housekeeping: `program.version('0.3.0')` and `package.json` → 0.3.0 (they disagree today); README stage table (3 ✔, 5 planner-side ✔); `.env.example` gets `VEDIT_PLANNER`, `VEDIT_PLANNER_MODEL`, `VEDIT_FALLBACKS` and the note that without `ANTHROPIC_API_KEY` the agent backend uses the Claude Code login.

---

## 10. Tests

`npm test` stays `node --import tsx --test tests/*.test.ts`; `tests/stage3.test.ts` uses top-level `test()` + `node:assert/strict`, no network/ffmpeg/whisper. Fixture `tests/helpers/plan-fixture.ts`: 35 s media, 8 phrases (ru×6, en×2, 50 words; a scene boundary at 8.50 s inside the word «Каждое» 8.29–8.74 as in job 20261010-7d76cd), 3 `[stub]` scenes, 8 highlights, bold_pop preset; `makeFixtureContext()`, `GOOD_DRAFT`, `BAD_DRAFT_UNKNOWN_REF`, `TINY_JPEG`.

1. **context**: `renderPack` byte-identical across builds and input key order; ids `p0..p7` by start, `s0..s2`, gaps ≥0.5 s get `gN`; scenes/highlights carry phrase ids; FULL for the fixture; synthetic 25-min transcript ⇒ COMPACT with truncation; pack contains no path/timestamp.
2. **refs**: `parseRef` table (`p3`, `p3.end`, `s1.start`, `g2`, `p3.w4`, `t12.4`, `P3`, `x1` → null); `resolveRef` default edges and gap sides; `draftFromEdl(GOOD_EDL)` round-trips to the same seconds (±1 ms) and emits `t…` for a hand-set 10.000 s edge.
3. **resolveDraft**: GOOD_DRAFT ⇒ 0 errors and `EdlSchema.parse` fills defaults; `unknown_ref`, `empty_clip`, `count_mismatch`, `duration_off` (with candidate phrases), scene edge inside a word ⇒ `cuts_word` warning and `src_start === 8.29`; 1.2 s shift ⇒ error; `pN.wK` ⇒ `mid_phrase` warning with exact word time; `gN` ⇒ `gap_cut` warning; `bad_id`, `duplicate_id`, `title_outside` clamp; revise mode accepts a carried-over `t…` and rejects a new one.
4. **tools** (`extractFrame` stub): sorted names; `get_transcript_range` words/indexes and 200 s range error; `get_scene_details` `edges.start.inside_word` for s1 and `is_stub`; `preview_frame` image+text, cached ms (second call no budget), 7th call non-error budget text, out-of-range isError; `validate_edl` equals `resolveDraft`; `onCall` trace; `maxToolCalls` text result with validate exempt.
5. **schema sanitizer**: for every tool and for the draft format, output has no `$schema/default/pattern/minimum/maximum/minLength/maxLength`, keeps `enum`, `additionalProperties:false` on every object (snapshot).
6. **loop on MockBackend**: happy (1 call, `received` empty); repair (unknown_ref → GOOD, `received[0]` contains `unknown_ref` and `p99`); exhausted ⇒ failed with draft; partial (one unfixable output dropped); tool execution turn (2 tool calls traced, frame budget decremented); refusal ⇒ failed, no repair; invalid JSON ⇒ counted as repair; `maxCalls` ⇒ `loop`; usage/usd summed; budget usd exceeded ⇒ `budget` stop with partial; submit contract: `submit_edl` accepted ⇒ ok, never-submits ⇒ 2 nudges then failed.
7. **plan() end-to-end**: `process.env.VEDIT_WORKSPACE = mkdtemp(...)` **before** `await import('../src/plan/index.ts')` (WORKSPACE_ROOT is computed at module load; no static import of `workspace.ts` in the test file); seed `job.json/cost.json/media.json/transcript.json/scenes.json/highlights.json` with `writeJson`; MockBackend ⇒ `edl.json` + `plan.json` valid, cost.json one entry per turn (provider `mock`, usd 0); failing run ⇒ `edl.draft.json`, `plan.json` status failed, cost logged, `PlanError`; `tools: false` ⇒ backend receives `[]`; `nothing_to_plan` with empty transcript+scenes before any backend call.
8. **revise()**: changed `reel_1` clips, byte-identical `wide_1` ⇒ `diff.changed [{id:'reel_1', fields:['clips']}]`, `affected ['reel_1']`, `edl.v1.json`, `revise.json`; captions-only change ⇒ `stages.reel_2 = ['design','render']` and not in `affected`; `cut.json` merge by id keeps untouched records.
9. **pricing**: hand-computed usd (input 1000, output 500, cache_read 15000) within 1e-9; 1h split; `iterations[]` with an unknown fallback model ⇒ that entry unpriced; `service_tier 'batch'`; unknown model ⇒ `{usd:0, priced:false}`.
10. **selection**: `{ANTHROPIC_API_KEY}` ⇒ api; no key + credentials probe true ⇒ agent with note; neither ⇒ `no_backend`; `mock` never from `auto`.
11. **prompt stability**: `SYSTEM_PROMPT` has no `${`, no job data; `buildTaskText` differs only in the instruction.
12. **heuristic mock**: `'2 рилса по 10 секунд, субтитры на узбекском'` ⇒ 2 outputs 9:16, `captions.language 'uz'`, refs only, durations within tolerance, reasoning starts with `[mock]`.

Live (manual, not in `npm test`): `npx tsx tests/live-plan.ts <job_id> "<prompt>" [--backend api|agent]` runs the real backend twice and asserts: first request with tools + `output_config.format` accepted (or the submit fallback engaged and is reported), second call `cache_read_input_tokens > 0`, `plan.json` usage equals summed per-call usage, agent `accountInfo()` shows the expected credential, init `tools` only `mcp__vedit__*`, preview image accepted. `npm run typecheck` is green today (uncommitted `tests/make-fixtures.ts` fix) — commit it with stage 3.

---

## 11. Risks

1. **Format + tools combination unverified** on claude-opus-5-5 (highest); mitigated by class-based feature detection → `submit_edl` contract, `--no-tools`, `--contract submit`; verified on the first live run.
2. **`enum`/optional properties in `output_config.format`**: docs list `enum`/`const` as supported but the SDK helper strips them; optional (non-required) properties are not mentioned. If rejected: flip the sanitizer to move `enum` into `description` (as the SDK does) and/or switch `.optional()` → `.nullable()`; zod parse + repair catches the rest either way.
3. **Subscription login through the Agent SDK** is undocumented for third-party products; this is a personal tool but the user must decide (open question). Agent-side unknowns: credential pickup by the spawned `claude.exe`, Cyrillic project path (sidestepped with `cwd: os.tmpdir()` + `CLAUDE_CODE_PROJECT_DIR_NAME`), MCP image forwarding (degrades to text), `resume` behaviour (stateless fallback), `structured_output` population, built-ins really hidden (`tools_seen` logged).
4. **Model misreads the brief** consistently (e.g. 2 outputs for «3 рилса»): `count_mismatch` only checks against the model's own brief. Accept for MVP; cheap regex second opinion is in the heuristic mock and can be promoted later.
5. **Ref grammar vs talky footage**: gap (`gN`) and word (`pN.wK`) refs keep 2–6 s cuts reachable; `mid_phrase` is a warning, so SPEC's phrase-boundary preference is visible in reports but not blocking (open question).
6. **Prompt-cache fragility**: any non-determinism in `renderPack`/prompt kills caching silently; unit byte-equality test + live cache_read assertion + status warning. Pack < 512 tokens (short videos) does not cache — expected and harmless.
7. **Latency**: one Opus 5.5 request with thinking at medium is ~40–90 s; 2–3 requests fit the 240 s wall clock for 10-min videos; the wall clock stops the loop with `partial`/`failed` rather than overrunning SPEC §8.
8. **Pricing drift**: table from bundled docs (skill bundle 2.1.295); confirm on the live pricing page; unknown models never priced from memory. Agent costs are estimates.
9. **Preserved-thinking binding**: all continuations are append-only; the max_tokens retry drops only a received-but-never-sent assistant message. If a 400 `Invalid signature in thinking block` ever appears, fall back to a fresh conversation for the retry (cost: pack re-read).
10. **Scene↔frame coupling** is avoided (no frame paths in the pack); `preview_frame` extracts on demand, so a Gemini provider with merged scenes needs no planner change.
11. **cut.json overwrite** on `--only` runs must be fixed in `cut()` for revise bookkeeping (in scope).

---

## 12. Factual corrections applied vs the submitted designs

- max_iterations: the installed runner checks the cap at the **top** of the loop; the last allowed iteration's tools run and the history ends with a `tool_result` (verified). Budget accounting counts that round; a continuation after the cap is possible (appended to the unsent trailing user message).
- After a consumer `break`, nothing is appended to `runner.params.messages` (only `finally` runs); the design reads history only after a natural end and never awaits `done()` after a break.
- `VEDIT_WORKSPACE` must be set before a **dynamic** import of `src/plan/index.ts` (WORKSPACE_ROOT is computed at module load).
- Only `claude-opus-5-5` is priced; `claude-opus-5` / `claude-opus-4-8` rates and `PRICES_AS_OF` were unsourced and are dropped; fallbacks are opt-in so unpriced rescues do not happen by default.
- Backend auto-selection probes the credential file / OAuth env, not `require.resolve` of the binary (ESM has no bare `require`; binary presence is not a credential).
- Feature detection and all error handling use `instanceof` classes, never message text.
- Image cost ≈ 300 tokens per 640×360 frame (w×h/750), and once in the prefix it is a cache read.
- Agent SDK `effort`, `thinking: {type:'adaptive'}`, `outputFormat`, `resume`, `structured_output`, `accountInfo()`, `setModel()` exist in sdk.d.ts 0.3.296 (line numbers in §2.4), so `--effort` is wired to the agent backend; `@modelcontextprotocol/sdk` 1.32.1 with `ImageContent` is installed (not a risk).
- An explicit client `timeout` disables the SDK's non-streaming `max_tokens > 21333` guard (`messages.js:39-43`), so the 32000 retry is non-streaming.
- `betaZodOutputFormat` (SDK `transformJSONSchema`) moves `enum`/`const` into description text; the design sends a raw `{type:'json_schema', schema}` through its own sanitizer and parses with zod itself.
- `--skip-understand --prompt` cannot plan on "scene boundaries only" (scenes come from understand too) → `nothing_to_plan` error with a hint.
- Server-side fallbacks default **off** (a rescue runs without Opus 5.5 thinking, at other rates, possibly unpriced).
- `npm run typecheck` is green as of today (the pre-existing make-fixtures.ts errors are fixed in the working tree); commit that with stage 3.

## 13. Open questions → see `open_questions_for_user`.

## File plan
-  — Zod contracts: RefSchema, DraftClip/Title/Output/Brief, PlanDraftSchema (plain types, no min/max/regex/default), IssueCodeSchema (+ gap_cut, mid_phrase), PlanIssueSchema, PlanUsageSchema, ToolCallRecordSchema, CallUsageSchema, PlanReportSchema (status, backend, backend_note, backend_account?, contract, model, effort, mode, pack_hash, prompt_version, instruction, preset, calls, repairs, tool_calls, tools_seen?, per_call, usage, usd, priced, fixed, issues, warnings, draft, error?, wall_seconds), EdlDiffSchema (+ stages), ReviseReportSchema. Re-exported from src/schemas/index.ts.
-  — PresetSchema { name, description, pace: dynamic|calm|neutral, clip_seconds {min,max}, caption_style, title_style default 'hero', default_aspect default '9:16', music_default, notes[] } and Preset type; exported from schemas/index.ts.
-  — loadPreset(name, dir='presets') reads presets/<name>.json via readJson(PresetSchema); BUILTIN_PRESETS (bold_pop, calm) as fallback with a note instead of failing.
-  — First real preset file (plus presets/calm.json): the built-in default serialized so presets/ stops being empty and pace/clip lengths are tunable without code.
-  — buildPlanContext (ids pN/sN/gN/hN, phrase↔scene/highlight cross-refs, boundaries map, FULL/COMPACT mode, packText, tokenEstimate, packHash), renderPack (deterministic, fixed key order, round2), estimateTokens, phrasesOverlapping, gaps from transcript (+ whisper/silences.json when present). Pure, no I/O.
-  — Ref grammar: parseRef (pN|sN|gN[.start|.end|.mid], pN.wK, tS), resolveRef(ref, side, ctx), nearestBoundaryRef, draftFromEdl(edl, ctx) for revise (t-refs for hand-set edges).
-  — resolveDraft(draft, ctx, {mode, currentEdl, maxSnap, durationTolerance}) → ResolvedDraft: the single validator behind the harness check, validate_edl, submit_edl and revise; reuses snapClipsToWords/checkClipBoundaries from validate.ts; formatIssuesForModel.
-  — sanitizeJsonSchema(schema): strips $schema/default/pattern/minimum/maximum/exclusive*/minLength/maxLength/minItems>1/unsupported format, keeps enum/const/anyOf/allOf/$ref/$defs/description/required, forces additionalProperties:false recursively; used for tool input_schema and output_config.format.schema; draftJsonSchema() helper.
-  — Backend-neutral PlannerTool definitions (get_scene_details, get_transcript_range, preview_frame, validate_edl; submit_edl only for the 'submit' contract) with zod raw shapes, prescriptive descriptions, run bodies, ToolDeps (extractFrame injectable, frameBudget 6, maxToolCalls 16 with validate/submit exempt, onCall trace), preview-frame ms cache + 2-slot semaphore, makePlannerTools(ctx, state, deps) sorted by name.
-  — Frozen SYSTEM_PROMPT constant (+ PROMPT_VERSION), SUBMIT_ADDENDUM, AGENT_ADDENDUM, NUDGE_TEXT, buildTaskText, buildRepairText, buildReviseText. No interpolation in the system text.
-  — Budget { maxUsd 1.5, maxWallMs 240000, maxCalls 12, maxRepairs 2, maxToolCalls 16, frameBudget 6 } and BudgetTracker (addRequest, remainingCalls, exceeded(): null|'usd'|'wall'|'calls', signal via AbortSignal.any + AbortSignal.timeout).
-  — PRICES (claude-opus-5-5 only, USD/MTok from bundled docs), usdForUsage(model, BetaUsage) pricing usage.iterations[] per entry model and batch tier, unknown model → {usd:0, priced:false}; normalizeUsage.
-  — runPlannerLoop(backend, ctx, task, opts): nothing_to_plan guard, start → classify stop → parseDraft (fence strip, zod) → resolveDraft → repair/nudge via continue (≤2) → ok/partial/failed; owns limits, onTurn hook for per-request cost logging; no I/O or ffmpeg.
-  — diffEdl(prev, next) → EdlDiff {added, removed, changed[{id, fields}], unchanged, stages}, FIELD_STAGES mapping, needsCut(diff).
-  — PlannerBackend, StartRequest, Turn, CallUsage, NormalizedUsage, ToolCallRecord, Contract, PlanError with typed codes.
-  — AnthropicApiBackend: client with explicit timeout/maxRetries, betaZodTool adapters with sanitized input_schema overrides, cache-friendly toolRunner params (stream:false as const, max_iterations ≥1, output_config.effort+format, top-level cache_control), per-message usage/usd, budget break, append-only continue(), max_tokens retry at 32000, class-based feature detection → 'submit' contract, typed error mapping, optional VEDIT_FALLBACKS.
-  — AgentSdkBackend: createSdkMcpServer + tool() adapters (text+image content), query() with systemPrompt, model, effort, thinking adaptive, outputFormat json_schema, tools [], allowedTools mcp__vedit__*, disallowedTools ToolSearch, dontAsk, settingSources [], maxTurns, maxBudgetUsd, cwd os.tmpdir(), spread env + CLAUDE_CODE_PROJECT_DIR_NAME; init message tools/mcp status capture; result/structured_output/modelUsage/total_cost_usd mapping; continue() via resume; accountInfo() logging.
-  — MockBackend: scripted turns executing real tool code, received[] for assertions, synthetic usage; heuristicDraft(ctx, instruction) for --backend mock with '[mock]' reasoning.
-  — selectBackend(choice, opts, env, probe): api on ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN; agent on CLAUDE_CODE_OAUTH_TOKEN or existence of <CLAUDE_CONFIG_DIR ?? ~/.claude>/.credentials.json (never read); mock only explicit; no_backend error with the three options; returns the note.
-  — plan(jobId, PlanOptions): load inputs, preset, context, tools, backend; run loop; write plan.json always, edl.json on ok/partial (writeJson EdlSchema), edl.draft.json on failure; per-request addCost from onTurn; returns PlanResult with partial flag or throws PlanError.
-  — revise(jobId, ReviseOptions): current edl.json → draftFromEdl → same loop in revise mode → edl.v<N>.json backup, new edl.json, diffEdl/needsCut, revise.json, cost entries with step 'revise'; returns affected ids for cut --only.
-  — Small change: merge the new report into the existing cut.json by output id on --only runs instead of rewriting it whole (needed by revise bookkeeping); tests updated.
-  — Wire plan into run (plan step between understand and cut; --edl bypass; no-prompt hint; --skip-understand+--prompt error), add plan (with --dry-run/--cut), implement revise (diff print + cut --only), extend status (plan/revise lines, ≈ for estimates, cache-health warning), shared planner options + plannerOpts(), printPlan(), fail() hints by PlanError.code, version 0.3.0.
-  — In-memory 35 s fixture mirroring job 20261010-7d76cd (8 phrases ru/en with words, scene boundary inside «Каждое», 3 stub scenes, 8 highlights, bold_pop), makeFixtureContext(), GOOD_DRAFT, BAD_DRAFT_UNKNOWN_REF, TINY_JPEG, synthetic long transcript generator.
-  — Offline unit tests (node:test): context determinism, refs, resolveDraft, tools, sanitizer snapshot, loop on MockBackend (incl. submit contract), plan() end-to-end with VEDIT_WORKSPACE set before a dynamic import, revise()/diff/cut.json merge, pricing, backend selection, prompt stability, heuristic mock.
-  — Manual live smoke script (not in npm test): runs the real backend twice on an existing job; asserts format+tools acceptance (or reports the submit fallback), cache_read_input_tokens > 0 on the second call, per-call usage sums, agent accountInfo()/init tools, preview image accepted; prints the per-call usage table.
-  — Add VEDIT_PLANNER, VEDIT_PLANNER_MODEL, VEDIT_FALLBACKS and the note that without ANTHROPIC_API_KEY the agent backend uses the Claude Code login.
-  — Status table (stage 3 ✔ planner, stage 5 revise planner-side ✔), backend selection and policy note, cost expectations, new CLI commands.
-  — Version 0.3.0 (match cli.ts); commit the already-added @anthropic-ai/sdk and @anthropic-ai/claude-agent-sdk dependencies and the make-fixtures.ts typecheck fix.

## Verify before coding
- LIVE (api backend, first run): a request with output_config.format (raw json_schema) AND client tools in one call on claude-opus-5-5 is accepted; if BadRequestError, confirm the class-based fallback to the 'submit' contract engages and the final text is not schema-constrained in that mode.
- LIVE: the API accepts `enum` (and `const`) inside output_config.format.schema (docs list them as supported; the SDK's own betaZodOutputFormat helper strips them into description text, which is why the design sends a raw schema). Also confirm non-required (zod .optional()) properties are accepted; fallback .nullable().
- LIVE: betaZodTool definitions with the overridden sanitized input_schema (no $schema, no numeric/string constraints, additionalProperties:false everywhere) are accepted; strict:true stays off until separately verified.
- LIVE (agent backend): the spawned bundled claude.exe picks up %USERPROFILE%\.claude\.credentials.json with ANTHROPIC_API_KEY unset (Query.accountInfo() → apiKeySource/subscriptionType/apiProvider 'firstParty'); works with cwd os.tmpdir() and env spread + CLAUDE_CODE_PROJECT_DIR_NAME despite the Cyrillic project path.
- LIVE (agent backend): the 'system' init message's tools array contains only mcp__vedit__* with tools: [] + allowedTools + disallowedTools ['ToolSearch'] + dontAsk + settingSources []; MCP ImageContent from preview_frame reaches the model as an image (else degrade to text); result.structured_output is populated with outputFormat json_schema; `resume: sessionId` with the same options re-attaches the MCP server and outputFormat for the repair turn (else stateless repair).
- RUNNER: after a natural loop end runner.params.messages contains the appended assistant and tool_result messages (read from BetaToolRunner.js; exercise once live); continuation after a max_iterations stop by appending the repair text to the unsent trailing tool_result user message is accepted by the API (alternative: separate user message, relying on consecutive-user-turn merging).
- PRESERVED THINKING: replaying the append-only history (same tools/system) for a repair turn and the max_tokens retry that drops only the received-but-never-sent truncated assistant message do not trigger 400 'Invalid signature in thinking block'; fallback is a fresh conversation.
- PRICING: confirm claude-opus-5-5 rates ($4 in / $20 out / $0.20 cache read / $5 5m write / $8 1h write per MTok, batch $2/$10) on the live pricing page before relying on cost ceilings; leave other models unpriced.
- CACHING: second live request of a job shows cache_read_input_tokens ≥ pack size (tests/live-plan.ts); with --cache-ttl 1h confirm the API accepts 1h markers on system+pack with the 5m automatic top-level breakpoint.
- TOKENS: compare the chars/2.8 pack estimate against client.beta.messages.countTokens on job 20261010-7d76cd and on a ~10-minute video before relying on the 40k COMPACT threshold.
- AGENT SDK thinking option: Options.thinking {type:'adaptive'} is accepted alongside effort for claude-opus-5-5 by the CLI (types verified in sdk.d.ts; behaviour not run).
- REPO: draftFromEdl round-trips the real workspace/20261010-7d76cd/edl.json; the cut.json merge-by-id change keeps stage1/stage2 tests green; commit the uncommitted tests/make-fixtures.ts typecheck fix (npm run typecheck is green today) and the SDK dependency additions together with stage 3.
- MODEL ID: 'claude-opus-5-5' resolves (no dated full ID published); NotFoundError on the first request means the org cannot use it or the alias changed.

## Open questions for the user
- Preferred backend: do you want to add an ANTHROPIC_API_KEY to .env so the supported Claude API path (backend 'api') is the default, or run on your Claude Code subscription login via the Agent SDK (backend 'agent') — which auto-selects today because no key and no .env exist? Anthropic's docs do not address personal non-distributed use of a subscription through the SDK; are you comfortable with that until confirmed (not legal advice)?
- Default limits per planning run: USD cap $1.50, wall clock 240 s, max 12 API requests, 2 repairs, 6 preview frames — acceptable, or do you want different defaults?
- Boundary strictness: SPEC §5.3 says clips start/end on a phrase or scene boundary. Should word-boundary cuts inside a long phrase (pN.wK refs) and cuts inside silence gaps (gN) be allowed with a warning (proposed, keeps 2–6 s dynamic cuts reachable) or rejected as errors?
- Preset contract: is the proposed presets/bold_pop.json (pace dynamic, clips 2–6 s, caption_style 'bold_pop', title_style 'hero', default aspect 9:16, music off, notes 'хук в первые 3 секунды') what bold_pop should mean, and should a second preset (calm) ship now?
- Revise behaviour: should `vedit revise` automatically re-cut affected outputs by default (proposed, with --no-cut to skip), and should rough_<id>.mp4 of removed outputs be left on disk (proposed) or deleted?
- Server-side refusal fallbacks are off by default (a rescue would run on another model without Opus 5.5 thinking and would be logged unpriced). Keep them opt-in via VEDIT_FALLBACKS=1?
- Language conventions: console output and plan hints stay in Russian like the rest of the CLI, the system prompt is English, and `reasoning` follows the instruction's language — confirm.
