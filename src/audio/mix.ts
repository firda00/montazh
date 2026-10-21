import { ffmpeg, ffprobe } from "../lib/ffmpeg.ts";
import { sfxFile, thinCues, type SfxCue, type SfxKind } from "./sfx.ts";

/**
 * Soundtrack mixer: the video's own audio (speech, if any) + a voiceover track (make --voice) + a looped
 * music bed + sound effects at cue times, normalised to −14 LUFS. With speech or a voiceover the music is
 * side-chain ducked under it (and with a voiceover the effects are ducked too); without speech the music
 * carries the video and the effects sit on top. The video stream is copied.
 */

/** relative levels per effect (dB), tuned so a whoosh is felt, not heard over the music */
export const SFX_GAIN: Record<SfxKind, number> = { whoosh: 3, pop: -7, tick: -9, impact: -3, riser: -1, ding: -5, swipe: -3, swish: 0, key: -12, click: -8, chime: -8 };
/** effects sit this much lower under a voiceover (before the ducking) */
export const SFX_UNDER_VOICE_DB = -5;

/**
 * Music bed under a voiceover (voice levelled to −16 LUFS first). Measured on the coffee make (ebur128 on the
 * stems, before the final −14 LUFS): the bed sits at −22 LUFS and swells to −16…−21 LUFS in the gaps between
 * beats, and a gentle side-chain (ratio 3, 10 ms attack, 160 ms release) holds it at −34.7 LUFS while the
 * narrator talks, i.e. −18.8 dB under the voice (−15.9 LUFS) — audible, not fighting. The old setting
 * (−27 LUFS, ratio 8) left it at −39.5 LUFS, −23.6 dB under the voice: inaudible on phone speakers.
 */
export const VOICE_BED = { lufs: -22, threshold: 0.004, ratio: 3, attack: 10, release: 160, knee: 4 } as const;

export interface MixOptions {
  video: string;
  out: string;
  duration: number;
  music?: string | null;
  /** music level before the final normalisation (LUFS); defaults: −16 alone, −24 under speech, VOICE_BED.lufs under a voiceover */
  musicLufs?: number;
  /** the video's audio track is speech to keep on top (montage); false for silent motion graphics */
  speech?: boolean;
  /** a voiceover WAV already placed on the video's timeline (starts at 0) */
  voice?: string | null;
  sfx?: SfxCue[];
  targetLufs?: number;
  /** seconds into the music file where the bed starts (cuts snapped to its beats assume this offset) */
  musicOffset?: number;
  /** gain on the video's own audio (dB), e.g. court noise under a highlights bed */
  origGainDb?: number;
  /** output ranges where the music dips (−10 dB, 0.25 s ramps): people talking in a highlights edit */
  duck?: { start: number; end: number }[];
  /**
   * reference style (Style DNA music_ducking_db): how far below the voice the bed sits under speech, dB (−26…−12).
   * The bed is levelled to −8 + dB LUFS before the side-chain (−16 → −24 LUFS, the montage default); null keeps the
   * bed steady with no side-chain (a reference without ducking).
   */
  musicUnderSpeechDb?: number | null;
  /**
   * stage 23, montage: where the speech is (output seconds, words merged across short pauses). With it the bed is not
   * side-chained (a compressor keyed by the voice pumps on every syllable of a jump-cut track) but automated: it sits
   * BED_UNDER_SPEECH_DB below the speech while someone talks and comes up to MONTAGE_BED_LUFS in real pauses, with
   * 0.3 s ramps. The final level is a linear trim (renderOutputs), not a second dynamic loudnorm.
   */
  speechRanges?: { start: number; end: number }[];
  /** fade-out length of the bed at the end (s); default min(2.5, D/4) — montage: the last clip */
  musicFadeOut?: number;
  /** skip the final loudnorm (the caller trims linearly) */
  noFinalLoudnorm?: boolean;
}

/** montage bed in pauses (LUFS, before the final −14) and how far below the speech it sits while someone talks */
export const MONTAGE_BED_LUFS = -21;
export const BED_UNDER_SPEECH_DB = -18;
/** speech level the rough cut is normalised to (finalize) */
const SPEECH_LUFS = -14;

