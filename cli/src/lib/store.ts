import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileId, type MachineSummary, type ShelfFileMeta } from "@shelf/shared";
import { ensureHome, shelfHome } from "./config.js";

export interface Entry {
  id: string;
  machineId: string;
  pathOnMachine: string;
  createdAt: string;
  editedAt: string;
  bytes: number;
  sha256: string;
  /** sha of what the server has — null when never pushed (or fetched). */
  pushedSha: string | null;
  /** When this device last pulled the file from another machine. */
  fetchedAt: string | null;
}

export interface ShelfIndex {
  version: 1;
  lastSyncAt: string | null;
  entries: Record<string, Entry>;
}

const INDEX_VERSION = 1;

export function indexFile(): string {
  return join(shelfHome(), "index.json");
}

export function htmlRoot(): string {
  return join(shelfHome(), "html");
}

export function htmlPath(machineId: string, pathOnMachine: string): string {
  return join(htmlRoot(), machineId, ...pathOnMachine.split("/"));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function emptyIndex(): ShelfIndex {
  return { version: INDEX_VERSION, lastSyncAt: null, entries: {} };
}

export function loadIndex(): ShelfIndex {
  const file = indexFile();
  if (!existsSync(file)) return emptyIndex();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ShelfIndex;
    if (!parsed || typeof parsed !== "object" || !parsed.entries) return emptyIndex();
    return { version: INDEX_VERSION, lastSyncAt: parsed.lastSyncAt ?? null, entries: parsed.entries };
  } catch {
    return emptyIndex();
  }
}

export function saveIndex(index: ShelfIndex): void {
  ensureHome();
  const file = indexFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(index, null, 1)}\n`);
  renameSync(tmp, file);
}

/**
 * Rebuilds metadata by scanning the html directory. The store keeps the
 * authoritative bytes; index.json is a cache that can always be recreated.
 */
export function rebuildIndex(): ShelfIndex {
  const index = emptyIndex();
  const root = htmlRoot();
  if (!existsSync(root)) return index;

  for (const machineId of readdirSync(root)) {
    const machineDir = join(root, machineId);
    if (!statSync(machineDir).isDirectory()) continue;
    walk(machineDir, (absolute) => {
      const pathOnMachine = relative(machineDir, absolute).split(sep).join("/");
      const stats = statSync(absolute);
      const html = readFileSync(absolute, "utf8");
      const stamp = stats.mtime.toISOString();
      index.entries[fileId(machineId, pathOnMachine)] = {
        id: fileId(machineId, pathOnMachine),
        machineId,
        pathOnMachine,
        createdAt: stats.birthtime?.toISOString?.() ?? stamp,
        editedAt: stamp,
        bytes: stats.size,
        sha256: sha256(html),
        pushedSha: null,
        fetchedAt: null,
      };
    });
  }

  saveIndex(index);
  return index;
}

function walk(dir: string, visit: (file: string) => void): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const child = join(dir, name);
    const stats = statSync(child);
    if (stats.isDirectory()) walk(child, visit);
    else visit(child);
  }
}

export function loadIndexOrRebuild(): ShelfIndex {
  const file = indexFile();
  if (!existsSync(file)) return rebuildIndex();
  return loadIndex();
}

export function writeHtmlFile(machineId: string, pathOnMachine: string, html: string): string {
  const target = htmlPath(machineId, pathOnMachine);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html, "utf8");
  return target;
}

export function readHtmlFile(machineId: string, pathOnMachine: string): string | null {
  const target = htmlPath(machineId, pathOnMachine);
  if (!existsSync(target)) return null;
  return readFileSync(target, "utf8");
}

export function entryForPath(
  index: ShelfIndex,
  machineId: string,
  pathOnMachine: string,
): Entry | undefined {
  return Object.values(index.entries).find(
    (entry) => entry.machineId === machineId && entry.pathOnMachine === pathOnMachine,
  );
}

export function entryById(index: ShelfIndex, id: string): Entry | undefined {
  return index.entries[id];
}

export function toMeta(entry: Entry): ShelfFileMeta {
  return {
    id: entry.id,
    machineId: entry.machineId,
    path: entry.pathOnMachine,
    createdAt: entry.createdAt,
    editedAt: entry.editedAt,
    bytes: entry.bytes,
  };
}

export interface ListOptions {
  q?: string;
  machine?: string;
  sort?: "created" | "edited";
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export function listEntries(
  index: ShelfIndex,
  options: ListOptions,
): { files: ShelfFileMeta[]; total: number; hasMore: boolean } {
  const q = options.q?.trim().toLowerCase();
  let entries = Object.values(index.entries);
  if (options.machine) entries = entries.filter((entry) => entry.machineId === options.machine);
  if (q) {
    entries = entries.filter(
      (entry) =>
        entry.pathOnMachine.toLowerCase().includes(q) ||
        entry.machineId.toLowerCase().includes(q),
    );
  }

  const key = options.sort === "edited" ? "editedAt" : "createdAt";
  const factor = options.dir === "asc" ? 1 : -1;
  entries.sort((left, right) => {
    const a = new Date(left[key]).getTime();
    const b = new Date(right[key]).getTime();
    if (a === b) return left.id < right.id ? -1 : 1;
    return a < b ? -factor : factor;
  });

  const total = entries.length;
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  const page = entries.slice(offset, offset + limit);
  return { files: page.map(toMeta), total, hasMore: offset + page.length < total };
}

export function machines(index: ShelfIndex): MachineSummary[] {
  const map = new Map<string, MachineSummary>();
  for (const entry of Object.values(index.entries)) {
    const current = map.get(entry.machineId);
    if (current) {
      current.count += 1;
      if (entry.editedAt > current.latestAt) current.latestAt = entry.editedAt;
    } else {
      map.set(entry.machineId, {
        machineId: entry.machineId,
        count: 1,
        latestAt: entry.editedAt,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.machineId.localeCompare(b.machineId));
}

export function pendingPush(index: ShelfIndex, machineId: string): Entry[] {
  return Object.values(index.entries).filter(
    (entry) => entry.machineId === machineId && entry.sha256 !== entry.pushedSha,
  );
}
