import { describe, expect, it } from "vitest";
import type { ShelfFileMeta } from "@shelf/shared";
import {
  appLinkFor,
  dateGroup,
  facets,
  folderOf,
  groupByDate,
  highlightRanges,
  isDesktopBrowser,
  listSignature,
  versionOf,
  formatBytes,
  matches,
  relativeTime,
  searchFiles,
  sortFiles,
  titleOf,
} from "../src/logic.js";

const file = (over: Partial<ShelfFileMeta>): ShelfFileMeta => ({
  id: "sf_a",
  machineId: "mac-mini",
  path: "outputs/report.html",
  createdAt: "2026-01-01T00:00:00.000Z",
  editedAt: "2026-01-01T00:00:00.000Z",
  bytes: 1024,
  ...over,
});

describe("relativeTime", () => {
  const now = Date.parse("2026-03-01T12:00:00.000Z");
  it("describes recent timestamps", () => {
    expect(relativeTime("2026-03-01T11:59:30.000Z", now)).toBe("just now");
    expect(relativeTime("2026-03-01T11:30:00.000Z", now)).toBe("30m ago");
    expect(relativeTime("2026-03-01T06:00:00.000Z", now)).toBe("6h ago");
    expect(relativeTime("2026-02-26T12:00:00.000Z", now)).toBe("3d ago");
  });
  it("falls back to a date for old files", () => {
    expect(relativeTime("2025-01-01T00:00:00.000Z", now)).toMatch(/\d/);
  });
});

