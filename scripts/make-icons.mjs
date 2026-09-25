/**
 * Generates the Shelf icons (a dark rounded square with three shelf bars).
 * No image libraries: raw RGBA -> PNG via zlib. Run: npm run icons
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "ui", "public", "icons");
mkdirSync(outDir, { recursive: true });

const INK = [17, 17, 17];
const PAPER = [242, 242, 242];
const MID = [154, 154, 154];

function render(size) {
  const scale = 3;
  const big = size * scale;
  const pixels = new Uint8Array(size * size * 4);

  // Rounded square background.
  const radius = big * 0.22;
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const inside = insideRoundedRect(x, y, big, big, radius);
      if (!inside) continue;
      setBig(x, y, INK, 1);
    }
  }

  // Three "books" standing on a shelf line.
  const shapes = [
    { x0: 0.285, y0: 0.42, x1: 0.385, y1: 0.7, color: PAPER, radius: 0.018 },
    { x0: 0.425, y0: 0.3, x1: 0.525, y1: 0.7, color: MID, radius: 0.018 },
    { x0: 0.565, y0: 0.48, x1: 0.665, y1: 0.7, color: PAPER, radius: 0.018 },
    { x0: 0.24, y0: 0.7, x1: 0.76, y1: 0.765, color: PAPER, radius: 0.03 },
  ];

  for (const shape of shapes) {
    const x0 = big * shape.x0;
    const y0 = big * shape.y0;
    const x1 = big * shape.x1;
    const y1 = big * shape.y1;
    const r = big * shape.radius;
    for (let y = Math.floor(y0 - 1); y < Math.ceil(y1 + 1); y++) {
      for (let x = Math.floor(x0 - 1); x < Math.ceil(x1 + 1); x++) {
        const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
        const cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
        if (distance(x + 0.5, y + 0.5, cx, cy) <= r) setBig(x, y, shape.color, 1);
      }
    }
  }

  // Downsample with a box filter for anti-aliasing.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const index = ((y * scale + sy) * big + (x * scale + sx)) * 4;
          const alpha = bigAlpha[index + 3] / 255;
          r += bigRgba[index] * alpha;
          g += bigRgba[index + 1] * alpha;
          b += bigRgba[index + 2] * alpha;
          a += alpha;
        }
      }
      const target = (y * size + x) * 4;
      if (a > 0) {
        pixels[target] = Math.round(r / a);
        pixels[target + 1] = Math.round(g / a);
        pixels[target + 2] = Math.round(b / a);
        pixels[target + 3] = Math.round((a / (scale * scale)) * 255);
      }
    }
  }

  return pixels;

  function insideRoundedRect(x, y, width, height, r) {
    const cx = Math.min(Math.max(x + 0.5, r), width - r);
    const cy = Math.min(Math.max(y + 0.5, r), height - r);
    return distance(x + 0.5, y + 0.5, cx, cy) <= r;
  }

  function distance(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
  }

  function setBig(x, y, color, alpha) {
    if (x < 0 || y < 0 || x >= big || y >= big) return;
    const index = (y * big + x) * 4;
    bigRgba[index] = color[0];
    bigRgba[index + 1] = color[1];
    bigRgba[index + 2] = color[2];
    bigAlpha[index + 3] = Math.round(alpha * 255);
  }
}

const bigRgba = new Uint8Array(4096 * 4096 * 4);
const bigAlpha = bigRgba;

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.subarray(y * size * 4, (y + 1) * size * 4).forEach((value, index) => {
      raw[y * (size * 4 + 1) + 1 + index] = value;
    });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const targets = [
  { file: join(outDir, "icon-192.png"), size: 192 },
  { file: join(outDir, "icon-512.png"), size: 512 },
  { file: join(outDir, "icon-maskable-512.png"), size: 512 },
  { file: join(outDir, "icon-1024.png"), size: 1024 },
];

for (const target of targets) {
  writeFileSync(target.file, encodePng(target.size, render(target.size)));
  console.log(`wrote ${target.file.replace(`${root}/`, "")}`);
}
