// Generates the PWA PNG icons with Node built-ins only (no image libraries).
// Run: npm run icons -w @gmemo/web
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [25, 25, 25];
const PAGE = [255, 255, 255];
const LINE = [201, 199, 194];
const AI = [217, 115, 13];

/** Signed distance to a rounded rectangle (center cx,cy, half size hw,hh, radius r). */
function roundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - hw + r;
  const dy = Math.abs(y - cy) - hh + r;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
}
const cov = (d) => Math.max(0, Math.min(1, 0.5 - d));
const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));

/** content scale: 1 = normal icon, smaller for the maskable safe zone. */
function draw(scale, rounded) {
  return (x, y, size) => {
    const u = (x / size - 0.5) / scale + 0.5;
    const v = (y / size - 0.5) / scale + 0.5;
    const px = 1 / (size * scale);
    let color = BG;
    let alpha = 1;
    if (rounded) alpha = cov(roundRect(x / size, y / size, 0.5, 0.5, 0.5, 0.5, 0.22) / (1 / size));
    // page
    const page = cov(roundRect(u, v, 0.5, 0.52, 0.26, 0.32, 0.05) / px);
    color = mix(color, PAGE, page);
    // text lines
    for (const [ly, len] of [
      [0.36, 0.3],
      [0.46, 0.36],
      [0.56, 0.24],
    ]) {
      const l = cov(roundRect(u, v, 0.32 + len / 2, ly, len / 2, 0.022, 0.022) / px);
      color = mix(color, LINE, l * page);
    }
    // AI-written paragraph marker + line
    const bar = cov(roundRect(u, v, 0.33, 0.7, 0.012, 0.06, 0.012) / px);
    color = mix(color, AI, bar * page);
    const aline = cov(roundRect(u, v, 0.37 + 0.14, 0.7, 0.14, 0.022, 0.022) / px);
    color = mix(color, LINE, aline * page);
    return [...color, Math.round(alpha * 255)];
  };
}

writeFileSync(join(out, 'icon-192.png'), png(192, draw(1, true)));
writeFileSync(join(out, 'icon-512.png'), png(512, draw(1, true)));
writeFileSync(join(out, 'maskable-512.png'), png(512, draw(0.78, false)));
writeFileSync(join(out, 'apple-touch-icon.png'), png(180, draw(0.86, false)));
console.log('icons written to', out);
