// Shape of a design job (workspace/_proto/<output>.design.json), as consumed by the composition.
export type Word = {w: string; start: number; end: number; clip?: number; phrase?: number};
export type Page = {start: number; end: number; words: Word[]};
export type Title = {at: number; duration: number; text: string; style?: string};

export type Design = {
  font: {family: string; file?: string; weight: number};
  colors: {text: string; highlight: string; stroke: string; title: string; title_bg: string};
  captions: {
    anchor_y: number;
    max_words: number;
    max_chars: number;
    font_size: number;
    line_height: number;
    uppercase: boolean;
    stroke_width: number;
    word_animation: string;
    pop_scale: number;
    page_animation: string;
  };
  titles: {anchor_y: number; font_size: number; max_lines: number; animation: string; padding: number; radius: number};
  safe_area: {x: number; y: number};
};

export type Timeline = {
  output_id?: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  titles?: Title[];
  captions?: {enabled?: boolean; language?: string; style?: string};
  [k: string]: unknown;
};

// A type alias (not an interface) so it satisfies Remotion's Record<string, unknown> props constraint.
export type DesignJob = {
  job_id?: string;
  timeline: Timeline;
  pages: Page[];
  design: Design;
  preset?: string;
  assets?: {video: string; font: string};
  [k: string]: unknown;
};
