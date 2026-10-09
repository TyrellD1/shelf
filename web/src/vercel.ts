import { attachDatabasePool, waitUntil } from "@vercel/functions";
import { route, type Services } from "./app.js";
import { createAuth } from "./auth.js";
import { createDb, createPool } from "./db.js";
import type { Env } from "./env.js";

/**
 * Vercel host (production). `vercel.json` sends every server route here and serves
 * the built UI itself, so a path `route` does not know is a plain 404.
 *
 * An instance handles many requests, so the pool and the Better Auth instance are
 * built once and reused; `attachDatabasePool` closes idle connections before the
 * instance is suspended.
 */
const env: Env = {
  APP_URL: appUrl(),
  BETTER_AUTH_SECRET: required("BETTER_AUTH_SECRET"),
  ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
  DATABASE_URL: required("DATABASE_URL"),
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
};

let services: Services | undefined;

function getServices(): Services {
  if (!services) {
    const pool = createPool(env);
    attachDatabasePool(pool);
    const db = createDb(env, pool);
    services = { db, auth: createAuth(env, db) };
  }
  return services;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const response = await route(request, env, getServices, waitUntil);
    return response ?? new Response("Not found", { status: 404 });
  },
};

/**
 * The origin people open. Vercel names the project's production domain itself, so
 * `APP_URL` only needs setting to serve from a different one.
 */
function appUrl(): string {
  const domain = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const url = process.env.APP_URL || (domain ? `https://${domain}` : "");
  if (!url) throw new Error("APP_URL is not set (Vercel project → Settings → Environment Variables)");
  return url.replace(/\/+$/, "");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (Vercel project → Settings → Environment Variables)`);
  return value;
}
