/**
 * Generates every Shelf icon from one source: `ui/public/logo.svg`.
 *
 * The mark on its own is dark ink on transparent, which disappears on a dark
 * Dock, so the app icons put it on the usual rounded square: paper books on a
 * dark tile. `tauri icon` rasterises the composed SVG into the macOS/Windows
 * bundle set (including icon.icns), and `sips` makes the PWA sizes from the
 * 1024 px render.
 *
 * Run: npm run icons   (macOS, for sips)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logo = readFileSync(join(root, "ui", "public", "logo.svg"), "utf8");

/** Palette shared with the SVG: ink tile, paper marks, one gray book. */
const TILE = "#111111";
const INK = "#202020";
const PAPER = "#F2F2F2";

/** Corner radius as a share of the tile, matching macOS icon geometry. */
const RADIUS = 28;

/** `ui/public/logo.svg` is 128 wide, and its mark runs from 24..108 by 22..100. */
const MARK_CENTER = { x: 66, y: 61 };

const work = mkdtempSync(join(tmpdir(), "shelf-icons-"));
try {
  const appIcon = compose({ radius: RADIUS, scale: 1 });
  const maskable = compose({ radius: 0, scale: 0.82 });

  const appIconSvg = join(work, "icon.svg");
  const maskableSvg = join(work, "icon-maskable.svg");
  writeFileSync(appIconSvg, appIcon);
  writeFileSync(maskableSvg, maskable);

  // The bundle icon set: 32/64/128/256/512 PNGs plus icon.icns and icon.ico.
  tauriIcon(appIconSvg, join(root, "desktop", "src-tauri", "icons"));
  // Shelf ships as a desktop app, so drop the mobile sets `tauri icon` leaves behind.
  const iconsDir = join(root, "desktop", "src-tauri", "icons");
  for (const platform of ["android", "ios"]) {
    rmSync(join(iconsDir, platform), { recursive: true, force: true });
  }
  const maskableDir = join(work, "maskable");
  tauriIcon(maskableSvg, maskableDir);

  // PWA icons come from the 1024 px renders.
  const outDir = join(root, "ui", "public", "icons");
  for (const [source, size, name] of [
    [join(iconsDir, "icon.png"), 192, "icon-192.png"],
    [join(iconsDir, "icon.png"), 512, "icon-512.png"],
    [join(iconsDir, "icon.png"), 1024, "icon-1024.png"],
    [join(maskableDir, "icon.png"), 512, "icon-maskable-512.png"],
  ]) {
    const target = join(outDir, name);
    sips(source, size, target);
    console.log(`wrote ${target.replace(`${root}/`, "")}`);
  }
  console.log(`wrote desktop/src-tauri/icons/ (icon.icns, icon.ico, PNG set)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

/**
 * Builds the app tile around the logo's own paths: ink marks become paper (so
 * they read on a dark tile), and a mark that names its own fill keeps it.
 */
function compose({ radius, scale }) {
  const paths = [...logo.matchAll(/<path\b([^>]*)\/?>/g)].map(([, attributes]) => {
    const d = /\bd="([^"]+)"/.exec(attributes)?.[1];
    if (!d) throw new Error("logo.svg has a <path> without a d attribute");
    const fill = /\bfill="([^"]+)"/.exec(attributes)?.[1] ?? INK;
    return { d, fill: fill.toLowerCase() === INK ? PAPER : fill };
  });
  if (paths.length === 0) throw new Error("no paths found in ui/public/logo.svg");

  // Centre the mark in the tile, then optionally shrink it for the maskable
  // icon, whose outer ring gets cropped by the platform.
  const mark = `translate(64 64) scale(${scale}) translate(${-MARK_CENTER.x} ${-MARK_CENTER.y})`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="1024" height="1024">
  <rect width="128" height="128" rx="${radius}" fill="${TILE}"/>
  <g transform="${mark}">
${paths.map(({ d, fill }) => `    <path d="${d}" fill="${fill}"/>`).join("\n")}
  </g>
</svg>
`;
}

function tauriIcon(source, output) {
  execFileSync(
    "npx",
    ["tauri", "icon", source, "--output", output],
    { cwd: join(root, "desktop"), stdio: "inherit" },
  );
}

function sips(source, size, target) {
  execFileSync("sips", ["-z", String(size), String(size), source, "--out", target], {
    stdio: "ignore",
  });
}
