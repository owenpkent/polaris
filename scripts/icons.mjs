// Generates the Polaris app icons as plain PNGs, with no dependencies
// beyond Node built-ins: shapes are rasterised by hand, rows are deflated
// with node:zlib, and PNG chunks (with their CRC32s) are written by hand.
// Edges are smoothed by rendering at 3x scale and box-downsampling.
//
// Run: node scripts/icons.mjs

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FACTOR = 3; // supersampling factor
const BG = [0x17, 0x19, 0x1e];
const STAR = [0x80, 0xbc, 0xff];
const LINE_HALF_BIG = FACTOR; // ~2 final px wide line

// Star field, as fractions of the icon size, laid out asymmetrically and
// kept inside the central 80% safe zone (0.1..0.9) for the maskable variant.
const STARS = [
  { x: 0.30, y: 0.24, r: 0.032 },
  { x: 0.56, y: 0.18, r: 0.030 },
  { x: 0.72, y: 0.40, r: 0.050 }, // the slightly bigger star
  { x: 0.46, y: 0.52, r: 0.030 },
  { x: 0.26, y: 0.68, r: 0.032 },
  { x: 0.60, y: 0.76, r: 0.030 },
];
const LINKS = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [1, 3]];

function insideRoundedRect(x, y, size, radius) {
  const nx = Math.min(Math.max(x, radius), size - radius);
  const ny = Math.min(Math.max(y, radius), size - radius);
  return Math.hypot(x - nx, y - ny) <= radius;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function renderBig(size, maskable) {
  const big = size * FACTOR;
  const radius = big * 0.22;
  const stars = STARS.map((s) => ({ x: s.x * big, y: s.y * big, r: s.r * big }));
  const px = new Uint8ClampedArray(big * big * 4);
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      if (!maskable && !insideRoundedRect(x + 0.5, y + 0.5, big, radius)) continue;
      const cx = x + 0.5, cy = y + 0.5;
      let color = BG;
      for (const [a, b] of LINKS) {
        if (distToSegment(cx, cy, stars[a].x, stars[a].y, stars[b].x, stars[b].y) <= LINE_HALF_BIG) { color = STAR; break; }
      }
      if (color === BG) {
        for (const s of stars) {
          if (Math.hypot(cx - s.x, cy - s.y) <= s.r) { color = STAR; break; }
        }
      }
      const i = (y * big + x) * 4;
      px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2]; px[i + 3] = 255;
    }
  }
  return { px, big };
}

// Box-downsample with premultiplied alpha, so transparent edges do not pick
// up a dark fringe from the background colour.
function downsample(px, big, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  const norm = FACTOR * FACTOR;
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let dy = 0; dy < FACTOR; dy++) {
        for (let dx = 0; dx < FACTOR; dx++) {
          const i = ((oy * FACTOR + dy) * big + (ox * FACTOR + dx)) * 4;
          const a = px[i + 3];
          sr += px[i] * a; sg += px[i + 1] * a; sb += px[i + 2] * a; sa += a;
        }
      }
      const oi = (oy * size + ox) * 4;
      if (sa > 0) {
        out[oi] = Math.round(sr / sa);
        out[oi + 1] = Math.round(sg / sa);
        out[oi + 2] = Math.round(sb / sa);
      }
      out[oi + 3] = Math.round(sa / norm);
    }
  }
  return out;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const base = y * (width * 4 + 1);
    raw[base] = 0; // filter: none
    for (let x = 0; x < width * 4; x++) raw[base + 1 + x] = rgba[y * width * 4 + x];
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function makeIcon(size, maskable) {
  const { px, big } = renderBig(size, maskable);
  return encodePng(size, size, downsample(px, big, size));
}

const outputs = [
  ['public/icons/icon-192.png', 192, false],
  ['public/icons/icon-512.png', 512, false],
  ['public/icons/maskable-512.png', 512, true],
  ['public/logo.png', 64, false],
];

mkdirSync(join(ROOT, 'public', 'icons'), { recursive: true });
for (const [path, size, maskable] of outputs) {
  const full = join(ROOT, path);
  writeFileSync(full, makeIcon(size, maskable));
  console.log(full);
}
