// Turns the one square PNG into the icon files the other platforms need.
//
// The Mac build resizes with `sips` and packs with `iconutil`; Windows wants
// an .ico, Linux wants one PNG per size. Neither `sips` nor `iconutil` exists
// off the Mac, and the icon is the same one picture everywhere -- so it is
// decoded and resized here, with no image dependency (D-074).
//
// 1024 RGBA, 8-bit, non-interlaced is all the decoder accepts: that is what
// build/icon.png is, and a build tool that silently mis-reads a different file
// would be worse than one that stops.

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @typedef {{ width: number, height: number, data: Buffer }} Bitmap
 *   RGBA, 4 bytes per pixel, row-major.
 */

/** Decodes build/icon.png: RGBA only, no interlace. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG 文件');
  let at = 8;
  /** @type {Buffer | null} */
  let header = null;
  /** @type {Buffer[]} */
  const idat = [];
  for (;;) {
    if (at + 8 > buf.length) throw new Error('PNG 提前结束');
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') header = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (header === null) throw new Error('PNG 没有 IHDR');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  if (header[8] !== 8) throw new Error(`只支持 8 位深度，实际是 ${String(header[8])}`);
  if (header[9] !== 6) throw new Error(`只支持 RGBA（颜色类型 6），实际是 ${String(header[9])}`);
  if (header[12] !== 0) throw new Error('不支持隔行扫描的 PNG');
  return { width, height, data: unfilter(inflateSync(Buffer.concat(idat)), width, height) };
}

/**
 * PNG's per-scanline filters, undone. Each row is prefixed by its filter byte.
 *
 * @param {Buffer} raw
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function unfilter(raw, width, height) {
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev === null ? 0 : prev[x];
      const c = prev !== null && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`未知的 PNG 行过滤器 ${String(filter)}`);
      cur[x] = v & 0xff;
    }
  }
  return out;
}

/**
 * Encodes RGBA as a PNG: one IDAT, filter 0, deflate at level 9.
 *
 * @param {Bitmap} bmp
 * @returns {Buffer}
 */
export function encodePng(bmp) {
  const stride = bmp.width * 4;
  const raw = Buffer.alloc((stride + 1) * bmp.height);
  for (let y = 0; y < bmp.height; y++) {
    raw[y * (stride + 1)] = 0;
    bmp.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(bmp.width, 0);
  ihdr.writeUInt32BE(bmp.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  /**
   * @param {string} type
   * @param {Buffer} body
   * @returns {Buffer}
   */
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Box-filter downscale: averages every source pixel inside each output pixel.
 *
 * @param {Bitmap} src
 * @param {number} size
 * @returns {Bitmap}
 */
export function resize(src, size) {
  if (size === src.width && size === src.height) return src;
  if (size > src.width || size > src.height) throw new Error('只做缩小，不做放大');
  const out = Buffer.alloc(size * size * 4);
  const stepX = src.width / size;
  const stepY = src.height / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * stepY);
    const y1 = Math.min(src.height, Math.max(y0 + 1, Math.ceil((y + 1) * stepY)));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * stepX);
      const x1 = Math.min(src.width, Math.max(x0 + 1, Math.ceil((x + 1) * stepX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: size, height: size, data: out };
}

/**
 * An .ico holding PNG-encoded entries, which Windows Vista and later read
 * directly -- so the entries are the same images, not BMPs.
 *
 * @param {readonly number[]} sizes
 * @param {Bitmap} src
 * @returns {Buffer}
 */
export function encodeIco(sizes, src) {
  const images = sizes.map((s) => encodePng(resize(src, s)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let at = 6 + images.length * 16;
  const entries = [];
  images.forEach((img, i) => {
    const size = sizes[i] ?? 0;
    const e = Buffer.alloc(16);
    // 256 is stored as 0: the field is one byte wide.
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // palette colours
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(img.length, 8);
    e.writeUInt32LE(at, 12);
    at += img.length;
    entries.push(e);
  });
  return Buffer.concat([header, ...entries, ...images]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