/** Words → speech ranges: pauses shorter than `bridge` are bridged (the bed does not bob up between words). */
export function speechRangesFrom(words: { start: number; end: number }[], bridge = 0.6): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && w.start - last.end < bridge) last.end = Math.max(last.end, w.end);
    else out.push({ start: w.start, end: w.end });
  }
  return out.map((r) => ({ start: Math.round(r.start * 1000) / 1000, end: Math.round(r.end * 1000) / 1000 }));
}

/** music bed level (LUFS, before the final −14) for a reference's ducking depth; see MixOptions.musicUnderSpeechDb */
export const bedLufsForDucking = (db: number | null) => (db === null ? -22 : Math.min(-14, Math.max(-36, -8 + db)));

export interface MixResult {
  out: string;
  cues: number;
  music: boolean;
  voice: boolean;
}

export interface MixGraph {
  args: string[];
  cues: SfxCue[];
  /** nothing to mix: the video is copied through */
  copy: boolean;
}

const gainFilter = (db?: number) => (db ? `,volume=${db.toFixed(1)}dB` : "");

/** Music volume automation: `db` (default −10 dB) inside each range with `ramp` s ramps (eval per frame). */
export function duckFilter(ranges?: { start: number; end: number }[], db = -10, ramp = 0.25): string {
  if (!ranges?.length) return "";
  const r = (n: number) => String(Math.round(n * 1000) / 1000);
  const depth = Math.round((1 - 10 ** (db / 20)) * 1000) / 1000;
  const dips = ranges.map((x) => `clip(min((t-${r(x.start - ramp)})/${ramp},(${r(x.end + ramp)}-t)/${ramp}),0,1)`).join("+");
  return `,volume='1-${depth}*min(1,${dips})':eval=frame`;
}

