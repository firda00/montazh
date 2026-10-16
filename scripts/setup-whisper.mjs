#!/usr/bin/env node
// Downloads whisper.cpp binaries + the model into vendor/whisper (gitignored).
//   node scripts/setup-whisper.mjs            # large-v3-turbo q5_0 (574 MB), best quality/speed on CPU
//   node scripts/setup-whisper.mjs small      # ggml-small (488 MB), ~3x faster, worse on uz/ru
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "vendor", "whisper");
const RELEASE = "b5130"; // whisper.cpp pre-release with Windows x64 BLAS binaries
const MODELS = { turbo: "ggml-large-v3-turbo-q5_0.bin", small: "ggml-small.bin", medium: "ggml-medium-q5_0.bin" };
const model = MODELS[process.argv[2] ?? "turbo"];
if (!model) throw new Error(`unknown model, use one of: ${Object.keys(MODELS).join(", ")}`);

fs.mkdirSync(VENDOR, { recursive: true });

async function download(url, file) {
  if (fs.existsSync(file)) return console.log(`✔ ${path.basename(file)} already present`);
  console.log(`↓ ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const tmp = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, file);
  console.log(`✔ ${path.basename(file)} (${(fs.statSync(file).size / 1e6).toFixed(0)} MB)`);
}

await download(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model}`, path.join(VENDOR, model));

const bin = process.platform === "win32" ? path.join(VENDOR, "bin", "Release", "whisper-cli.exe") : path.join(VENDOR, "bin", "whisper-cli");
if (fs.existsSync(bin)) {
  console.log("✔ whisper-cli already present");
} else if (process.platform === "win32") {
  const zip = path.join(VENDOR, "whisper-blas-bin-x64.zip");
  await download(`https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}/whisper-blas-bin-x64.zip`, zip);
  execSync(`powershell -NoProfile -Command "Expand-Archive -Force '${zip}' '${path.join(VENDOR, "bin")}'"`, { stdio: "inherit" });
  fs.rmSync(zip);
  console.log(`✔ ${bin}`);
} else {
  console.log(`no prebuilt whisper-cli for ${process.platform}-${process.arch}: build it from source — bash deploy/build-whisper.sh (puts it at ${bin}), or set VEDIT_WHISPER_BIN`);
}

if (model !== MODELS.turbo) console.log(`\nset WHISPER_MODEL=${path.join(VENDOR, model)} in .env to use this model`);
