// Measures where the macOS traffic lights sit inside a window screenshot.
// Usage: node scripts/measure-topbar.mjs <png> [--scale 2]
// Prints the dot band's pixel rows and the equivalent CSS-pixel centre.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const [, , file, ...rest] = process.argv;
const scaleIndex = rest.indexOf("--scale");
const scale = scaleIndex === -1 ? 2 : Number(rest[scaleIndex + 1]);
// Search window in CSS pixels: the top-left corner where the traffic lights live.
const regionIndex = rest.indexOf("--region");
const [regionX, regionY, regionW, regionH] =
  regionIndex === -1 ? [0, 0, 220, 70] : rest[regionIndex + 1].split(",").map(Number);

const buffer = readFileSync(file);
let offset = 8;
let width = 0;
let height = 0;
const idat = [];
while (offset < buffer.length) {
  const length = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);
  const data = buffer.subarray(offset + 8, offset + 8 + length);
  if (type === "IHDR") {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    if (data[8] !== 8 || data[9] !== 6) throw new Error("expected 8-bit RGBA");
  } else if (type === "IDAT") {
    idat.push(data);
  } else if (type === "IEND") {
    break;
  }
  offset += length + 12;
}

const raw = inflateSync(Buffer.concat(idat));
const stride = width * 4;
const pixels = Buffer.alloc(stride * height);
for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)];
  const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  const previous = y === 0 ? Buffer.alloc(stride) : pixels.subarray((y - 1) * stride, y * stride);
  const target = pixels.subarray(y * stride, (y + 1) * stride);
  for (let x = 0; x < stride; x++) {
    const left = x >= 4 ? target[x - 4] : 0;
    const up = previous[x];
    const upLeft = x >= 4 ? previous[x - 4] : 0;
    let value = line[x];
    if (filter === 1) value += left;
    else if (filter === 2) value += up;
    else if (filter === 3) value += (left + up) >> 1;
    else if (filter === 4) {
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
    }
    target[x] = value & 0xff;
  }
}

// The region's background is its most common colour.
const tally = new Map();
for (let y = Math.round(regionY * scale); y < Math.min(height, Math.round((regionY + regionH) * scale)); y++) {
  for (let x = Math.round(regionX * scale); x < Math.min(width, Math.round((regionX + regionW) * scale)); x++) {
    const i = y * stride + x * 4;
    const key = `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
}
const bg = (tally.size ? [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0] : "0,0,0")
  .split(",")
  .map(Number);

// Traffic lights are the only saturated pixels in a grayscale UI.
let minY = height;
let maxY = -1;
let minX = width;
let maxX = -1;
let count = 0;
const yStart = Math.round(regionY * scale);
const yEnd = Math.min(height, Math.round((regionY + regionH) * scale));
const xStart = Math.round(regionX * scale);
const xEnd = Math.min(width, Math.round((regionX + regionW) * scale));
for (let y = yStart; y < yEnd; y++) {
  for (let x = xStart; x < xEnd; x++) {
    const i = y * stride + x * 4;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min > 80 && max > 90) {
      count++;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
}

if (count === 0 && !rest.includes("--ink")) {
  console.log("no traffic lights found");
  process.exit(1);
}

// Ink mode: any pixel differing from the region's background colour, which
// finds control borders and text instead of the coloured traffic lights.
if (rest.includes("--ink")) {
  let inkMinY = height;
  let inkMaxY = -1;
  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const i = y * stride + x * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      if (Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2])) > 8) {
        if (y < inkMinY) inkMinY = y;
        if (y > inkMaxY) inkMaxY = y;
      }
    }
  }
  if (inkMaxY === -1) {
    console.log(JSON.stringify({ file, region: [regionX, regionY, regionW, regionH], ink: "none" }, null, 2));
  } else {
    console.log(
      JSON.stringify(
        {
          file,
          region: [regionX, regionY, regionW, regionH],
          inkBandPx: [inkMinY, inkMaxY],
          inkCenterCssPx: Number(((inkMinY + inkMaxY) / 2 / scale).toFixed(1)),
          inkHeightCssPx: Number(((inkMaxY - inkMinY + 1) / scale).toFixed(1)),
        },
        null,
        2,
      ),
    );
  }
  process.exit(0);
}

console.log(
  JSON.stringify(
    {
      file,
      imageSize: `${width}x${height}`,
      scale,
      dotBandPx: [minY, maxY],
      dotXRangePx: [minX, maxX],
      dotCenterCssPx: Number(((minY + maxY) / 2 / scale).toFixed(1)),
      dotHeightCssPx: Number(((maxY - minY + 1) / scale).toFixed(1)),
      dotLeftCssPx: Number((minX / scale).toFixed(1)),
    },
    null,
    2,
  ),
);
