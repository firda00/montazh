import { ffmpeg, ffprobe } from "../lib/ffmpeg.ts";
import { sfxFile, thinCues, type SfxCue, type SfxKind } from "./sfx.ts";

/**
 * Soundtrack mixer: the video's own audio (speech, if any) + a looped music bed + sound effects at
 * cue times, normalised to −14 LUFS. With speech the music is side-chain ducked under it; without
 * speech the music carries the video and the effects sit on top. The video stream is copied.
 */

/** relative levels per effect (dB), tuned so a whoosh is felt, not heard over the music */
const SFX_GAIN: Record<SfxKind, number> = { whoosh: 3, pop: -7, tick: -9, impact: -3, riser: -1, ding: -5, swipe: -3 };

export interface MixOptions {
  video: string;
  out: string;
  duration: number;
  music?: string | null;
  /** music level before the final normalisation (LUFS); defaults: −16 alone, −24 under speech */
  musicLufs?: number;
  /** the video's audio track is speech to keep on top (montage); false for silent motion graphics */
  speech?: boolean;
  sfx?: SfxCue[];
  targetLufs?: number;
}

export interface MixResult {
  out: string;
  cues: number;
  music: boolean;
}

export async function mixSoundtrack(o: MixOptions): Promise<MixResult> {
  const D = o.duration;
  const probe = await ffprobe(o.video);
  const hasAudio = probe.streams.some((s) => s.codec_type === "audio");
  const speech = !!o.speech && hasAudio;
  const cues = thinCues(o.sfx ?? [], { duration: D });
  const inputs: string[] = ["-i", o.video];
  const chains: string[] = [];
  const mixIn: string[] = [];
  let idx = 1;

  if (o.music) {
    inputs.push("-stream_loop", "-1", "-i", o.music);
    const lufs = o.musicLufs ?? (speech ? -24 : -16);
    const fadeOut = Math.min(2.5, D / 4);
    chains.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${D.toFixed(3)},asetpts=PTS-STARTPTS,loudnorm=I=${lufs}:TP=-2:LRA=11,afade=t=in:st=0:d=0.8,afade=t=out:st=${(D - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[mus]`);
    idx++;
    if (speech) {
      chains.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[sp][sc]`);
      // music dips ~9 dB while someone talks, comes back in the pauses
      chains.push(`[mus][sc]sidechaincompress=threshold=0.02:ratio=6:attack=30:release=450:makeup=1[duck]`);
      mixIn.push("[sp]", "[duck]");
    } else {
      mixIn.push("[mus]");
      if (hasAudio) {
        chains.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo[orig]`);
        mixIn.push("[orig]");
      }
    }
  } else if (hasAudio) {
    chains.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo[orig]`);
    mixIn.push("[orig]");
  }

  for (const [k, c] of cues.entries()) {
    inputs.push("-i", await sfxFile(c.kind));
    const ms = Math.max(0, Math.round(c.t * 1000));
    chains.push(`[${idx}:a]adelay=${ms}|${ms},volume=${(SFX_GAIN[c.kind] + (c.gain ?? 0)).toFixed(1)}dB[fx${k}]`);
    mixIn.push(`[fx${k}]`);
    idx++;
  }

  if (!mixIn.length) {
    // nothing to add: copy through
    await ffmpeg(["-i", o.video, "-c", "copy", "-movflags", "+faststart", o.out]);
    return { out: o.out, cues: 0, music: false };
  }
  const target = o.targetLufs ?? -14;
  chains.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0:duration=longest,atrim=0:${D.toFixed(3)},loudnorm=I=${target}:TP=-1.5:LRA=11[aout]`);
  await ffmpeg([...inputs, "-filter_complex", chains.join(";"), "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", D.toFixed(3), "-movflags", "+faststart", o.out]);
  return { out: o.out, cues: cues.length, music: !!o.music };
}
