import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DesignJob } from "../export.ts";
import type { Layout } from "../layout-types.ts";
import { composeHyperframes } from "./compose.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const HF_VERSION = "0.8.145";
export const HF_BIN = path.join(ROOT, "node_modules", "hyperframes", "bin", "hyperframes.mjs");
export const DEFAULT_GSAP = path.join(ROOT, "vendor", "gsap", "gsap.min.js");

/** Hardlink when possible (same volume, no copy of an 8–40 MB rough cut), copy otherwise. */
export async function linkOrCopy(src: string, dest: string) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { force: true });
  try {
    await fs.link(src, dest);
  } catch {
    await fs.copyFile(src, dest);
  }
}

export interface ProjectResult {
  entry: string;
  html: string;
  videoRel: string;
}

/** Writes a complete, self-contained HyperFrames project (what `hyperframes init` would, minus the network). */
export async function writeHyperframesProject(job: DesignJob, layout: Layout, dir: string, opts: { fontFile: string; gsapFile?: string } = { fontFile: "" }): Promise<ProjectResult> {
  await fs.mkdir(path.join(dir, "assets", "fonts"), { recursive: true });
  const videoRel = `assets/${path.basename(job.rough_path)}`;
  await linkOrCopy(job.rough_path, path.join(dir, videoRel));
  const fontRel = `assets/fonts/${path.basename(opts.fontFile)}`;
  await linkOrCopy(opts.fontFile, path.join(dir, fontRel));
  const ofl = path.join(path.dirname(opts.fontFile), "OFL-Inter.txt");
  try {
    await linkOrCopy(ofl, path.join(dir, "assets", "fonts", "OFL-Inter.txt"));
  } catch {
    /* licence file optional */
  }
  const gsapFile = opts.gsapFile ?? DEFAULT_GSAP;
  await linkOrCopy(gsapFile, path.join(dir, "assets", "gsap.min.js"));
  try {
    await linkOrCopy(path.join(path.dirname(gsapFile), "LICENSE"), path.join(dir, "assets", "gsap-LICENSE"));
  } catch {
    /* optional */
  }

  let panelRel: Record<number, string> | undefined;
  let cutoutRel: { plate: string; pop?: string } | undefined;
  let extraFontFaces: string | undefined;
  if (job.design.layout === "split") {
    panelRel = {};
    for (const [i, f] of Object.entries(job.panel_images ?? {})) {
      const rel = `assets/panels/${path.basename(f)}`;
      await linkOrCopy(f, path.join(dir, rel));
      panelRel[Number(i)] = rel;
    }
    if (job.cutout) {
      cutoutRel = { plate: `assets/${path.basename(job.cutout.plate)}` };
      await linkOrCopy(job.cutout.plate, path.join(dir, cutoutRel.plate));
      if (job.cutout.pop) {
        cutoutRel.pop = `assets/${path.basename(job.cutout.pop)}`;
        await linkOrCopy(job.cutout.pop, path.join(dir, cutoutRel.pop));
      }
    }
    const { installFonts } = await import("../../make/fonts.ts");
    extraFontFaces = await installFonts(dir, ["playfair-italic", "mono"]);
  }
  const html = composeHyperframes(job, layout, { videoRel, fontRel, gsapRel: "assets/gsap.min.js", panelRel, extraFontFaces, cutoutRel });
  const entry = path.join(dir, "index.html");
  await fs.writeFile(entry, html);
  const name = `${job.job_id}-${job.timeline.output_id}`;
  await fs.writeFile(
    path.join(dir, "hyperframes.json"),
    JSON.stringify(
      {
        $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
        registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
        paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
        media: { autoProxy: true },
      },
      null,
      2,
    ) + "\n",
  );
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name, private: true, type: "module", scripts: { check: `npx --yes hyperframes@${HF_VERSION} check`, render: `npx --yes hyperframes@${HF_VERSION} render` } }, null, 2) + "\n",
  );
  // deterministic metadata: no timestamps, so the project hashes the same for the same inputs
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ id: name, name, createdAt: "1970-01-01T00:00:00.000Z" }, null, 2) + "\n");
  await fs.writeFile(path.join(dir, "layout.json"), JSON.stringify(layout, null, 1));
  await fs.writeFile(path.join(dir, "design.json"), JSON.stringify(job, null, 1));
  return { entry, html, videoRel };
}
