import type { Clip, Media, Output, Transcript } from "../schemas/index.ts";
import { OUTPUT_SIZE } from "../cut/index.ts";
import { TARGET_FPS } from "../ingest/index.ts";

/** A word placed on the OUTPUT timeline (seconds from the start of the rendered video). */
export interface OutWord {
  w: string;
  start: number;
  end: number;
  clip: number;
  phrase: number;
}

/** Consecutive words of one source phrase inside one clip — the unit captions are built from. */
export interface OutPhrase {
  phrase: number;
  clip: number;
  start: number;
  end: number;
  lang: string;
  text: string;
  words: OutWord[];
}

export interface OutClip {
  index: number;
  out_start: number;
  out_end: number;
  src_start: number;
  src_end: number;
  speed: number;
}

export interface OutTitle {
  at: number;
  duration: number;
  text: string;
  style: string;
}

export interface DesignTimeline {
  output_id: string;
  aspect: Output["aspect"];
  width: number;
  height: number;
  fps: number;
  duration: number;
  clips: OutClip[];
  phrases: OutPhrase[];
  titles: OutTitle[];
  captions: Output["captions"];
}

export const DEFAULT_TITLE_DURATION = 2.5;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Maps transcript words through the EDL clips onto the output timeline. A word belongs to a clip
 * when its midpoint falls inside the clip's source range; its edges are clipped to the clip, and
 * speed changes compress its time. Phrases are split at clip boundaries so a caption never spans a cut.
 *
 * Clip placement mirrors the cut exactly: every segment is encoded at TARGET_FPS and rounded UP to
 * whole frames (its audio is padded), so clip k starts at Σ ceil(len·fps)/fps of the clips before it.
 * `clips` may be the snapped clips the cut actually used (cut.json) rather than the EDL's.
 */
export function buildDesignTimeline(output: Output, transcript: Transcript, media: Media, usedClips?: Clip[]): DesignTimeline {
  const size = OUTPUT_SIZE[output.aspect];
  const fps = TARGET_FPS;
  const clips: OutClip[] = [];
  let cursor = 0;
  (usedClips ?? output.clips).forEach((c, index) => {
    const srcEnd = Math.min(c.src_end, media.duration);
    const len = Math.max(0, srcEnd - c.src_start) / c.speed;
    const frames = Math.ceil(len * fps - 1e-6);
    const outLen = frames / fps;
    clips.push({ index, out_start: r3(cursor), out_end: r3(cursor + outLen), src_start: c.src_start, src_end: srcEnd, speed: c.speed });
    cursor += outLen;
  });
  const duration = r3(cursor);

  const phrases: OutPhrase[] = [];
  for (const clip of clips) {
    transcript.segments.forEach((seg, phraseIndex) => {
      const words: OutWord[] = [];
      for (const w of seg.words) {
        const mid = (w.start + w.end) / 2;
        if (mid < clip.src_start || mid >= clip.src_end) continue;
        const start = clip.out_start + (Math.max(w.start, clip.src_start) - clip.src_start) / clip.speed;
        // a word is never dropped for being short (speed-ups shrink it): it keeps at least 10 ms
        const end = Math.max(clip.out_start + (Math.min(w.end, clip.src_end) - clip.src_start) / clip.speed, start + 0.01);
        words.push({ w: w.w, start: r3(start), end: r3(end), clip: clip.index, phrase: phraseIndex });
      }
      if (words.length === 0) return;
      phrases.push({
        phrase: phraseIndex,
        clip: clip.index,
        start: words[0].start,
        end: words[words.length - 1].end,
        lang: seg.lang ?? transcript.language,
        text: words.map((x) => x.w).join(" "),
        words,
      });
    });
  }
  phrases.sort((a, b) => a.start - b.start);

  const titles: OutTitle[] = output.titles
    .map((t) => {
      const at = Math.min(Math.max(0, t.at), Math.max(0, duration - 0.5));
      const dur = Math.min(t.duration ?? DEFAULT_TITLE_DURATION, Math.max(0.5, duration - at));
      return { at: r3(at), duration: r3(dur), text: t.text, style: t.style };
    })
    .filter((t) => t.duration > 0);

  return { output_id: output.id, aspect: output.aspect, width: size.w, height: size.h, fps, duration, clips, phrases, titles, captions: output.captions };
}

/** Identity of a phrase part on the output timeline (a transcript phrase split by a cut yields several parts). */
export function partKey(p: Pick<OutPhrase, "phrase" | "clip">) {
  return `${p.phrase}:${p.clip}`;
}

/** Splits a phrase into caption "pages" of at most `maxWords` words (and at most `maxChars` characters). */
export function paginate(phrase: OutPhrase, maxWords = 4, maxChars = 22): OutWord[][] {
  const pages: OutWord[][] = [];
  let cur: OutWord[] = [];
  let chars = 0;
  for (const w of phrase.words) {
    const next = chars + (cur.length ? 1 : 0) + w.w.length;
    if (cur.length && (cur.length >= maxWords || next > maxChars)) {
      pages.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(w);
    chars += (cur.length > 1 ? 1 : 0) + w.w.length;
  }
  if (cur.length) pages.push(cur);
  return pages;
}
