import { crc32, inflateRawSync } from "node:zlib";

/** Import limits (threat T-13). A package of a supported repository stays far below them. */
export interface ImportLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxFiles: 10_000,
  maxFileBytes: 128 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};

export type ImportRefusalCode = "PKG_NOT_FOUND" | "PKG_PATH_UNSAFE" | "PKG_TOO_LARGE";

/** A refusal before the package reaches the contract validator; `reason` never quotes file contents. */
export class ImportRefusal extends Error {
  override readonly name = "ImportRefusal";
  constructor(
    readonly code: ImportRefusalCode,
    readonly reason: string,
    readonly entry?: string,
  ) {
    super(reason);
  }
}

/**
 * Why a package-relative path is unsafe, or undefined when it is safe: it must be a relative, forward-slash path
 * without empty, `.` or `..` segments, drive letters, backslashes or control characters.
 */
export function unsafePathReason(name: string): string | undefined {
  if (name === "") return "empty path";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "control character in path";
  if (name.includes("\\")) return "backslash in path";
  if (name.startsWith("/")) return "absolute path";
  if (/^[A-Za-z]:/.test(name)) return "drive letter";
  const segments = name.split("/");
  if (segments.some((s) => s === "..")) return "`..` segment";
  if (segments.some((s) => s === "" || s === ".")) return "empty or `.` segment";
  return undefined;
}

/** Adds a file to the result, enforcing limits, path safety and case-insensitive uniqueness. */
export class FileCollector {
  readonly files = new Map<string, Uint8Array>();
  private readonly folded = new Set<string>();
  private total = 0;

  constructor(private readonly limits: ImportLimits) {}

  /** Checks a declared entry before its bytes are read. */
  admit(name: string, size: number): void {
    const unsafe = unsafePathReason(name);
    if (unsafe) throw new ImportRefusal("PKG_PATH_UNSAFE", unsafe, name);
    const key = name.toLowerCase();
    if (this.folded.has(key)) throw new ImportRefusal("PKG_PATH_UNSAFE", "duplicate or case-colliding name", name);
    this.folded.add(key);
    if (this.folded.size > this.limits.maxFiles)
      throw new ImportRefusal("PKG_TOO_LARGE", `more than ${this.limits.maxFiles} files`);
    if (size > this.limits.maxFileBytes)
      throw new ImportRefusal("PKG_TOO_LARGE", `a file larger than ${this.limits.maxFileBytes} bytes`, name);
    this.total += size;
    if (this.total > this.limits.maxTotalBytes)
      throw new ImportRefusal("PKG_TOO_LARGE", `more than ${this.limits.maxTotalBytes} bytes in total`);
  }

  put(name: string, bytes: Uint8Array): void {
    this.files.set(name, bytes);
  }
}

function unreadable(reason: string): never {
  throw new ImportRefusal("PKG_NOT_FOUND", `unreadable archive: ${reason}`);
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * Reads a ZIP archive into a path → bytes map without touching the filesystem (ST-13). Everything is checked before
 * any byte is inflated: entry count, declared sizes, names (zip-slip, absolute, drive, backslash, duplicates) and
 * symbolic links. Inflation is bounded by the declared size, and each entry's size and CRC-32 must match, so a
 * compression bomb or a lying header is refused. ZIP64, multi-disk, encrypted archives and methods other than stored
 * and deflate are unreadable.
 */
export function readZip(bytes: Uint8Array, limits: ImportLimits = DEFAULT_IMPORT_LIMITS): Map<string, Uint8Array> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (offset: number, length: number) => {
    if (offset < 0 || offset + length > buf.length) unreadable("truncated or corrupt");
  };

  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (buf.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  if (end < 0) unreadable("not a ZIP archive");
  const disk = buf.readUInt16LE(end + 4);
  const cdDisk = buf.readUInt16LE(end + 6);
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (disk !== 0 || cdDisk !== 0) unreadable("multi-disk archives are not supported");
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) unreadable("ZIP64 is not supported");
  if (count > limits.maxFiles) throw new ImportRefusal("PKG_TOO_LARGE", `more than ${limits.maxFiles} files`);
  need(cdOffset, cdSize);

  interface Entry {
    name: string;
    method: number;
    crc: number;
    compressed: number;
    size: number;
    localOffset: number;
  }
  const entries: Entry[] = [];
  const collector = new FileCollector(limits);
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    need(p, 46);
    if (buf.readUInt32LE(p) !== CENTRAL) unreadable("corrupt central directory");
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    need(p + 46, nameLength + extraLength + commentLength);
    const name = buf.toString(flags & 0x0800 ? "utf8" : "latin1", p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x0001) unreadable("encrypted entries are not supported");
    if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff)
      unreadable("ZIP64 is not supported");
    const unixMode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    if ((unixMode & S_IFMT) === S_IFLNK) throw new ImportRefusal("PKG_PATH_UNSAFE", "symbolic link", name);
    // Directory entries carry no data; their names are checked like files.
    if (name.endsWith("/")) {
      const unsafe = unsafePathReason(name.slice(0, -1));
      if (unsafe) throw new ImportRefusal("PKG_PATH_UNSAFE", unsafe, name);
      continue;
    }
    collector.admit(name, size);
    if (method !== 0 && method !== 8) unreadable(`compression method ${method} is not supported`);
    entries.push({ name, method, crc, compressed, size, localOffset });
  }

  for (const e of entries) {
    need(e.localOffset, 30);
    if (buf.readUInt32LE(e.localOffset) !== LOCAL) unreadable("corrupt local header");
    const start = e.localOffset + 30 + buf.readUInt16LE(e.localOffset + 26) + buf.readUInt16LE(e.localOffset + 28);
    need(start, e.compressed);
    const raw = buf.subarray(start, start + e.compressed);
    let data: Buffer;
    if (e.method === 0) data = Buffer.from(raw);
    else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) });
      } catch (error) {
        // More output than declared is a compression bomb or a lying header; anything else is corrupt data.
        if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
          throw new ImportRefusal("PKG_TOO_LARGE", "an entry inflates beyond its declared size", e.name);
        unreadable(`corrupt data in ${e.name}`);
      }
    }
    if (data.length !== e.size || crc32(data) !== e.crc) unreadable(`size or CRC mismatch in ${e.name}`);
    collector.put(e.name, new Uint8Array(data));
  }
  return collector.files;
}
