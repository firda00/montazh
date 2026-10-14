// Renders every art-director layout with one image: npx tsx tools/make-layouts-demo.ts <out_dir> <image.jpg>, then hyperframes snapshot <out_dir>
import path from "node:path";
import { writeDirectorProject } from "../src/make/index.ts";
import { DesignSchema } from "../src/make/design.ts";
import { ScriptSchema } from "../src/make/script.ts";

const out = process.argv[2];
const img = process.argv[3];
const script = ScriptSchema.parse({
  title: "Почему кофе дорожает",
  language: "ru",
  beats: [
    { text: "Арабика за год подорожала на 70 процентов", seconds: 3.5 },
    { text: "Кофе на бирже дешевеет, а в кофейне дорожает", seconds: 3.5 },
    { text: "Засуха в Бразилии срезала урожай", seconds: 3.5 },
    { text: "Обжарщики подняли цены вслед за биржей", seconds: 3.5 },
    { text: "Что входит в цену чашки", seconds: 4 },
    { text: "Почему так дорого?", seconds: 4 },
    { text: "Как менялась цена", seconds: 4 },
    { text: "Капсулы против зерна", seconds: 4 },
    { text: "Хороший кофе не бывает дешёвым", seconds: 3.5 },
    { text: "Сохрани и посчитай свои траты", seconds: 3.5 },
  ],
});
const design = DesignSchema.parse({
  identity: { palette: { bg: "#14100D", bg2: "#2A1D14", text: "#FFFFFF", accent: "#E8A36B", accent2: "#F6D2B0", muted: "#A79584" }, display_font: "inter", accent_font: "playfair-italic", kicker_font: "mono", texture: "grain", image_style: "cinematic", brand: "КОФЕ 2026" },
  scenes: [
    { beat: 0, layout: "hero_number", headline: "Арабика за год подорожала", number: { value: "+70%", unit: "за год" }, kicker: "биржа ICE · 2026", accents: [{ text: "подорожала", style: "serif" }], entrance: "mask" },
    { beat: 1, layout: "media_full", headline: "Кофе на бирже дешевеет, а в кофейне дорожает", accents: [{ text: "в кофейне дорожает", style: "marker" }], image: { prompt: "x", motion: "zoom_in" }, entrance: "rise" },
    { beat: 2, layout: "media_card", headline: "Засуха в Бразилии срезала урожай", accents: [{ text: "Бразилии", style: "gradient" }], image: { prompt: "x", motion: "pan_left" }, entrance: "pop" },
    { beat: 3, layout: "media_split", headline: "Обжарщики подняли цены вслед за биржей", kicker: "поставщики", accents: [{ text: "вслед за биржей", style: "serif" }], image: { prompt: "x", motion: "zoom_out" }, entrance: "slide" },
    { beat: 4, layout: "list", headline: "Что входит в цену чашки", kicker: "из чего 400 ₽", items: ["Аренда и зарплаты", "Молоко и стакан", "Зерно — 10–15%"], entrance: "rise" },
    { beat: 5, layout: "chat", headline: "Почему так дорого?", items: ["Почему капучино уже 450?", "Аренда выросла на треть", "А зерно?", "Зерно — меньше всего"], accents: [{ text: "дорого", style: "color" }], entrance: "type" },
    { beat: 6, layout: "timeline", headline: "Как менялась цена чашки", items: ["2022", "2023", "2024", "2025", "2026"], accents: [{ text: "цена", style: "marker" }], entrance: "mask" },
    { beat: 7, layout: "compare", headline: "Капсулы против зерна", items: ["Капсула", "45 ₽", "Зерно", "18 ₽"], accents: [{ text: "зерна", style: "serif" }], entrance: "rise" },
    { beat: 8, layout: "quote", headline: "Хороший кофе не бывает дешёвым", sub: "бариста, Ташкент", entrance: "rise" },
    { beat: 9, layout: "headline", headline: "Сохрани и посчитай свои траты на кофе", kicker: "сделай сегодня", accents: [{ text: "посчитай", style: "marker" }], entrance: "mask" },
  ],
});
const r = await writeDirectorProject(script, design, { 1: img, 2: img, 3: img }, out);
console.log(JSON.stringify({ duration: r.duration, overflow: r.overflow, timings: r.timings.map((t) => +(t.start + t.duration * 0.75).toFixed(2)) }));
