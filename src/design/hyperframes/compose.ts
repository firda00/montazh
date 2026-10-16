import type { DesignJob } from "../export.ts";
import { buildSplitLayer } from "./split.ts";

/** "фото: Gage Skidmore · CC BY-SA… · wikimedia" — the on-frame credit line of a panel photo */
export function shortPhotoCredit(c: { creator: string; license: string; license_version: string; source: string }): string {
  const lic = c.license === "cc0" ? "CC0" : c.license === "pdm" ? "Public Domain" : `CC ${c.license.toUpperCase()} ${c.license_version}`.trim();
  return [`фото: ${c.creator || "автор не указан"}`.slice(0, 40), lic, c.source].filter(Boolean).join(" · ");
}
import type { Layout, LayoutPage } from "../layout-types.ts";
import { CALLOUT_ANCHOR_Y, outroText, splitBalanced } from "../layout.ts";

/** Paths inside the generated project (relative to index.html). */
export interface ComposeAssets {
  videoRel: string;
  fontRel: string;
  gsapRel: string;
  /** split layout: panel images (index → project-relative path) and the extra @font-face rules */
  panelRel?: Record<number, string>;
  extraFontFaces?: string;
  /** split layout: the speaker cutout — the plate replaces the rough cut as the a-roll, the pop strip goes above the seam */
  cutoutRel?: { plate: string; pop?: string };
}

export const COMPOSE_VERSION = "hf-compose/1";
export { CALLOUT_ANCHOR_Y };

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const fmt = (x: number) => String(r3(x));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export { splitBalanced };

/** Vertical centring on an anchor without CSS transforms: pad the full-frame clip so its content box is centred at anchorY·H. */
function anchorPad(anchorY: number, height: number) {
  const cy = anchorY * height;
  return cy >= height / 2 ? { top: r3(2 * cy - height), bottom: 0 } : { top: 0, bottom: r3(height - 2 * cy) };
}

/**
 * DesignJob + Layout → standalone HyperFrames composition (one file, no sub-compositions).
 * Video only: the rough cut's audio is muxed back at finalize, so no <audio> element here.
 * Pure and deterministic: same inputs → byte-identical HTML.
 */
