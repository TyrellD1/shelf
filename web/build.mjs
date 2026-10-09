import { build } from "esbuild";

// The Vercel function, as one self-contained file. `api/index.mjs` re-exports it.
await build({
  entryPoints: ["src/vercel.ts"],
  outfile: "dist/vercel.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: false,
  sourcemap: false,
  // `pg` is CommonJS and loads its native binding lazily; neither exists in an ES bundle.
  external: ["pg-native"],
  banner: {
    js: 'import { createRequire as __shelfCreateRequire } from "node:module";\nconst require = __shelfCreateRequire(import.meta.url);',
  },
  logLevel: "info",
});
