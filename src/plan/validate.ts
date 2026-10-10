import type { Clip, Transcript } from "../schemas/index.ts";

type Word = Transcript["segments"][number]["words"][number];

export function allWords(transcript: Transcript): Word[] {
  return transcript.segments.flatMap((s) => s.words);
}

/** The word that time `t` falls strictly inside of (with a small tolerance at the edges). */
export function wordAt(words: Word[], t: number, tol = 0.03): Word | undefined {
  return words.find((w) => t > w.start + tol && t < w.end - tol);
}

export interface BoundaryIssue {
  clip: number;
  edge: "start" | "end";
  t: number;
  word: Word;
  suggested: number;
}

/** Spec §5.3: a clip must not begin or end in the middle of a word. */
export function checkClipBoundaries(clips: Clip[], transcript: Transcript): BoundaryIssue[] {
  const words = allWords(transcript);
  const issues: BoundaryIssue[] = [];
  clips.forEach((c, i) => {
    const ws = wordAt(words, c.src_start);
    if (ws) issues.push({ clip: i, edge: "start", t: c.src_start, word: ws, suggested: ws.start });
    const we = wordAt(words, c.src_end);
    if (we) issues.push({ clip: i, edge: "end", t: c.src_end, word: we, suggested: we.end });
  });
  return issues;
}

/**
 * Moves clip edges that land inside a word to that word's boundary (start → earlier,
 * end → later, so the word is kept whole). Edges that would need to move more than
 * maxShift are left alone and reported.
 */
export function snapClipsToWords(clips: Clip[], transcript: Transcript, maxShift = 0.4): { clips: Clip[]; notes: string[] } {
  const notes: string[] = [];
  const out = clips.map((c) => ({ ...c }));
  for (const issue of checkClipBoundaries(clips, transcript)) {
    const shift = Math.abs(issue.suggested - issue.t);
    const label = `clip ${issue.clip} ${issue.edge} ${issue.t.toFixed(2)}s cuts the word "${issue.word.w}" (${issue.word.start}-${issue.word.end}s)`;
    if (shift > maxShift) {
      notes.push(`${label} — not snapped, would move ${shift.toFixed(2)}s`);
      continue;
    }
    if (issue.edge === "start") out[issue.clip].src_start = issue.suggested;
    else out[issue.clip].src_end = issue.suggested;
    notes.push(`${label} → snapped to ${issue.suggested.toFixed(2)}s`);
  }
  return { clips: out.filter((c) => c.src_end > c.src_start), notes };
}
