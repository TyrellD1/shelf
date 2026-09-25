import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/shelf.cjs",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  minify: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
  define: { SHELF_VERSION: JSON.stringify(pkg.version) },
  logLevel: "info",
});

console.log(`built dist/shelf.cjs (v${pkg.version})`);