describe("formatBytes", () => {
  it("scales units", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("titleOf", () => {
  it("uses the file name without the extension", () => {
    expect(titleOf(file({ path: "deep/dir/my-report.html" }))).toBe("my-report");
  });
});

describe("matches", () => {
  const files = [
    file({ id: "a", path: "outputs/q3-report.html", machineId: "mac-mini" }),
    file({ id: "b", path: "deck.html", machineId: "macbook" }),
  ];
  it("filters by machine", () => {
    expect(files.filter((f) => matches(f, { machine: "macbook" })).map((f) => f.id)).toEqual(["b"]);
  });
  it("searches path, title and machine", () => {
    expect(files.filter((f) => matches(f, { q: "q3" })).map((f) => f.id)).toEqual(["a"]);
    expect(files.filter((f) => matches(f, { q: "DECK" })).map((f) => f.id)).toEqual(["b"]);
    expect(files.filter((f) => matches(f, { q: "macmini" }))).toHaveLength(0);
    expect(files.filter((f) => matches(f, { q: "mini" })).map((f) => f.id)).toEqual(["a"]);
  });
});

describe("sortFiles", () => {
  const files = [
    file({ id: "old", createdAt: "2026-01-01T00:00:00.000Z", editedAt: "2026-03-01T00:00:00.000Z" }),
    file({ id: "new", createdAt: "2026-02-01T00:00:00.000Z", editedAt: "2026-02-01T00:00:00.000Z" }),
  ];
  it("sorts newest first by default and edits separately", () => {
    expect(sortFiles(files).map((f) => f.id)).toEqual(["new", "old"]);
    expect(sortFiles(files, "created", "asc").map((f) => f.id)).toEqual(["old", "new"]);
    expect(sortFiles(files, "edited").map((f) => f.id)).toEqual(["old", "new"]);
  });
});

describe("facets", () => {
  it("counts and dates machines", () => {
    const result = facets([
      file({ id: "a", machineId: "mac-mini" }),
      file({ id: "b", machineId: "mac-mini", editedAt: "2026-02-01T00:00:00.000Z" }),
      file({ id: "c", machineId: "macbook" }),
    ]);
    expect(result).toEqual([
      { machineId: "mac-mini", count: 2, latestAt: "2026-02-01T00:00:00.000Z" },
      { machineId: "macbook", count: 1, latestAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });
});

describe("searchFiles", () => {
  const files = [
    file({ id: "a", path: "outputs/quarterly-report.html" }),
    file({ id: "b", path: "outputs/deck.html" }),
    file({ id: "c", path: "notes/todo.html" }),
  ];
  it("returns recent files for an empty query", () => {
    expect(searchFiles(files, "", 2).map((f) => f.id)).toEqual(["a", "b"]);
  });
  it("fuzzy matches path fragments", () => {
    expect(searchFiles(files, "qrep").map((f) => f.id)).toEqual(["a"]);
    expect(searchFiles(files, "deck").map((f) => f.id)).toEqual(["b"]);
    expect(searchFiles(files, "zzz")).toHaveLength(0);
  });
  it("respects the limit", () => {
    expect(searchFiles(files, "o", 1)).toHaveLength(1);
  });
});

describe("versionOf", () => {
  it("splits a version suffix off the title", () => {
    expect(versionOf(file({ path: "docs/report-v3.html" }))).toEqual({ base: "report", version: 3 });
    expect(versionOf(file({ path: "docs/report.html" }))).toEqual({ base: "report", version: null });
    expect(versionOf(file({ path: "-v2.html" }))).toEqual({ base: "-v2", version: null });
  });
});

describe("folderOf", () => {
  it("returns the directory or nothing", () => {
    expect(folderOf("a/b/c.html")).toBe("a/b");
    expect(folderOf("c.html")).toBe("");
  });
});

describe("highlightRanges", () => {
  it("finds every case-insensitive match", () => {
    expect(highlightRanges("Report-report", "REP")).toEqual([
      [0, 3],
      [7, 10],
    ]);
    expect(highlightRanges("abc", " ")).toEqual([]);
    expect(highlightRanges("abc", "z")).toEqual([]);
  });
});

describe("dateGroup", () => {
  const now = new Date(2026, 9, 2, 15, 0).getTime();
  it("labels recent days, then months", () => {
    expect(dateGroup(new Date(2026, 9, 2, 1).toISOString(), now)).toBe("Today");
    expect(dateGroup(new Date(2026, 9, 1, 23).toISOString(), now)).toBe("Yesterday");
    expect(dateGroup(new Date(2026, 8, 28).toISOString(), now)).toBe("This week");
    expect(dateGroup(new Date(2026, 7, 3).toISOString(), now)).toMatch(/August/);
    expect(dateGroup(new Date(2025, 7, 3).toISOString(), now)).toMatch(/2025/);
    expect(dateGroup("nope", now)).toBe("Undated");
  });
  it("groups consecutive items", () => {
    const stamps = [new Date(2026, 9, 2).toISOString(), new Date(2026, 9, 2).toISOString(), new Date(2026, 9, 1).toISOString()];
    const groups = groupByDate(stamps, (s) => s, now);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
    ]);
  });
});

describe("listSignature", () => {
  it("changes when content or displayed time changes", () => {
    const now = Date.parse("2026-01-01T00:10:00.000Z");
    const a = listSignature([file({})], "q", now);
    expect(listSignature([file({})], "q", now)).toBe(a);
    expect(listSignature([file({ bytes: 9 })], "q", now)).not.toBe(a);
    expect(listSignature([file({})], "q2", now)).not.toBe(a);
    expect(listSignature([file({})], "q", now + 3_600_000)).not.toBe(a);
  });
});

describe("appLinkFor", () => {
  it("turns a reader route into the desktop deep link", () => {
    expect(appLinkFor("#/f/sf_abc123")).toBe("shelf://open?id=sf_abc123");
    expect(appLinkFor("#/f/sf%20x")).toBe("shelf://open?id=sf%20x");
  });

  it("has nothing to hand off for the list or a malformed hash", () => {
    expect(appLinkFor("")).toBeNull();
    expect(appLinkFor("#/")).toBeNull();
    expect(appLinkFor("#/f/")).toBeNull();
    expect(appLinkFor("#/f/%E0%A4%A")).toBeNull();
    expect(appLinkFor("#/f/a/b")).toBeNull();
  });
});

describe("isDesktopBrowser", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  it("accepts desktop browsers", () => {
    expect(isDesktopBrowser(mac, 0)).toBe(true);
    expect(isDesktopBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36")).toBe(true);
  });

  it("rejects phones and iPads posing as Macs", () => {
    expect(isDesktopBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148")).toBe(false);
    expect(isDesktopBrowser("Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile Safari/537.36")).toBe(false);
    expect(isDesktopBrowser(mac, 5)).toBe(false);
  });
});
