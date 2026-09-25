import { displayName, type ShelfFileMeta, type SortKey } from "@shelf/shared";

/** Pure list helpers — no DOM, so they are cheap to test. */

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return formatDate(iso);
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function titleOf(file: ShelfFileMeta): string {
  return displayName(file.path);
}

export interface Filter {
  q?: string;
  machine?: string;
}

export function matches(file: ShelfFileMeta, filter: Filter): boolean {
  if (filter.machine && file.machineId !== filter.machine) return false;
  const q = filter.q?.trim().toLowerCase();
  if (!q) return true;
  return (
    file.path.toLowerCase().includes(q) ||
    file.machineId.toLowerCase().includes(q) ||
    titleOf(file).toLowerCase().includes(q)
  );
}

export function sortFiles(
  files: ShelfFileMeta[],
  sort: SortKey = "created",
  dir: "asc" | "desc" = "desc",
): ShelfFileMeta[] {
  const key = sort === "edited" ? "editedAt" : "createdAt";
  const factor = dir === "asc" ? 1 : -1;
  return [...files].sort((a, b) => {
    const left = new Date(a[key]).getTime();
    const right = new Date(b[key]).getTime();
    if (left === right) return a.id < b.id ? -1 : 1;
    return left < right ? -factor : factor;
  });
}

export interface MachineFacet {
  machineId: string;
  count: number;
  latestAt: string;
}

export function facets(files: ShelfFileMeta[]): MachineFacet[] {
  const map = new Map<string, MachineFacet>();
  for (const file of files) {
    const current = map.get(file.machineId);
    if (current) {
      current.count += 1;
      if (file.editedAt > current.latestAt) current.latestAt = file.editedAt;
    } else {
      map.set(file.machineId, {
        machineId: file.machineId,
        count: 1,
        latestAt: file.editedAt,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.machineId.localeCompare(b.machineId));
}

/** Cheap subsequence fuzzy score for the command palette. */
export function fuzzyScore(haystack: string, needle: string): number {
  const text = haystack.toLowerCase();
  const query = needle.trim().toLowerCase();
  if (!query) return 1;
  let score = 0;
  let index = 0;
  let streak = 0;
  for (const char of query) {
    const found = text.indexOf(char, index);
    if (found === -1) return 0;
    streak = found === index ? streak + 1 : 0;
    index = found + 1;
    score += 1 + streak;
    if (found === 0 || text[found - 1] === "/" || text[found - 1] === "-") score += 2;
  }
  return score / (1 + haystack.length / 40);
}

export function searchFiles(files: ShelfFileMeta[], query: string, limit = 20): ShelfFileMeta[] {
  const trimmed = query.trim();
  if (!trimmed) return files.slice(0, limit);
  return files
    .map((file) => ({ file, score: fuzzyScore(`${file.path} ${file.machineId}`, trimmed) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.file);
}
