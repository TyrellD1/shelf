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

/** `report-v3.html` → `{ base: "report", version: 3 }`; unversioned files have no version. */
export function versionOf(file: ShelfFileMeta): { base: string; version: number | null } {
  const title = titleOf(file);
  const match = /^(.*?)-v(\d+)$/i.exec(title);
  if (!match || !match[1]) return { base: title, version: null };
  return { base: match[1], version: Number(match[2]) };
}

/** The folder part of a path, `""` for a file at the root. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Case-insensitive `[start, end)` ranges of `query` in `text`, for highlighting. */
export function highlightRanges(text: string, query: string): [number, number][] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const haystack = text.toLowerCase();
  const ranges: [number, number][] = [];
  let from = 0;
  for (;;) {
    const found = haystack.indexOf(needle, from);
    if (found === -1) break;
    ranges.push([found, found + needle.length]);
    from = found + needle.length;
  }
  return ranges;
}

/**
 * Section label for a timestamp: Today, Yesterday, This week, then the month
 * ("September", or "September 2025" outside the current year). Days are local.
 */
export function dateGroup(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Undated";
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "long" } : { month: "long", year: "numeric" });
}

/** Splits an already sorted list into consecutive date sections. */
export function groupByDate<T>(
  items: T[],
  stamp: (item: T) => string,
  now: number = Date.now(),
): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dateGroup(stamp(item), now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/**
 * Everything a rendered list depends on. Equal signatures mean the DOM would
 * come out identical, so a background refresh can skip the rebuild.
 */
export function listSignature(files: ShelfFileMeta[], extra: string, now: number = Date.now()): string {
  return [
    extra,
    ...files.map((file) => `${file.id}:${file.editedAt}:${file.bytes}:${relativeTime(file.editedAt, now)}:${relativeTime(file.createdAt, now)}`),
  ].join("|");
}

/**
 * The desktop deep link for a web reader URL: `#/f/<id>` → `shelf://open?id=<id>`.
 * Anything else (the list, a bad hash) has nothing to hand off.
 */
export function appLinkFor(hash: string): string | null {
  const match = /^#\/f\/([^/?#]+)$/.exec(hash);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return id ? `shelf://open?id=${encodeURIComponent(id)}` : null;
}

/**
 * Whether this browser could be on a machine with the desktop app installed.
 * Phones and tablets cannot, and iPadOS reports itself as a Mac with touch.
 */
export function isDesktopBrowser(userAgent: string, maxTouchPoints = 0): boolean {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return false;
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return false;
  return true;
}
