// `npx tsx src/bot/guide-render.ts [ru|uz|en …]` → docs/guide-<lang>.png (the cheat sheet the bot sends on «🖼 Шпаргалка»).
import path from "node:path";
import { GUIDE_DIR, guideImageName, renderGuideImage } from "./guide.ts";
import { STRINGS } from "./i18n.ts";
import type { Lang } from "./db.ts";

const langs = (process.argv.slice(2).filter((a) => a === "ru" || a === "uz" || a === "en") as Lang[]).length ? (process.argv.slice(2) as Lang[]) : (["ru", "uz", "en"] as Lang[]);
for (const lang of langs) {
  const out = path.join(GUIDE_DIR, guideImageName(lang));
  await renderGuideImage(STRINGS[lang], out);
  console.log(`→ ${out}`);
}
