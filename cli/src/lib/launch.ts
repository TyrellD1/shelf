import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** `shelf://open?id=...` — handled by the desktop app. */
export function deepLink(id: string): string {
  return `shelf://open?id=${encodeURIComponent(id)}`;
}

export function findAppBundle(): string | null {
  const candidates = [
    process.env.SHELF_APP_PATH,
    "/Applications/Shelf.app",
    join(homedir(), "Applications", "Shelf.app"),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function openUrl(url: string): Promise<void> {
  if (process.platform === "darwin") {
    await run("open", [url]);
    return;
  }
  if (process.platform === "win32") {
    await run("cmd", ["/c", "start", "", url]);
    return;
  }
  await run("xdg-open", [url]);
}

export async function openPath(path: string): Promise<void> {
  await openUrl(path);
}

export function shelfBinaryPath(): string {
  return process.argv[1] ?? "shelf";
}
