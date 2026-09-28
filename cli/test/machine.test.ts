import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileId } from "@shelf/shared";
import { loadIndexOrRebuild, renameMachine, emptyIndex, type Entry } from "../src/lib/store.js";

/**
 * A machine id is half of every file id, so these tests care about three things:
 * the bytes move to the new machine's folder, ids follow machine plus path, and
 * `pushedSha` is cleared (no server has seen the new ids).
 */
describe("renameMachine", () => {
  const home = mkdtempSync(join(tmpdir(), "shelf-rename-"));
  const previous = process.env.SHELF_HOME;

  beforeEach(() => {
    process.env.SHELF_HOME = home;
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.SHELF_HOME;
    else process.env.SHELF_HOME = previous;
  });

  function writeBytes(machineId: string, path: string, html: string): Entry {
    const absolute = join(home, "html", machineId, ...path.split("/"));
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, html);
    return {
      id: fileId(machineId, path),
      machineId,
      pathOnMachine: path,
      createdAt: "2026-01-01T00:00:00.000Z",
      editedAt: "2026-01-02T00:00:00.000Z",
      bytes: Buffer.byteLength(html, "utf8"),
      sha256: "a".repeat(64),
      pushedSha: "a".repeat(64),
      fetchedAt: null,
      sourcePath: `/Users/t/project/${path}`,
    };
  }

  it("moves bytes, reissues ids and forces a push", () => {
    const index = emptyIndex();
    const entry = writeBytes("old-mac", "docs/report.html", "<p>hi</p>");
    index.entries[entry.id] = entry;

    const summary = renameMachine(index, "old-mac", "new-mac");

    expect(summary.renamed).toBe(1);
    expect(summary.versioned).toEqual([]);
    expect(summary.missing).toEqual([]);

    const moved = join(home, "html", "new-mac", "docs", "report.html");
    expect(readFileSync(moved, "utf8")).toBe("<p>hi</p>");
    expect(existsSync(join(home, "html", "old-mac"))).toBe(false);

    expect(Object.keys(index.entries)).toEqual([fileId("new-mac", "docs/report.html")]);
    const renamed = index.entries[fileId("new-mac", "docs/report.html")];
    expect(renamed.machineId).toBe("new-mac");
    expect(renamed.pushedSha).toBeNull();
    expect(renamed.createdAt).toBe(entry.createdAt);
    expect(renamed.editedAt).toBe(entry.editedAt);
  });

  it("keeps a file that already exists under the new machine as a version", () => {
    const index = emptyIndex();
    const older = writeBytes("new-mac", "docs/report.html", "<p>already here</p>");
    index.entries[older.id] = older;
    const incoming = writeBytes("old-mac", "docs/report.html", "<p>different bytes</p>");
    index.entries[incoming.id] = incoming;

    const summary = renameMachine(index, "old-mac", "new-mac");

    expect(summary.renamed).toBe(1);
    expect(summary.versioned).toEqual([{ from: "docs/report.html", to: "docs/report-v2.html" }]);
    expect(readFileSync(join(home, "html", "new-mac", "docs", "report.html"), "utf8")).toBe(
      "<p>already here</p>",
    );
    expect(readFileSync(join(home, "html", "new-mac", "docs", "report-v2.html"), "utf8")).toBe(
      "<p>different bytes</p>",
    );
    expect(Object.keys(index.entries).sort()).toEqual(
      [fileId("new-mac", "docs/report.html"), fileId("new-mac", "docs/report-v2.html")].sort(),
    );
  });

  it("drops a duplicate copy and leaves other machines alone", () => {
    const index = emptyIndex();
    const twin = writeBytes("new-mac", "docs/report.html", "<p>same</p>");
    index.entries[twin.id] = twin;
    const other = writeBytes("third-mac", "docs/other.html", "<p>untouched</p>");
    index.entries[other.id] = other;
    index.entries[fileId("old-mac", "docs/report.html")] = {
      ...writeBytes("old-mac", "docs/report.html", "<p>same</p>"),
    };

    const summary = renameMachine(index, "old-mac", "new-mac");

    expect(summary.renamed).toBe(1);
    expect(summary.versioned).toEqual([]);
    expect(existsSync(join(home, "html", "old-mac"))).toBe(false);
    expect(index.entries[other.id]).toBeDefined();
    expect(readFileSync(join(home, "html", "third-mac", "docs", "other.html"), "utf8")).toBe(
      "<p>untouched</p>",
    );
  });

  it("reports entries whose bytes are gone, and does nothing when the id is unchanged", () => {
    const index = emptyIndex();
    index.entries[fileId("old-mac", "gone.html")] = {
      id: fileId("old-mac", "gone.html"),
      machineId: "old-mac",
      pathOnMachine: "gone.html",
      createdAt: "2026-01-01T00:00:00.000Z",
      editedAt: "2026-01-01T00:00:00.000Z",
      bytes: 1,
      sha256: "b".repeat(64),
      pushedSha: null,
      fetchedAt: null,
      sourcePath: null,
    };

    const summary = renameMachine(index, "old-mac", "new-mac");
    expect(summary.renamed).toBe(0);
    expect(summary.missing).toEqual(["gone.html"]);

    index.entries[fileId("mac", "a.html")] = writeBytes("mac", "a.html", "<p>a</p>");
    expect(renameMachine(index, "mac", "mac").renamed).toBe(0);
  });

  it("survives an index rebuild, which is what a renamed store looks like", () => {
    const index = emptyIndex();
    index.entries[fileId("old-mac", "nested/deep/file.html")] = writeBytes(
      "old-mac",
      "nested/deep/file.html",
      "<p>deep</p>",
    );
    renameMachine(index, "old-mac", "new-mac");

    // The folder scan is the source of truth, so a rebuilt index must agree.
    const rebuilt = loadIndexOrRebuild();
    const ids = Object.keys(rebuilt.entries);
    expect(ids).toEqual([fileId("new-mac", "nested/deep/file.html")]);
    expect(rebuilt.entries[ids[0]].machineId).toBe("new-mac");
    expect(rebuilt.entries[ids[0]].pushedSha).toBeNull();
  });
});
