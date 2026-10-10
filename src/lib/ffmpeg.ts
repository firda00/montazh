import { spawn } from "node:child_process";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export class ProcessError extends Error {
  constructor(
    message: string,
    public stderr: string,
  ) {
    super(message);
  }
}

function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => reject(new ProcessError(`${bin} failed to start: ${err.message}`, "")));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.trim().split("\n").slice(-8).join("\n");
        reject(new ProcessError(`${bin} exited with code ${code}:\n${tail}`, stderr));
      }
    });
  });
}

export function ffmpeg(args: string[]) {
  return run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

export interface ProbeStream {
  codec_type: "video" | "audio" | string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
}
export interface ProbeResult {
  streams: ProbeStream[];
  format: { duration?: string; format_name?: string };
}

export async function ffprobe(file: string): Promise<ProbeResult> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
  return JSON.parse(stdout) as ProbeResult;
}

export function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split("/").map(Number);
  return d ? n / d : n;
}
