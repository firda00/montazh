import fs from "node:fs/promises";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.ts";
import { WORKSPACE_ROOT } from "../lib/workspace.ts";

/**
 * Sound effects synthesised with ffmpeg (aevalsrc / anoisesrc): no samples, no licences, same
 * bytes every time. Generated once into workspace/_cache/sfx/<kind>.wav (48 kHz stereo).
 */

export const SFX_KINDS = ["whoosh", "pop", "tick", "impact", "riser", "ding", "swipe"] as const;
export type SfxKind = (typeof SFX_KINDS)[number];

export interface SfxCue {
  /** seconds on the output timeline */
  t: number;
  kind: SfxKind;
  /** dB relative to the effect's own level */
  gain?: number;
}

/** lavfi graphs producing each effect (mono → stereo, 48 kHz) */
const RECIPES: Record<SfxKind, { d: number; graph: string }> = {
  // band-limited pink noise swelling and fading: a transition whoosh
  whoosh: { d: 0.5, graph: "anoisesrc=d=0.5:c=pink:a=0.55:r=48000,highpass=f=500,lowpass=f=7000,afade=t=in:st=0:d=0.22:curve=qsin,afade=t=out:st=0.22:d=0.28:curve=exp" },
  // pitch-dropping blip: UI pop for bubbles, items, words
  pop: { d: 0.16, graph: "aevalsrc='0.7*sin(2*PI*(520*t+29.3*(1-exp(-30*t))))*exp(-28*t)':s=48000:d=0.16" },
  // short high click: list items, counters, typing
  tick: { d: 0.06, graph: "aevalsrc='0.55*sin(2*PI*3200*t)*exp(-110*t)':s=48000:d=0.06" },
  // low boom with a noise transient: big numbers, the hook
  impact: { d: 1.0, graph: "aevalsrc='0.95*sin(2*PI*(48*t+60*(1-exp(-7*t))/7))*exp(-3.6*t)+0.25*(random(0)*2-1)*exp(-40*t)':s=48000:d=1.0,lowpass=f=2500" },
  // rising sweep with noise: before the hook or a reveal
  riser: { d: 1.2, graph: "aevalsrc='0.22*sin(2*PI*(180*t+260*t*t))*(t/1.2)+0.12*(random(0)*2-1)*(t/1.2)*(t/1.2)':s=48000:d=1.2,highpass=f=150,afade=t=out:st=1.1:d=0.1" },
  // bell: the call to action
  ding: { d: 1.0, graph: "aevalsrc='(0.5*sin(2*PI*1318*t)+0.25*sin(2*PI*2637*t)+0.12*sin(2*PI*3955*t))*exp(-4.5*t)':s=48000:d=1.0" },
  // short airy swipe: marker highlights
  swipe: { d: 0.28, graph: "anoisesrc=d=0.28:c=white:a=0.35:r=48000,highpass=f=2500,afade=t=in:st=0:d=0.08,afade=t=out:st=0.08:d=0.2:curve=exp" },
};

export const SFX_DIR = path.join(WORKSPACE_ROOT, "_cache", "sfx");

/** Path of an effect, synthesising it on first use. */
export async function sfxFile(kind: SfxKind, dir = SFX_DIR): Promise<string> {
  const file = path.join(dir, `${kind}.wav`);
  try {
    await fs.access(file);
    return file;
  } catch {}
  await fs.mkdir(dir, { recursive: true });
  const r = RECIPES[kind];
  const tmp = `${file}.tmp.wav`;
  await ffmpeg(["-f", "lavfi", "-i", r.graph, "-t", String(r.d), "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", tmp]);
  await fs.rename(tmp, file);
  return file;
}

/** Drops cues that would pile up: at most one cue per kind within `gap` seconds, and at most `max` overall. */
export function thinCues(cues: SfxCue[], o: { gap?: number; max?: number; duration?: number } = {}): SfxCue[] {
  const gap = o.gap ?? 0.18;
  const out: SfxCue[] = [];
  for (const c of [...cues].sort((a, b) => a.t - b.t)) {
    if (c.t < 0 || (o.duration !== undefined && c.t > o.duration - 0.05)) continue;
    if (out.some((x) => x.kind === c.kind && Math.abs(x.t - c.t) < gap)) continue;
    if (out.some((x) => Math.abs(x.t - c.t) < 0.06)) continue; // two different effects on the same frame: keep the first
    out.push(c);
  }
  return out.slice(0, o.max ?? 48);
}
