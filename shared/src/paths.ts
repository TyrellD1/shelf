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

export function displayName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.html?$/i, "");
}