export function composeHyperframes(job: DesignJob, layout: Layout, assets: ComposeAssets): string {
  const D = job.design;
  const C = D.colors;
  const W = layout.frame.width;
  const H = layout.frame.height;
  const FPS = layout.frame.fps;
  const DUR = r3(layout.frame.duration);
  const scale = Math.min(W, H) / 1080; // spec sizes are px on a 1080-wide portrait frame; landscape scales by its height
  const capPad = anchorPad(layout.captions.anchorY, H);
  const ttlPad = anchorPad(layout.titles.anchorY, H);
  const strokeVisible = r3(layout.captions.strokeWidth); // already in output px (layout scales it); drawn at 2× with paint-order
  const safeX = Math.round(D.safe_area.x * W);
  const lang = layout.captions.language || "ru";

  const capHtml: string[] = [];
  const tw: string[] = [];

  // stage 23: a page whose spot differs from the page before it (moved off a face) crossfades instead of jumping
  const yOf = (p: LayoutPage) => p.anchorY ?? layout.captions.anchorY;
  layout.pages.forEach((p: LayoutPage, pi: number) => {
    const id = `cap-${p.index}`;
    const prevPage = layout.pages[pi - 1];
    const nextPage = layout.pages[pi + 1];
    const movedIn = !!prevPage && Math.abs(yOf(prevPage) - yOf(p)) > 0.005 && p.dispStart - prevPage.dispEnd < 0.05;
    const movesOut = !!nextPage && Math.abs(yOf(nextPage) - yOf(p)) > 0.005 && nextPage.dispStart - p.dispEnd < 0.05 && !p.exitFade;
    const pad = p.anchorY !== undefined && Math.abs(p.anchorY - layout.captions.anchorY) > 1e-6 ? anchorPad(p.anchorY, H) : null;
    // start/duration are rounded as a pair so back-to-back pages never leave a 1 ms gap; never past the composition end
    const ds = r3(Math.min(p.dispStart, DUR));
    const de = r3(Math.min(p.dispEnd, DUR));
    if (de <= ds) return;
    const lines = p.lines
      .map((line, li) => {
        const spans = line.words.map((w, wi) => `<span class="w" id="${id}-l${li}-w${wi}">${esc(w.text).replace(/ /g, "&nbsp;")}</span>`).join("");
        return `        <span class="cap-line" id="${id}-line${li}">${spans}</span>`;
      })
      .join("\n");
    capHtml.push(
      `      <section id="${id}" class="clip cap caption-group" data-start="${fmt(ds)}" data-duration="${fmt(de - ds)}" data-track-index="1" data-track-kind="captions" style="font-size:${r3(p.fontSize)}px;--gap:${r3(p.wordGap)}px${pad ? `;padding:${pad.top}px ${safeX}px ${pad.bottom}px` : ""}">\n${lines}\n      </section>`,
    );
    const lineSel = p.lines.map((_, li) => `#${id}-line${li}`).join(", ");
    if (D.captions.page_animation === "fade_up") {
      tw.push(`tl.fromTo("${lineSel}", { opacity: 0, y: ${r3(36 * scale)} }, { opacity: 1, y: 0, duration: 0.22, ease: "power2.out" }, ${fmt(ds)});`);
    } else if (movedIn) {
      tw.push(`tl.fromTo("${lineSel}", { opacity: 0 }, { opacity: 1, duration: 0.12, ease: "power1.out" }, ${fmt(ds)});`);
    }
    if (movesOut && de - ds > 0.3) {
      // the next page appears elsewhere: this one fades over its last frames instead of vanishing on the cut
      tw.push(`tl.fromTo("${lineSel}", { opacity: 1 }, { opacity: 0, duration: 0.1, ease: "power1.in", immediateRender: false }, ${fmt(de - 0.1)});`);
    }
    if (p.exitFade && de - ds > 0.3) {
      const outAt = Math.max(ds + 0.1, de - 0.14);
      tw.push(`tl.fromTo("${lineSel}", { opacity: 1 }, { opacity: 0, duration: 0.12, ease: "power1.in", immediateRender: false }, ${fmt(outAt)});`);
    }
    if (D.captions.word_animation === "none") return;
    const all = p.lines.flatMap((line, li) => line.words.map((w, wi) => ({ ...w, sel: `#${id}-l${li}-w${wi}` })));
    all.forEach((w, k) => {
      const next = all[k + 1];
      const hlEnd = next ? next.start : de;
      const span = Math.max(hlEnd - w.start, 1 / FPS);
      const inDur = r3(Math.min(0.12, Math.max(0.04, span * 0.6)));
      const sc = D.captions.word_animation === "pop" ? r3(w.popScale) : 1;
      tw.push(`tl.fromTo("${w.sel}", { scale: 1, color: "${C.text}" }, { scale: ${sc}, color: "${C.highlight}", duration: ${inDur}, ease: "back.out(1.7)", immediateRender: false }, ${fmt(w.start)});`);
      if (next) {
        tw.push(`tl.fromTo("${w.sel}", { scale: ${sc}, color: "${C.highlight}" }, { scale: 1, color: "${C.text}", duration: 0.1, ease: "power1.out", immediateRender: false }, ${fmt(Math.max(hlEnd, w.start + inDur))});`);
      }
    });
  });

  const ttlHtml: string[] = [];
  // the cutout files are cut to their boxes at 1080 px wide: scale them to this frame
  const cutoutBox =
    D.layout === "split" && job.cutout && assets.cutoutRel
      ? { plateHeight: r3(job.cutout.plate_height * (W / job.cutout.width)), popHeight: assets.cutoutRel.pop ? r3(job.cutout.overlap * (W / job.cutout.width)) : 0 }
      : undefined;
  // split layout: the hook title replaces the EDL titles (they would collide with the top panels)
  const split =
    D.layout === "split" && job.panels
      ? buildSplitLayer({ W, H, duration: DUR, design: D, panels: job.panels, images: assets.panelRel ?? {}, credits: Object.fromEntries((job.panel_credits ?? []).map((c) => [c.beat, shortPhotoCredit(c)])), faceY: job.face_y, serifFamily: `'VPlayfairItalic', serif`, monoFamily: `'VMono', monospace`, displayFamily: `'${layout.font.family.replace(/['"<>]/g, "")}', sans-serif`, cutout: cutoutBox })
      : null;
  if (split) tw.push(...split.tweens);
  if (!split) layout.titlesOut.forEach((t) => {
    const id = `ttl-${t.index}`;
    if (t.style === "lower") {
      // a line under a people moment (what is said / happens) where the speech itself cannot be captioned
      const pad = anchorPad(t.anchorY ?? D.captions.anchor_y, H);
      ttlHtml.push(
        `      <section id="${id}" class="clip ttl" data-start="${fmt(t.at)}" data-duration="${fmt(t.duration)}" data-track-index="2" style="padding:${pad.top}px ${safeX}px ${pad.bottom}px">\n        <span class="lower" id="${id}-box" style="font-size:${r3(D.captions.font_size * scale * 0.72)}px">${esc(t.lines.join(" "))}</span>\n      </section>`,
      );
      tw.push(`tl.fromTo("#${id}-box", { opacity: 0, y: ${r3(24 * scale)} }, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" }, ${fmt(t.at)});`);
      if (t.duration > 0.8) tw.push(`tl.fromTo("#${id}-box", { opacity: 1 }, { opacity: 0, duration: 0.25, ease: "power1.in", immediateRender: false }, ${fmt(t.at + t.duration - 0.27)});`);
      return;
    }
    if (t.style === "callout") {
      // a small accent label over the action (highlights: "x3", "ЧИСТЫЙ"): pops in, fades out
      const pad = anchorPad(t.anchorY ?? CALLOUT_ANCHOR_Y, H);
      ttlHtml.push(
        `      <section id="${id}" class="clip ttl" data-start="${fmt(t.at)}" data-duration="${fmt(t.duration)}" data-track-index="2" style="padding:${pad.top}px ${safeX}px ${pad.bottom}px">\n        <span class="callout" id="${id}-box" style="font-size:${r3(Math.min(t.fontSize, D.titles.font_size * scale) * 0.6)}px">${esc(t.lines.join(" "))}</span>\n      </section>`,
      );
      tw.push(`tl.fromTo("#${id}-box", { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.28, ease: "back.out(2.2)" }, ${fmt(t.at)});`);
      if (t.duration > 0.7) tw.push(`tl.fromTo("#${id}-box", { opacity: 1 }, { opacity: 0, duration: 0.2, ease: "power1.in", immediateRender: false }, ${fmt(t.at + t.duration - 0.22)});`);
      return;
    }
    const card = t.style === "card";
    const lines = t.lines.map((l, li) => `          <span class="ttl-line" id="${id}-line${li}">${esc(l)}</span>`).join("\n");
    const tpad = t.anchorY !== undefined && Math.abs(t.anchorY - layout.titles.anchorY) > 1e-6 ? anchorPad(t.anchorY, H) : null;
    ttlHtml.push(
      `      <section id="${id}" class="clip ttl" data-start="${fmt(t.at)}" data-duration="${fmt(t.duration)}" data-track-index="2"${tpad ? ` style="padding:${tpad.top}px ${safeX}px ${tpad.bottom}px"` : ""}>\n        <span class="ttl-box${card ? " card" : ""}" id="${id}-box" style="font-size:${r3(t.fontSize)}px">\n${lines}\n        </span>\n      </section>`,
    );
    const sel = `#${id}-box`;
    if (D.titles.animation === "slide_up") tw.push(`tl.fromTo("${sel}", { opacity: 0, y: ${r3(90 * scale)} }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, ${fmt(t.at)});`);
    else if (D.titles.animation === "fade") tw.push(`tl.fromTo("${sel}", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power1.out" }, ${fmt(t.at)});`);
    // exit fade only when it fits inside the clip window (short titles just cut)
    const outAt = Math.max(t.at + 0.6, t.at + t.duration - 0.3);
    if (outAt + 0.24 <= t.at + t.duration) tw.push(`tl.fromTo("${sel}", { opacity: 1 }, { opacity: 0, duration: 0.24, ease: "power1.in", immediateRender: false }, ${fmt(outAt)});`);
  });

  // outro: a CTA card over the last seconds — the cut and its audio are untouched
  const outroHtml: string[] = [];
  const O = D.outro;
  if (O.enabled && DUR > O.duration + 1) {
    // balanced lines at a conservative size (0.62 em per character), shared with the layout's placement
    const ot = outroText(D, lang, W, H);
    if (ot) {
      const start = r3(DUR - O.duration);
      const { lines, fontSize } = ot;
      // stage 23: the CTA moves off a face like the captions do
      const opad = layout.outroAnchorY !== undefined ? anchorPad(layout.outroAnchorY, H) : null;
      outroHtml.push(
        `      <section id="outro" class="clip outro" data-start="${fmt(start)}" data-duration="${fmt(DUR - start)}" data-track-index="3"${opad ? ` style="padding:${opad.top}px ${safeX}px ${opad.bottom}px"` : ""}>\n        <span class="outro-backdrop" id="outro-backdrop"></span>\n        <span class="outro-text" id="outro-text" style="font-size:${fontSize}px">\n${lines.map((l, i) => `          <span class="outro-line" id="outro-line${i}">${esc(l)}</span>`).join("\n")}\n        </span>\n      </section>`,
      );
      tw.push(`tl.fromTo("#outro-backdrop", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power1.out" }, ${fmt(start)});`);
      tw.push(`tl.fromTo("#outro-text", { opacity: 0, y: ${r3(40 * scale)} }, { opacity: 1, y: 0, duration: 0.45, ease: "power3.out" }, ${fmt(start + 0.1)});`);
    }
  }

  // progress bar (reference style): a thin accent line along the top edge that fills over the whole video
  const progressHtml: string[] = [];
  if (D.overlays.progress_bar && DUR > 1) {
    progressHtml.push(`      <section id="progress" class="clip progress" data-start="0" data-duration="${DUR}" data-track-index="6"><span class="progress-fill" id="progress-fill"></span></section>`);
    tw.push(`tl.fromTo("#progress-fill", { width: "0%" }, { width: "100%", duration: ${DUR}, ease: "none" }, 0);`);
  }

  return `<!doctype html>
<html lang="${esc(lang)}" data-resolution="${W >= H ? "landscape" : "portrait"}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <!-- generated by vedit ${COMPOSE_VERSION} · job ${esc(job.job_id)} · output ${esc(job.timeline.output_id)} · preset ${esc(job.preset)} · ${layout.version} -->
    <script src="${assets.gsapRel}"></script>
    <style>
      @font-face {
        font-family: "${esc(layout.font.family)}";
        src: url("${assets.fontRel}") format("truetype");
        font-weight: 100 900;
        font-style: normal;
        font-display: block;
      }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; font-family: "${esc(layout.font.family)}", sans-serif; }
      ${split ? split.videoCss : "#a-roll { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }"}${split ? split.css : ""}${assets.extraFontFaces ? `\n      ${assets.extraFontFaces}` : ""}
      /* root-level timed clips are full-frame; content is centred on the anchor via padding (no transforms) */
      .cap, .ttl { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; }
      .cap { padding: ${capPad.top}px ${safeX}px ${capPad.bottom}px; }
      .ttl { padding: ${ttlPad.top}px ${safeX}px ${ttlPad.bottom}px; }
      .cap-line {
        display: ${D.captions.backing.enabled ? "inline-block" : "block"};
        white-space: nowrap;
        text-align: center;
        font-weight: ${layout.font.weight};
        line-height: ${D.captions.line_height};
        letter-spacing: -0.01em;
        color: ${C.text};${
          D.captions.backing.enabled
            ? `
        background: ${D.captions.backing.color};
        padding: ${r3(D.captions.backing.padding * scale)}px ${r3((D.captions.backing.padding + 8) * scale)}px;
        border-radius: ${r3(D.captions.backing.radius * scale)}px;
        margin: ${r3(3 * scale)}px 0;`
            : ""
        }
      }
      .shade { position: absolute; inset: 0; display: block; pointer-events: none; background: linear-gradient(to bottom, rgba(0,0,0,0) ${r3(D.captions.shade.from * 100)}%, rgba(0,0,0,${r3(D.captions.shade.strength)}) 100%); }
      .w {
        display: inline-block; /* transforms need a box; NO CSS transform here (GSAP owns scale) */
        margin: 0 calc(var(--gap) / 2);
        color: ${C.text};
        -webkit-text-stroke: ${r3(strokeVisible * 2)}px ${C.stroke};
        paint-order: stroke fill;
        text-shadow: 0 ${r3(3 * scale)}px ${r3(14 * scale)}px rgba(0, 0, 0, ${r3(D.captions.shadow_opacity)});
      }
      .ttl-box {
        display: block;
        text-align: center;
        font-weight: ${layout.font.weight};
        line-height: 1.08;
        letter-spacing: -0.015em;
        color: ${C.title};
        -webkit-text-stroke: ${r3(strokeVisible * 2)}px ${C.stroke};
        paint-order: stroke fill;
        text-shadow: 0 ${r3(3 * scale)}px ${r3(14 * scale)}px rgba(0, 0, 0, 0.55);
      }
      .ttl-box.card {
        padding: ${r3(D.titles.padding * scale)}px ${r3((D.titles.padding + 12) * scale)}px;
        border-radius: ${r3(D.titles.radius * scale)}px;
        background: ${C.title_bg};
        -webkit-text-stroke: 0;
        text-shadow: none;
      }
      .ttl-line { display: block; white-space: nowrap; }
      .lower { display: inline-block; max-width: 100%; padding: 0.28em 0.6em; border-radius: 0.4em; background: rgba(0,0,0,0.55); color: #fff; font-weight: 700; line-height: 1.2; text-align: center; white-space: normal; }
      .callout { display: inline-block; padding: 0.12em 0.42em 0.08em; border-radius: 0.18em; background: ${C.highlight}; color: #111; font-weight: 900; letter-spacing: 0.02em; white-space: nowrap; box-shadow: 0 ${r3(6 * scale)}px ${r3(24 * scale)}px rgba(0,0,0,0.35); }
      .outro { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; padding: 0 ${safeX}px; }
      .outro-backdrop { position: absolute; inset: 0; display: block; background: ${O.backdrop}; }
      .outro-text { position: relative; display: block; text-align: center; font-weight: ${layout.font.weight}; line-height: 1.1; letter-spacing: -0.01em; color: ${C.title}; -webkit-text-stroke: ${r3(strokeVisible * 2)}px ${C.stroke}; paint-order: stroke fill; text-shadow: 0 ${r3(3 * scale)}px ${r3(14 * scale)}px rgba(0, 0, 0, 0.55); }
      .outro-line { display: block; white-space: nowrap; }
      .progress { position: absolute; left: 0; top: 0; width: 100%; height: ${r3(Math.max(6, 10 * scale))}px; display: block; pointer-events: none; background: rgba(255,255,255,0.18); }
      .progress-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0%; display: block; background: ${C.highlight}; }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-width="${W}"
      data-height="${H}"
      data-duration="${DUR}"
      data-fps="${FPS}"
    >
      <video id="a-roll" src="${cutoutBox ? assets.cutoutRel!.plate : assets.videoRel}" data-start="0" data-duration="${DUR}" data-track-index="0" muted playsinline></video>${cutoutBox?.popHeight ? `\n      <video id="a-pop" src="${assets.cutoutRel!.pop}" data-start="0" data-duration="${DUR}" data-track-index="8" muted playsinline></video>` : ""}
${D.captions.shade.enabled && layout.pages.length ? `      <section id="shade" class="clip shade" data-start="0" data-duration="${DUR}" data-track-index="1"></section>\n` : ""}${capHtml.join("\n")}
${ttlHtml.join("\n")}${split ? `\n${split.sections.join("\n")}` : ""}
${outroHtml.join("\n")}${progressHtml.length ? `\n${progressHtml.join("\n")}` : ""}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${tw.join("\n      ")}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}
