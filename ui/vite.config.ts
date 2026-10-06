import { defineConfig } from "vite";

// One build serves both hosts: the web server (https, PWA) and the Tauri app
// (tauri://localhost, local-first). The runtime picks the data adapter.
export default defineConfig({
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "safari16",
    modulePreload: { polyfill: false },
  },
  server: {
    strictPort: true,
    // `npm run dev -w web` on 8787 provides /api; the dev UI talks to it directly.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
});
