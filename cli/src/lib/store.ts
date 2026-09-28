import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  fileId,
  nextVersionPath,
  type MachineSummary,
  type ShelfFileMeta,
} from "@shelf/shared";
import { ensureHome, shelfHome, UserError } from "./config.js";

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
  /**
   * Absolute path this was written from on this machine. Metadata only: never
   * part of the id, and lost when the index is rebuilt by scanning the store,
   * which is why a sync that pulls the row back can restore it.
   */
  sourcePath: string | null;
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
        // A scan of the bytes cannot know where they were written from; the
        // server's copy of the row, if there is one, still has it.
        sourcePath: null,
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

/**
 * Finds an entry from a file id or a path.
 *
 * A path matches exactly first, then by suffix, and among several suffixes the
 * shortest wins. Without that ordering the answer depends on the order entries
 * happen to sit in the index, which changes when a file is renamed or re-keyed.
 */
export function resolveEntry(index: ShelfIndex, target: string): Entry | undefined {
  const byId = index.entries[target];
  if (byId) return byId;

  const wanted = target.replace(/^\.\//, "");
  const matches = Object.values(index.entries).filter(
    (entry) => entry.pathOnMachine === wanted || entry.pathOnMachine.endsWith(`/${wanted}`),
  );
  const exact = matches.find((entry) => entry.pathOnMachine === wanted);
  if (exact) return exact;
  return matches.sort(
    (a, b) =>
      a.pathOnMachine.length - b.pathOnMachine.length ||
      a.pathOnMachine.localeCompare(b.pathOnMachine),
  )[0];
}

export function toMeta(entry: Entry): ShelfFileMeta {
  return {
    id: entry.id,
    machineId: entry.machineId,
    path: entry.pathOnMachine,
    createdAt: entry.createdAt,
    editedAt: entry.editedAt,
    bytes: entry.bytes,
    sourcePath: entry.sourcePath ?? null,
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

export interface RenameSummary {
  renamed: number;
  /** Files that already existed under the new machine and were kept as new versions. */
  versioned: { from: string; to: string }[];
  /** Entries whose bytes are missing from the store, so they were left alone. */
  missing: string[];
}

/**
 * Moves every entry of one machine id onto another, in the index and on disk.
 *
 * A machine id is not just a label: it is half of the file id
 * (`sha1(machineId + "\0" + path)`) and the folder the bytes live in. Renaming
 * therefore moves bytes, issues new ids, and clears `pushedSha`, because no
 * server has seen the new ids yet. Rows already pushed under the old id stay
 * where they are — the API has no delete, so the shelf keeps both copies.
 */
export function renameMachine(index: ShelfIndex, from: string, to: string): RenameSummary {
  if (from === to) return { renamed: 0, versioned: [], missing: [] };

  const summary: RenameSummary = { renamed: 0, versioned: [], missing: [] };
  for (const entry of Object.values(index.entries)) {
    if (entry.machineId !== from) continue;

    const source = htmlPath(from, entry.pathOnMachine);
    if (!existsSync(source)) {
      summary.missing.push(entry.pathOnMachine);
      continue;
    }
    const html = readFileSync(source, "utf8");

    let path = entry.pathOnMachine;
    const target = htmlPath(to, path);
    if (existsSync(target)) {
      if (readFileSync(target, "utf8") === html) {
        // The same bytes are already there, so this copy is redundant.
        unlinkSync(source);
      } else {
        // Different bytes at the same path: keep both, as a new version.
        path = freePath(index, to, path);
        summary.versioned.push({ from: entry.pathOnMachine, to: path });
      }
    }
    if (path !== entry.pathOnMachine || !existsSync(htmlPath(to, path))) {
      const destination = htmlPath(to, path);
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(source, destination);
    }

    delete index.entries[entry.id];
    const renamed: Entry = {
      ...entry,
      id: fileId(to, path),
      machineId: to,
      pathOnMachine: path,
      pushedSha: null,
    };
    index.entries[renamed.id] = renamed;
    summary.renamed += 1;
  }

  removeEmptyDirs(join(htmlRoot(), from));
  return summary;
}

/** `report.html` → `report-v2.html` when both the index and the disk are taken. */
function freePath(index: ShelfIndex, machineId: string, from: string): string {
  let candidate = nextVersionPath(from);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!entryForPath(index, machineId, candidate) && !existsSync(htmlPath(machineId, candidate))) {
      return candidate;
    }
    candidate = nextVersionPath(candidate);
  }
  throw new UserError(`no free version of ${from}`, "no_free_path");
}

/** Deletes directories that hold nothing, bottom up. Leaves files alone. */
function removeEmptyDirs(dir: string): boolean {
  if (!existsSync(dir)) return true;
  let empty = true;
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    if (statSync(child).isDirectory()) {
      if (!removeEmptyDirs(child)) empty = false;
    } else {
      empty = false;
    }
  }
  if (empty) {
    rmdirSync(dir);
    return true;
  }
  return false;
}
