import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import {
  MAX_HTML_BYTES,
  fileId,
  nextVersionPath,
  normalizePath,
  pathError,
  type ShelfFileMeta,
} from "@shelf/shared";
import { ApiError, createApi } from "./api.js";
import { requireConfig, UserError } from "./config.js";
import { confirm, isInteractive } from "./prompt.js";
import type { Output } from "./output.js";
import {
  entryForPath,
  loadIndexOrRebuild,
  saveIndex,
  sha256,
  toMeta,
  writeHtmlFile,
  type Entry,
  type ShelfIndex,
} from "./store.js";

export interface WriteRequest {
  /** Path as passed on the command line. */
  inputPath: string;
  replace?: boolean;
  asNew?: boolean;
  push?: boolean;
  output: Output;
}

export interface WriteOutcome {
  action: "created" | "versioned" | "replaced" | "unchanged";
  entry: Entry;
  pushed: boolean;
  warnings: string[];
  requestedPath: string;
  path: string;
  changed: boolean;
}

/**
 * Creates or updates a shelf entry.
 *
 * Paths are immutable: a re-write of an existing path becomes `<name>-v2.html`
 * (and -v3, …) unless `replace` is set. Local bytes are the source of truth and
 * `index.json` is just a cache, so a write always touches the store first and
 * then tries to push.
 */
export async function writeToShelf(request: WriteRequest): Promise<WriteOutcome> {
  const { output } = request;
  const config = requireConfig();
  const machineId = config.machineId;
  if (!machineId) {
    throw new UserError("no machine id on this machine", "no_machine_id", "run: shelf setup");
  }

  const absolute = resolve(process.cwd(), request.inputPath);
  if (!existsSync(absolute)) {
    throw new UserError(`no such file: ${request.inputPath}`, "missing_file");
  }
  if (statSync(absolute).isDirectory()) {
    throw new UserError(`${request.inputPath} is a directory`, "bad_path");
  }

  const html = readFileSync(absolute, "utf8");
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_HTML_BYTES) {
    throw new UserError(
      `${request.inputPath} is ${bytes} bytes, over the ${MAX_HTML_BYTES} byte limit`,
      "too_large",
    );
  }
  const digest = sha256(html);

  let path = shelfPathFor(request.inputPath);
  const badPath = pathError(path);
  if (badPath) {
    throw new UserError(`${badPath}: ${path}`, "bad_path", "paths are relative and end in .html");
  }

  const index = loadIndexOrRebuild();
  const api = createApi(config.apiUrl, config.token);
  const warnings: string[] = [];
  const requestedPath = path;

  let entry: Entry | undefined = entryForPath(index, machineId, path);
  if (!entry) {
    const remote = await api
      .byPath(machineId, path)
      .catch((error) => {
        output.progress(`could not check ${path} remotely: ${message(error)}`);
        return null;
      });
    if (remote) entry = entryFromMeta(remote);
  }

  const previous = entry;
  let action: WriteOutcome["action"] = "created";

  if (previous) {
    const sameContent = previous.sha256 === digest;

    if (sameContent && previous.pushedSha === digest) {
      return unchanged(previous);
    }

    // Re-running the same write must not stack versions: if any member of this
    // path's version family already holds exactly these bytes, that is a no-op.
    // (`--replace` and `--as-new` are explicit instructions, so they skip this.)
    if (!request.replace && !request.asNew) {
      const twin = Object.values(index.entries).find(
        (candidate) =>
          candidate.machineId === machineId &&
          candidate.sha256 === digest &&
          candidate.pushedSha === digest &&
          familyKey(candidate.pathOnMachine) === familyKey(path),
      );
      if (twin) return unchanged(twin);
    }

    if (request.replace) {
      action = "replaced";
    } else {
      action = "versioned";
      const resolved = await firstFreePath(index, machineId, path, api);
      if (request.asNew) {
        output.progress(`${path} already exists — writing ${resolved}`);
      } else if (!isInteractive()) {
        output.progress(`${path} already exists — writing it as ${resolved}`);
      } else if (!(await confirm(`${path} is already on the shelf. Write this as ${resolved}?`, true))) {
        throw new UserError(
          `not written: ${path} already exists`,
          "exists",
          "pass a different path, or --replace to update in place",
        );
      }
      path = resolved;
    }
  }

  const keepingPlace = action === "replaced" && previous !== undefined;
  const record: Entry = {
    id: fileId(machineId, path),
    machineId,
    pathOnMachine: path,
    createdAt: keepingPlace ? (previous?.createdAt ?? new Date().toISOString()) : new Date().toISOString(),
    editedAt: new Date().toISOString(),
    bytes,
    sha256: digest,
    pushedSha: keepingPlace ? (previous?.pushedSha ?? null) : null,
    fetchedAt: previous?.fetchedAt ?? null,
  };

  let written = writeHtmlFile(machineId, path, html);
  let pushed = false;

  if (request.push !== false) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await api.write({
          id: record.id,
          machineId,
          path: record.pathOnMachine,
          html,
          replace: true,
        });
        record.pushedSha = digest;
        record.editedAt = response.file.editedAt;
        pushed = true;
        break;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          // The server already has this path with different bytes: version up.
          if (attempt === 0) action = "versioned";
          path = await firstFreePath(index, machineId, record.pathOnMachine, api);
          if (written && existsSync(written)) unlinkSync(written);
          record.id = fileId(machineId, path);
          record.pathOnMachine = path;
          written = writeHtmlFile(machineId, path, html);
          continue;
        }
        if (error instanceof ApiError && error.isUnauthorized) {
          throw new UserError(
            "the saved token was rejected (401)",
            "unauthorized",
            "run: shelf setup",
          );
        }
        warnings.push(`written locally but not pushed: ${message(error)}`);
        break;
      }
    }
    if (!pushed && warnings.length === 0) {
      warnings.push("written locally but not pushed: too many version conflicts");
    }
  }

  record.bytes = Buffer.byteLength(html, "utf8");
  index.entries[record.id] = record;
  saveIndex(index);

  return { action, entry: record, pushed, warnings, requestedPath, path, changed: true };

  function unchanged(current: Entry): WriteOutcome {
    return {
      action: "unchanged",
      entry: current,
      pushed: false,
      warnings,
      requestedPath,
      path: current.pathOnMachine,
      changed: false,
    };
  }
}

