import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { KeyScope } from "@shelf/shared";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface ShelfConfig {
  version: 1;
  apiUrl: string;
  token: string;
  clientId: string;
  machineId: string;
  user: { id: string; email: string } | null;
  createdAt: string;
  /** What the key may do. Missing on configs written before scopes: full. */
  scope?: KeyScope;
}

export const CONFIG_VERSION = 1;

export function shelfHome(): string {
  const override = process.env.SHELF_HOME?.trim();
  if (override) return resolve(override.replace(/^~(?=$|\/)/, homedir()));
  return join(homedir(), ".shelf");
}

export function configPath(): string {
  return join(shelfHome(), "config.json");
}

export function ensureHome(): void {
  mkdirSync(shelfHome(), { recursive: true, mode: 0o700 });
}

export function loadConfig(): ShelfConfig | null {
  const file = configPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ShelfConfig;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveConfig(config: ShelfConfig): void {
  ensureHome();
  const file = configPath();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // best effort on filesystems without POSIX modes
  }
}

export function requireConfig(): ShelfConfig {
  const config = loadConfig();
  if (!config || !config.token) {
    throw new UserError("shelf is not set up on this machine. Run: shelf setup");
  }
  return config;
}

export function configScope(config: ShelfConfig | null): KeyScope {
  return config?.scope === "append" ? "append" : "full";
}

/** Refuses a command an append-only key cannot do; the server would refuse it anyway. */
export function requireFullScope(config: ShelfConfig, what: string): void {
  if (configScope(config) === "append") {
    throw new UserError(
      `${what} needs full access; this machine's key is append-only`,
      "append_only",
      "run: shelf setup (and choose Full access) to change it",
    );
  }
}

export class UserError extends Error {
  constructor(
    message: string,
    readonly code = "user_error",
    readonly hint?: string,
  ) {
    super(message);
    this.name = "UserError";
  }
}

export function apiUrlFromEnv(): string | null {
  const value = process.env.SHELF_API_URL?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}
