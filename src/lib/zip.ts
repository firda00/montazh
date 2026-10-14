import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Minimal ZIP (PKWARE APPNOTE 2.0: stored/deflated entries, UTF-8 names, no ZIP64) — enough for the
 * bundles that travel to and from Colab (avatar_job.zip, avatar_result.zip, each well under 4 GB).
 * Pure Node, so it behaves the same on Windows, macOS and Linux and needs no zip/tar on PATH.
 */

export interface ZipInput {
  /** name inside the archive (forward slashes) */
  name: string;
  /** source file on disk… */
  file?: string;
  /** …or the content itself */
  data?: Buffer | string;
  /** store without compression (already-compressed media) */
  store?: boolean;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function checkName(name: string): string {
  const n = name.replace(/\\/g, "/");
  if (!n || n.startsWith("/") || /^[a-zA-Z]:/.test(n) || n.split("/").includes("..")) throw new Error(`zip: недопустимое имя файла «${name}»`);
  return n;
}

export async function writeZip(dest: string, entries: ZipInput[]): Promise<{ bytes: number; names: string[] }> {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  const names: string[] = [];
  for (const e of entries) {
    const name = checkName(e.name);
    if (names.includes(name)) throw new Error(`zip: повтор имени «${name}»`);
    names.push(name);
    const raw = e.data !== undefined ? (typeof e.data === "string" ? Buffer.from(e.data, "utf8") : e.data) : await fs.readFile(e.file!);
    const method = e.store ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(raw, { level: 6 }) : raw;
    const crc = zlib.crc32(raw) >>> 0;
    const nameBuf = Buffer.from(name, "utf8");
    if (raw.length >= 0xffffffff || offset >= 0xffffffff) throw new Error("zip: файл больше 4 ГБ (ZIP64 не поддержан)");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    chunks.push(local, nameBuf, body);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...chunks, cdBuf, end]);
  await fs.mkdir(path.dirname(path.resolve(dest)), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await fs.writeFile(tmp, all);
  await fs.rename(tmp, dest);
  return { bytes: all.length, names };
}

/** All entries of a zip (directories skipped), checked against their CRC. Archives here are tens of MB at most. */
export async function readZip(file: string): Promise<Map<string, Buffer>> {
  const buf = await fs.readFile(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${path.basename(file)}: это не zip-архив (нет оглавления)`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error(`${path.basename(file)}: ZIP64 не поддержан`);
  const out = new Map<string, Buffer>();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${path.basename(file)}: повреждённое оглавление zip`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString(flags & 0x0800 ? "utf8" : "latin1");
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    checkName(name);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${path.basename(file)}: повреждён заголовок «${name}»`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = zlib.inflateRawSync(body);
    else throw new Error(`${path.basename(file)}: «${name}» сжат методом ${method} (поддержаны store и deflate)`);
    if (data.length !== usize || (zlib.crc32(data) >>> 0) !== crc) throw new Error(`${path.basename(file)}: «${name}» повреждён (CRC)`);
    out.set(name, data);
  }
  return out;
}

/** Extracts every entry under `into`; returns the written paths. A single top-level folder is kept as is. */
export async function extractZip(file: string, into: string): Promise<string[]> {
  const entries = await readZip(file);
  const written: string[] = [];
  for (const [name, data] of entries) {
    const dest = path.join(into, ...name.split("/"));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
    written.push(dest);
  }
  return written;
}
