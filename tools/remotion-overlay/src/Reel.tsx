import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  interpolateColors,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {Video} from '@remotion/media';
import {loadFont} from '@remotion/fonts';
import {FONT_FAMILY, FONT_FILE, VIDEO_FILE} from './assets';
import type {Design, DesignJob, Page, Title} from './types';

// Variable TTF (Latin + Cyrillic): declare the whole weight axis so fontWeight 800 maps onto it.
// loadFont() blocks the render (delayRender) until the face is ready.
loadFont({family: FONT_FAMILY, url: staticFile(FONT_FILE), weight: '100 900', format: 'truetype'});

// TikTokPage-like shape (@remotion/captions), built directly from design.json pages (already output seconds).
type Token = {text: string; fromMs: number; toMs: number};
type CaptionPageData = {text: string; startMs: number; durationMs: number; tokens: Token[]};

// A page stays on screen past its last word until the next page starts, capped at this many seconds,
// so short gaps between pages do not flash an empty frame.
const HOLD_AFTER_PAGE_S = 0.5;

const toTikTokPage = (p: Page, uppercase: boolean, lang: string): CaptionPageData => {
  const tokens = p.words.map((w) => ({
    text: uppercase ? w.w.toLocaleUpperCase(lang) : w.w,
    fromMs: Math.round(w.start * 1000),
    toMs: Math.round(w.end * 1000),
  }));
  return {
    text: tokens.map((t) => t.text).join(' '),
    startMs: Math.round(p.start * 1000),
    durationMs: Math.round((p.end - p.start) * 1000),
    tokens,
  };
};

