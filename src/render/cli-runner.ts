import { spawn } from "node:child_process";

export interface LintJson {
  ok: boolean;
  errorCount: number;
  warningCount: number;
  findings?: { severity?: string; rule?: string; message?: string; file?: string; line?: number }[];
}

export function describeFinding(f: NonNullable<LintJson["findings"]>[number]) {
  return `${f.severity ?? "finding"} ${f.rule ?? ""}${f.message ? `: ${f.message}` : ""}${f.line ? ` (line ${f.line})` : ""}`.trim();
}

/** Runs the pinned local HyperFrames CLI; resolves with the exit code (never rejects on a non-zero exit). */
export function runCli(bin: string, args: string[], cwd: string, onLine?: (line: string) => void, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_SKIP_SKILLS: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      signal,
    });
    let stdout = "";
    let stderr = "";
    let buf = "";
    const feed = (chunk: string) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) onLine?.(l);
    };
    child.stdout.on("data", (d) => ((stdout += d), feed(String(d))));
    child.stderr.on("data", (d) => ((stderr += d), feed(String(d))));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Parses `@hf-progress {"code":"encode","done":262,"total":300,"pct":89}` lines. */
export function parseProgress(line: string): { code: string; done: number; total: number; pct: number } | null {
  const m = /@hf-progress\s+(\{.*\})/.exec(line);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]) as { code?: string; done?: number; total?: number; pct?: number };
    return { code: j.code ?? "", done: j.done ?? 0, total: j.total ?? 0, pct: j.pct ?? 0 };
  } catch {
    return null;
  }
}

/** Extracts the JSON document the CLI prints (it may be preceded by notices). */
export function parseLintJson(stdout: string): LintJson | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start)) as LintJson;
  } catch {
    return null;
  }
}
