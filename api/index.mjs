// Vercel finds functions in /api. The server itself is bundled from web/src/vercel.ts
// by `npm run build -w web`, which the build in vercel.json runs first.
export { default } from "../web/dist/vercel.mjs";