const CaptionPage: React.FC<{page: CaptionPageData; fromFrame: number; design: Design}> = ({page, fromFrame, design}) => {
  const frame = useCurrentFrame(); // relative to the page's <Sequence>
  const {fps, width, height} = useVideoConfig();
  const c = design.captions;
  const k = width / 1080; // design px are specified at 1080 width
  const absFrame = fromFrame + frame;
  const tokStart = page.tokens.map((t) => Math.round((t.fromMs / 1000) * fps));

  // Active token = the last one that has started (keeps the highlight through short pauses inside a page).
  let active = -1;
  tokStart.forEach((s, i) => {
    if (s <= absFrame) active = i;
  });

  // page_animation 'fade_up': fade in while rising from below.
  const enter = spring({frame, fps, config: {damping: 200}, durationInFrames: 6});
  const rise = interpolate(enter, [0, 1], [28 * k, 0]);

  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          left: width * design.safe_area.x,
          right: width * design.safe_area.x,
          top: height * c.anchor_y,
          transform: 'translateY(-50%) translateY(' + rise + 'px)',
          opacity: enter,
          textAlign: 'center',
          textWrap: 'balance',
          fontFamily: FONT_FAMILY,
          fontWeight: design.font.weight,
          fontSize: c.font_size * k,
          lineHeight: c.line_height,
          letterSpacing: '-0.01em',
          // The outline eats ~2*stroke_width of each space, and a popped word grows by
          // (pop_scale-1)/2 of its width on each side: widen the gaps so neighbours never overlap.
          wordSpacing: (0.12 + (c.pop_scale - 1) * 2.5) + 'em',
          color: design.colors.text,
          // stroke_width = visible outline; paint-order puts the stroke behind the fill, so the
          // inner half is hidden and the stroke has to be drawn at twice the width.
          WebkitTextStroke: (c.stroke_width * 2 * k) + 'px ' + design.colors.stroke,
          paintOrder: 'stroke fill',
        }}
      >
        {page.tokens.map((t, i) => {
          // word_animation 'pop': springs to pop_scale when the word starts, settles back when the next starts.
          const inV = absFrame >= tokStart[i]
            ? spring({frame: absFrame - tokStart[i], fps, config: {damping: 9, stiffness: 260, mass: 0.6}})
            : 0;
          const outV = i < active && i + 1 < tokStart.length
            ? spring({frame: absFrame - tokStart[i + 1], fps, config: {damping: 200}, durationInFrames: 5})
            : 0;
          const level = inV * (1 - outV);
          const isActive = i === active;
          const scale = 1 + (c.pop_scale - 1) * level;
          const color = isActive
            ? design.colors.highlight
            : interpolateColors(Math.min(1, Math.max(0, level)), [0, 1], [design.colors.text, design.colors.highlight]);
          return (
            <React.Fragment key={t.fromMs + '-' + i}>
              {i > 0 ? ' ' : null}
              <span
                style={{
                  display: 'inline-block',
                  transform: 'scale(' + scale + ')',
                  transformOrigin: '50% 55%',
                  color,
                }}
              >
                {t.text}
              </span>
            </React.Fragment>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const TitleCard: React.FC<{title: Title; design: Design; durationInFrames: number}> = ({title, design, durationInFrames}) => {
  const frame = useCurrentFrame(); // relative to the title's <Sequence>
  const {fps, width, height} = useVideoConfig();
  const t = design.titles;
  const k = width / 1080;
  // titles.animation 'slide_up': spring in from below, quick fade/lift out over the last 8 frames.
  const enter = spring({frame, fps, config: {damping: 16, stiffness: 140}});
  const exit = interpolate(frame, [durationInFrames - 8, durationInFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const y = interpolate(enter, [0, 1], [110 * k, 0]) - exit * 24 * k;
  const opacity = interpolate(frame, [0, 6], [0, 1], {extrapolateRight: 'clamp'}) * (1 - exit);
  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          left: width * design.safe_area.x,
          right: width * design.safe_area.x,
          top: height * t.anchor_y,
          display: 'flex',
          justifyContent: 'center',
          transform: 'translateY(-50%) translateY(' + y + 'px)',
          opacity,
        }}
      >
        <div
          style={{
            background: design.colors.title_bg,
            borderRadius: t.radius * k,
            padding: (t.padding * k) + 'px ' + (t.padding * 1.5 * k) + 'px',
            fontFamily: FONT_FAMILY,
            fontWeight: design.font.weight,
            fontSize: t.font_size * k,
            lineHeight: 1.12,
            letterSpacing: '-0.015em',
            color: design.colors.title,
            textAlign: 'center',
            textWrap: 'balance',
            display: '-webkit-box',
            WebkitLineClamp: t.max_lines,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {title.text}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const Reel: React.FC<DesignJob> = (job) => {
  const {fps} = useVideoConfig();
  const d = job.design;
  const lang = job.timeline.captions?.language ?? 'ru';
  const captionsOn = job.timeline.captions?.enabled !== false;
  const pages = job.pages.map((p) => toTikTokPage(p, d.captions.uppercase, lang));
  const videoFile = job.assets?.video ?? VIDEO_FILE;

  return (
    <AbsoluteFill style={{backgroundColor: 'black'}}>
      {/* Background: picture AND sound (not muted) - the rough cut's AAC ends up in the output. */}
      <AbsoluteFill>
        <Video src={staticFile(videoFile)} objectFit="cover" style={{width: '100%', height: '100%'}} />
      </AbsoluteFill>

      {captionsOn
        ? pages.map((page, i) => {
            const from = Math.round((page.startMs / 1000) * fps);
            const holdEnd = Math.round(((page.startMs + page.durationMs) / 1000 + HOLD_AFTER_PAGE_S) * fps);
            const next = pages[i + 1];
            const to = next ? Math.min(holdEnd, Math.round((next.startMs / 1000) * fps)) : holdEnd;
            if (to - from <= 0) return null;
            return (
              <Sequence key={'page-' + i} from={from} durationInFrames={to - from} name={'Page ' + (i + 1) + ': ' + page.text} layout="none">
                <CaptionPage page={page} fromFrame={from} design={d} />
              </Sequence>
            );
          })
        : null}

      {(job.timeline.titles ?? []).map((title, i) => {
        const from = Math.round(title.at * fps);
        const dur = Math.max(1, Math.round(title.duration * fps));
        return (
          <Sequence key={'title-' + i} from={from} durationInFrames={dur} name={'Title: ' + title.text} layout="none">
            <TitleCard title={title} design={d} durationInFrames={dur} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