/** `a/report-v3.html` and `a/report.html` share a family key. */
export function familyKey(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return path;
  return `${path.slice(0, dot).replace(/-v\d+$/, "")}${path.slice(dot)}`;
}

/** Walks -v2, -v3, … until neither the local index nor the server has the path. */
async function firstFreePath(
  index: ShelfIndex,
  machineId: string,
  from: string,
  api: ReturnType<typeof createApi>,
): Promise<string> {
  let candidate = nextVersionPath(from);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (entryForPath(index, machineId, candidate)) {
      candidate = nextVersionPath(candidate);
      continue;
    }
    const remote = await api.byPath(machineId, candidate).catch(() => null);
    if (remote) {
      candidate = nextVersionPath(candidate);
      continue;
    }
    return candidate;
  }
  throw new UserError("could not find a free version for that path", "no_free_path");
}

function entryFromMeta(meta: ShelfFileMeta): Entry {
  return {
    id: meta.id,
    machineId: meta.machineId,
    pathOnMachine: meta.path,
    createdAt: meta.createdAt,
    editedAt: meta.editedAt,
    bytes: meta.bytes,
    sha256: meta.sha256 ?? "",
    pushedSha: meta.sha256 ?? "",
    fetchedAt: null,
  };
}

/** Where the file lives on the shelf. Relative by default, `~/…` outside the cwd. */
export function shelfPathFor(inputPath: string, cwd: string = process.cwd()): string {
  if (!isAbsolute(inputPath)) return normalizePath(inputPath);
  const absolute = resolve(cwd, inputPath);
  const fromCwd = relative(cwd, absolute);
  if (fromCwd && !fromCwd.startsWith("..")) return normalizePath(fromCwd);
  const fromHome = relative(homedir(), absolute);
  if (fromHome && !fromHome.startsWith("..")) return normalizePath(`~/${fromHome}`);
  return normalizePath(absolute.replace(/^\/+/, ""));
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "earlier";
  const seconds = (now - then) / 1000;
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { toMeta };
