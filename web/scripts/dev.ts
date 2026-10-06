import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { route, type Services } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { createDb } from "../src/db.js";
import { loadEnv } from "./env.js";

/**
 * Local host (`npm run dev`). Runs the same `route` as production (`src/vercel.ts`)
 * in plain Node, and serves the built UI the way `vercel.json` does: a file when
 * one matches, otherwise `index.html`.
 */
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8787);
const UI_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const env = loadEnv();
let services: Services | undefined;

function getServices(): Services {
  if (!services) {
    const db = createDb(env);
    services = { db, auth: createAuth(env, db) };
  }
  return services;
}

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`), {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    // Node requires this to send a streamed body.
    duplex: "half",
  } as RequestInit);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") res.setHeader(name, value);
  });
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  res.statusCode = response.status;
  if (!response.body) {
    res.end();
    return;
  }
  // Streamed, not buffered: MCP answers over server-sent events.
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

async function sendAsset(res: ServerResponse, pathname: string): Promise<void> {
  let file = resolve(UI_DIST, `.${decodeURIComponent(pathname)}`);
  const inside = file === UI_DIST || file.startsWith(UI_DIST + sep);
  if (!inside || !existsSync(file) || !statSync(file).isFile()) file = join(UI_DIST, "index.html");
  if (!existsSync(file)) {
    res.statusCode = 404;
    res.end("ui/dist is missing. Run: npm run build -w ui");
    return;
  }
  res.setHeader("content-type", CONTENT_TYPES[extname(file)] ?? "application/octet-stream");
  res.end(await readFile(file));
}

createServer(async (req, res) => {
  try {
    const request = toRequest(req);
    const response = await route(request, env, getServices);
    if (response) await send(res, response);
    else await sendAsset(res, new URL(request.url).pathname);
  } catch (error) {
    console.error("shelf: dev server error", error);
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  }
}).listen(PORT, HOST, () => {
  console.log(`shelf: http://localhost:${PORT}`);
});
