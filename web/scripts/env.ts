import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HyperdriveLike } from "../src/env.js";

export interface ScriptEnv {
  APP_URL: string;
  BETTER_AUTH_SECRET: string;
  ALLOWED_EMAILS?: string;
  DATABASE_URL?: string;
  HYPERDRIVE?: HyperdriveLike;
  SEED_EMAIL?: string;
  SEED_PASSWORD?: string;
  SEED_NAME?: string;
}

/**
 * Small `.dev.vars` loader for Node scripts. Mirrors what `wrangler dev` does,
 * so the scripts and the Worker agree on configuration.
 */
export function loadEnv(): ScriptEnv {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  }

  const env: ScriptEnv = {
    APP_URL: process.env.APP_URL ?? "http://localhost:8787",
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
    ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
    DATABASE_URL: process.env.DATABASE_URL,
    SEED_EMAIL: process.env.SEED_EMAIL,
    SEED_PASSWORD: process.env.SEED_PASSWORD,
    SEED_NAME: process.env.SEED_NAME,
  };

  if (!env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is missing. Copy web/.dev.vars.example to web/.dev.vars.");
  }
  return env;
}
