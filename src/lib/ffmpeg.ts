import { spawn } from "node:child_process";
import { jobSignal } from "./abort.ts";

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

function run(bin: string, args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, cwd: opts.cwd, signal: jobSignal() });
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

export function ffmpeg(args: string[], opts: { loglevel?: "error" | "info" } = {}) {
  return run(FFMPEG, ["-hide_banner", "-loglevel", opts.loglevel ?? "error", "-y", ...args]);
}

export function runProcess(bin: string, args: string[], opts: { cwd?: string } = {}) {
  return run(bin, args, opts);
}

export interface ProbeStream {
  codec_type: "video" | "audio" | string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  pix_fmt?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_space?: string;
  disposition?: { attached_pic?: number };
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

/** ffmpeg writing raw bytes to stdout (`-f rawvideo|f32le … -`): returns the bytes. Keep outputs small (ROI frames, short audio windows). */
export function ffmpegBuffer(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { windowsHide: true, signal: jobSignal() });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => reject(new ProcessError(`${FFMPEG} failed to start: ${err.message}`, "")));
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new ProcessError(`${FFMPEG} exited with code ${code}:\n${stderr.trim().split("\n").slice(-6).join("\n")}`, stderr));
    });
  });
}

let filterList: Promise<string> | undefined;
/** this ffmpeg build has the filter (zscale needs libzimg: the gyan.dev and Ubuntu builds have it) */
export async function hasFilter(name: string): Promise<boolean> {
  filterList ??= run(FFMPEG, ["-hide_banner", "-filters"]).then(
    (r) => r.stdout,
    () => "",
  );
  return (await filterList).split("\n").some((l) => l.trim().split(/\s+/)[1] === name);
}

/** HDR transfer (iPhone HLG / PQ): an 8-bit copy without tone-mapping looks flat and washed out */
export const isHdr = (v: Pick<ProbeStream, "color_transfer">) => v.color_transfer === "smpte2084" || v.color_transfer === "arib-std-b67";

/**
 * Filter chain (ending with ",") that tone-maps an HDR stream to SDR BT.709 — empty for SDR. With zscale: linearise,
 * BT.2020 → BT.709 primaries, mobius curve (keeps mid-tones closest to the SDR look), back to BT.709 limited range.
 * Without zscale the HDR tags are at least replaced, so players and Chrome do not treat the 8-bit copy as HDR.
 */
export async function toneMapChain(v: Pick<ProbeStream, "color_transfer" | "color_space">): Promise<string> {
  if (!isHdr(v)) return "";
  if (!(await hasFilter("zscale"))) return "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709,";
  const min = v.color_space === "bt2020c" ? "bt2020c" : "bt2020nc";
  return `zscale=tin=${v.color_transfer}:pin=bt2020:min=${min}:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,`;
}

/** colour tags of an encode made from a tone-mapped source */
export const BT709_TAGS = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"];

/** a real video stream (not the cover picture some phones and apps attach as a second "video" stream) */
export const isVideoStream = (s: ProbeStream) => s.codec_type === "video" && !s.disposition?.attached_pic;
