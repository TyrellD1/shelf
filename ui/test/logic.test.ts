import { describe, expect, it } from "vitest";
import type { ShelfFileMeta } from "@shelf/shared";
import {
  facets,
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