/** The ffmpeg command for a mix (pure: the caller probes the video and resolves effect files). */
export function buildMixGraph(o: MixOptions, ctx: { hasAudio: boolean; sfxFile: (k: SfxKind) => string }): MixGraph {
  const D = o.duration;
  const speech = !!o.speech && ctx.hasAudio;
  const voice = !!o.voice;
  const cues = thinCues(o.sfx ?? [], { duration: D });
  const inputs: string[] = ["-i", o.video];
  const chains: string[] = [];
  const mixIn: string[] = [];
  let idx = 1;
  // side-chain keys: whatever should push the bed down (the video's speech and/or the voiceover)
  const keys: string[] = [];

  let voiceLabel = "";
  if (voice) {
    inputs.push("-i", o.voice!);
    const n = 1 + (o.music ? 1 : 0) + (cues.length ? 1 : 0);
    // the voice is levelled on its own first (−16 LUFS), so it stays the loudest thing after the final normalisation
    chains.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${D.toFixed(3)},asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-2:LRA=9${n > 1 ? `,asplit=${n}[vo]${Array.from({ length: n - 1 }, (_, k) => `[vk${k}]`).join("")}` : "[vo]"}`);
    for (let k = 0; k < n - 1; k++) keys.push(`[vk${k}]`);
    voiceLabel = "[vo]";
    idx++;
  }

  if (o.music) {
    inputs.push("-stream_loop", "-1", ...(o.musicOffset ? ["-ss", o.musicOffset.toFixed(3)] : []), "-i", o.music);
    const styled = o.musicUnderSpeechDb !== undefined && speech && !voice;
    // stage 23: a montage bed automated from the speech ranges instead of a side-chain
    const automated = !!o.speechRanges && speech && !voice && !o.duck && !(styled && o.musicUnderSpeechDb === null);
    const under = styled && typeof o.musicUnderSpeechDb === "number" ? o.musicUnderSpeechDb : BED_UNDER_SPEECH_DB;
    const lufs = o.musicLufs ?? (automated ? MONTAGE_BED_LUFS : styled ? bedLufsForDucking(o.musicUnderSpeechDb ?? null) : voice ? VOICE_BED.lufs : speech ? -24 : -16);
    // under a narrator the bed stays up to the last words and fades over the tail only
    const fadeOut = o.musicFadeOut !== undefined ? Math.min(Math.max(o.musicFadeOut, 0.8), 3.5, D / 2) : Math.min(voice ? 1.0 : 2.5, D / 4);
    const automation = automated ? duckFilter(o.speechRanges, Math.min(0, SPEECH_LUFS + under - lufs), 0.3) : duckFilter(o.duck);
    chains.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${D.toFixed(3)},asetpts=PTS-STARTPTS,loudnorm=I=${lufs}:TP=-2:LRA=11,afade=t=in:st=0:d=${voice ? 0.15 : 0.8}:curve=qsin,afade=t=out:st=${(D - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}:curve=qsin${automation}[mus]`);
    idx++;
    if (speech) {
      chains.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo${voice ? "[sp]" : ",asplit=2[sp][sc]"}`);
      mixIn.push("[sp]");
    } else if (ctx.hasAudio) {
      chains.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo${gainFilter(o.origGainDb)}[orig]`);
      mixIn.push("[orig]");
    }
    if (voice) {
      // music dips ~11 dB while the narrator talks and swells back quickly in the pauses between beats
      const B = VOICE_BED;
      chains.push(`[mus]${keys.shift()}sidechaincompress=threshold=${B.threshold}:ratio=${B.ratio}:attack=${B.attack}:release=${B.release}:knee=${B.knee}:makeup=1[duck]`);
      mixIn.push("[duck]");
    } else if (automated) {
      // the bed follows the speech ranges (volume automation above): the speech split goes unused
      chains.push(`[sc]anullsink`);
      mixIn.push("[mus]");
    } else if (styled && o.musicUnderSpeechDb === null) {
      // the reference keeps its bed steady under the voice: no side-chain (the speech split goes unused)
      chains.push(`[sc]anullsink`);
      mixIn.push("[mus]");
    } else if (speech) {
      // music dips ~9 dB while someone talks, comes back in the pauses
      chains.push(`[mus][sc]sidechaincompress=threshold=0.02:ratio=6:attack=30:release=450:makeup=1[duck]`);
      mixIn.push("[duck]");
    } else mixIn.push("[mus]");
  } else if (ctx.hasAudio) {
    chains.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo[orig]`);
    mixIn.push("[orig]");
  }
  if (voiceLabel) mixIn.unshift(voiceLabel);

  const fx: string[] = [];
  for (const [k, c] of cues.entries()) {
    inputs.push("-i", ctx.sfxFile(c.kind));
    const ms = Math.max(0, Math.round(c.t * 1000));
    const gain = SFX_GAIN[c.kind] + (c.gain ?? 0) + (voice ? SFX_UNDER_VOICE_DB : 0);
    chains.push(`[${idx}:a]adelay=${ms}|${ms},volume=${gain.toFixed(1)}dB[fx${k}]`);
    fx.push(`[fx${k}]`);
    idx++;
  }
  if (fx.length && voice) {
    // effects go on one bus that is ducked by the voice too: quieter while the narrator talks
    chains.push(`${fx.join("")}amix=inputs=${fx.length}:normalize=0:duration=longest[fxbus]`);
    chains.push(`[fxbus]${keys.shift()}sidechaincompress=threshold=0.015:ratio=4:attack=15:release=250:makeup=1[fxduck]`);
    mixIn.push("[fxduck]");
  } else mixIn.push(...fx);

  if (!mixIn.length) return { args: ["-i", o.video, "-c", "copy", "-movflags", "+faststart", o.out], cues: [], copy: true };
  const target = o.targetLufs ?? -14;
  chains.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0:duration=longest,atrim=0:${D.toFixed(3)}${o.noFinalLoudnorm ? "" : `,loudnorm=I=${target}:TP=-1.5:LRA=11`}[aout]`);
  return {
    args: [...inputs, "-filter_complex", chains.join(";"), "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", D.toFixed(3), "-movflags", "+faststart", o.out],
    cues,
    copy: false,
  };
}

export async function mixSoundtrack(o: MixOptions): Promise<MixResult> {
  const probe = await ffprobe(o.video);
  const hasAudio = probe.streams.some((s) => s.codec_type === "audio");
  const files = new Map<SfxKind, string>();
  for (const c of thinCues(o.sfx ?? [], { duration: o.duration })) if (!files.has(c.kind)) files.set(c.kind, await sfxFile(c.kind));
  const g = buildMixGraph(o, { hasAudio, sfxFile: (k) => files.get(k)! });
  await ffmpeg(g.args);
  return { out: o.out, cues: g.cues.length, music: !g.copy && !!o.music, voice: !g.copy && !!o.voice };
}
