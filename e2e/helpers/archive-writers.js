import zlib from "node:zlib";

// Minimal stored-only ZIP and ustar writers for hostile fixtures. 7-Zip's CLI
// will not create `..`, absolute, or escaping-link member names, so these
// build the raw container bytes directly. Callers verify the result with the
// bundled sidecar listing before using it as a test input.

const DOS_DATE_1980 = 0x21;
const UNIX_FILE_MODE = 0o100644;
const UNIX_SYMLINK_MODE = 0o120777;

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return buf;
}

/**
 * entries: [{ name, data?: string|Buffer, symlinkTarget?: string }].
 * Symlink entries store their target as the content and set the Unix
 * symlink mode in the external attributes, which 7-Zip reports as
 * `Symbolic Link =`.
 */
export function buildStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const isLink = typeof entry.symlinkTarget === "string";
    const data = isLink
      ? Buffer.from(entry.symlinkTarget, "utf8")
      : Buffer.from(entry.data ?? "", "utf8");
    const crc = zlib.crc32(data);
    const mode = isLink ? UNIX_SYMLINK_MODE : UNIX_FILE_MODE;
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(DOS_DATE_1980),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16((3 << 8) | 20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(DOS_DATE_1980),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32((mode << 16) >>> 0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDirectory.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralDirectory, end]);
}

function tarHeader({ name, size = 0, typeflag = "0", linkname = "" }) {
  const header = Buffer.alloc(512, 0);
  const put = (text, start, length) => {
    Buffer.from(text, "utf8").copy(header, start, 0, length);
  };
  put(name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  put("00000000000\0", 136, 12);
  put("        ", 148, 8);
  put(typeflag, 156, 1);
  put(linkname, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

/**
 * entries: [{ name, typeflag?: "0" | "1" | "2", data?: string, linkname?: string }].
 * typeflag "1" is a hard link to `linkname`, which may be absolute or escaping.
 */
export function buildUstarTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "", "utf8");
    parts.push(
      tarHeader({
        name: entry.name,
        size:
          entry.typeflag === "1" || entry.typeflag === "2" ? 0 : data.length,
        typeflag: entry.typeflag ?? "0",
        linkname: entry.linkname ?? "",
      }),
    );
    if ((entry.typeflag ?? "0") === "0" && data.length > 0) {
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad > 0) parts.push(Buffer.alloc(pad, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}
