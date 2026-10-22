import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data?: Buffer;
  /** Overrides the uncompressed size recorded in the headers (oversized-package fixtures). */
  declaredSize?: number;
  /** Marks the entry as a Unix symbolic link whose target is `data`. */
  symlink?: boolean;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (deflate) for malicious-package fixtures (ST-13); entry names are written verbatim. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const compressed = deflateRawSync(data);
    const name = Buffer.from(e.name, "utf8");
    const size = e.declaredSize ?? data.length;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(Math.min(size, 0xffffffff), 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE((3 << 8) | 20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(data), 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(Math.min(size, 0xffffffff), 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(((e.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += header.length + name.length + compressed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

export interface ListedEntry {
  name: string;
  size: number;
  symlink: boolean;
}

/** Reads the central directory (enough to inspect fixtures; not a general unzip). */
export function listZip(buf: Buffer): ListedEntry[] {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: ListedEntry[] = [];
  for (let i = 0; i < count; i++) {
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    out.push({
      name: buf.subarray(p + 46, p + 46 + nameLength).toString("utf8"),
      size: buf.readUInt32LE(p + 24),
      symlink: (mode & 0o170000) === 0o120000,
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** Entries an importer must refuse (ST-13): traversal, absolute paths, drive letters, symlinks. */
export function unsafeEntries(entries: ListedEntry[]): string[] {
  return entries
    .filter(
      (e) =>
        e.symlink ||
        e.name.startsWith("/") ||
        e.name.startsWith("\\") ||
        /^[A-Za-z]:/.test(e.name) ||
        e.name.split(/[\\/]/).includes(".."),
    )
    .map((e) => e.name);
}

/** The malicious archive set for importer tests (IMP-201). */
export function maliciousArchives(): Record<string, Buffer> {
  const manifest = { name: "manifest.json", data: Buffer.from('{"contract":"sys2qa.package-manifest"}') };
  return {
    zip_slip: buildZip([manifest, { name: "../../outside.txt", data: Buffer.from("escaped") }]),
    absolute_path: buildZip([manifest, { name: "/etc/cron.d/evil", data: Buffer.from("* * * * * root true") }]),
    windows_drive: buildZip([manifest, { name: "C:\\Windows\\evil.dll", data: Buffer.from("x") }]),
    symlink: buildZip([manifest, { name: "docs/link", data: Buffer.from("/etc/passwd"), symlink: true }]),
    oversized: buildZip([
      manifest,
      { name: "system-model.json", data: Buffer.from("{}"), declaredSize: 4_000_000_000 },
    ]),
    entry_flood: buildZip([manifest, ...Array.from({ length: 20_000 }, (_, i) => ({ name: `docs/f${i}.md` }))]),
  };
}
