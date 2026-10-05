import { sha1Hex } from "./hash.js";

export const MACHINE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MAX_HTML_BYTES = 5 * 1024 * 1024;
export const MAX_PATH_LENGTH = 512;

/** Deterministic file id. Same machine + path always yields the same id. */
export function fileId(machineId: string, pathOnMachine: string): string {
  return `sf_${sha1Hex(`${machineId}\u0000${pathOnMachine}`).slice(0, 20)}`;
}

export function isValidMachineId(value: string): boolean {
  return MACHINE_ID_RE.test(value);
}

/**
 * The machine an MCP client's writes are filed under, from the name it
 * registered with: "Claude" -> `claude-mcp`. A name with nothing usable in it
 * is plain `mcp`.
 */
export function mcpMachineId(clientName: string | null | undefined): string {
  const slug = (clientName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-?mcp$/, "")
    .slice(0, 58)
    .replace(/-+$/, "");
  return slug ? `${slug}-mcp` : "mcp";
}

/**
 * The `machine` filter on the wire: one id, or several joined by commas
 * (`mac-mini,ci-runner`). Machine ids cannot contain commas, so this is
 * unambiguous. Invalid and repeated ids are dropped; an empty list means "all".
 */
export function parseMachineList(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => isValidMachineId(id));
  return [...new Set(ids)];
}

/** Normalize a user supplied path into a stable, relative, posix-style path. */
export function normalizePath(input: string): string {
  let p = input.trim().replace(/\\/g, "/");
  p = p.replace(/^\.\//, "");
  p = p.replace(/\/{2,}/g, "/");
  return p;
}

export function pathError(path: string): string | null {
  if (!path) return "path is empty";
  if (path.length > MAX_PATH_LENGTH) return `path is longer than ${MAX_PATH_LENGTH} characters`;
  if (path.startsWith("/")) return "path must be relative (no leading slash)";
  if (path.includes("..")) return "path must not contain '..'";
  if (path.endsWith("/")) return "path must point at a file";
  if (/[\u0000-\u001f]/.test(path)) return "path contains control characters";
  if (!/\.(html?|htm)$/i.test(path)) return "path must end in .html";
  return null;
}

/** Path that a re-write of an existing file gets, e.g. `report.html` -> `report-v2.html`. */
export function nextVersionPath(path: string): string {
  const match = /^(.*?)-v(\d+)(\.html?)$/i.exec(path);
  if (match) {
    return `${match[1]}-v${Number(match[2]) + 1}${match[3]}`;
  }
  const dot = path.lastIndexOf(".");
  return `${path.slice(0, dot)}-v2${path.slice(dot)}`;
}

/** A path's version family: `report-v3.html` and `report.html` share `report.html`. */
export function familyKey(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return path;
  return `${path.slice(0, dot).replace(/-v\d+$/, "")}${path.slice(dot)}`;
}

/**
 * A path's place in its family: `report-v3.html` is 3, `report.html` is 1.
 * `FAMILY_SQL` and `VERSION_SQL` are the same rules for Postgres, so the
 * Worker can collapse a family in SQL and agree with the CLI.
 */
export function versionNumber(path: string): number {
  const match = /-v(\d+)\.[^.]*$/.exec(path);
  return match ? Number(match[1]) : 1;
}

/** `regexp_replace(path, FAMILY_SQL.pattern, FAMILY_SQL.replacement)` is `familyKey(path)`. */
export const FAMILY_SQL = { pattern: "-v[0-9]+(\\.[^.]*)$", replacement: "\\1" } as const;
/** `substring(path from VERSION_SQL)` is the digits of `versionNumber(path)`, or null for 1. */
export const VERSION_SQL = "-v([0-9]+)\\.[^.]*$";

/** What the version rules need from a file. */
interface Versioned {
  id: string;
  machineId: string;
  path: string;
  createdAt: string;
}

/** Newest version first: highest `-vN`, then the later write, then the id. */
export function compareVersions(a: Versioned, b: Versioned): number {
  return (
    versionNumber(b.path) - versionNumber(a.path) ||
    (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

/** Families are per machine: two machines' `report.html` are separate documents. */
export function versionFamily(file: Pick<Versioned, "machineId" | "path">): string {
  return `${file.machineId}\u0000${familyKey(file.path)}`;
}

/**
 * One file per version family, the newest, with `versions` set to the family
 * size. Order follows the input (the first member seen holds the slot).
 */
export function latestVersions<T extends Versioned>(files: T[]): (T & { versions: number })[] {
  const families = new Map<string, T[]>();
  for (const file of files) {
    const key = versionFamily(file);
    const members = families.get(key);
    if (members) members.push(file);
    else families.set(key, [file]);
  }
  return [...families.values()].map((members) => ({
    ...[...members].sort(compareVersions)[0],
    versions: members.length,
  }));
}

export function displayName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.html?$/i, "");
}

/** Web app route that opens one file in the reader. The UI and the CLI must agree on it. */
export function fileRoute(id: string): string {
  return `#/f/${encodeURIComponent(id)}`;
}

/** Shareable link to a file in the web app, which is served from the API origin. */
export function fileUrl(apiUrl: string, id: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/${fileRoute(id)}`;
}
