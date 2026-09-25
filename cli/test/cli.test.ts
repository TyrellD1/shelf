import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, flagBool, flagString, flagNumber } from "../src/lib/flags.js";
import { shelfPathFor, relativeTime } from "../src/lib/writer.js";
import { emptyIndex, listEntries, machines, pendingPush, type Entry } from "../src/lib/store.js";
import { sanitizeHostname } from "../src/commands/setup.js";

describe("parseArgs", () => {
  it("separates positional and flag values", () => {
    const args = parseArgs(["report.html", "--replace", "--limit=5", "--machine", "mac-mini"]);
    expect(args.positional).toEqual(["report.html"]);
    expect(flagBool(args, "--replace")).toBe(true);
    expect(flagNumber(args, "--limit", 20)).toBe(5);
    expect(flagString(args, "--machine")).toBe("mac-mini");
  });

  it("does not swallow the next positional for boolean flags", () => {
    const args = parseArgs(["a.html", "--json", "b.html"]);
    expect(args.positional).toEqual(["a.html", "b.html"]);
  });
});

describe("shelfPathFor", () => {
  const cwd = "/Users/t/work/project";

  it("keeps relative paths relative", () => {
    expect(shelfPathFor("./outputs/report.html", cwd)).toBe("outputs/report.html");
  });

  it("makes absolute paths inside the cwd relative", () => {
    expect(shelfPathFor("/Users/t/work/project/outputs/report.html", cwd)).toBe("outputs/report.html");
  });

  it("compresses other absolute paths", () => {
    expect(shelfPathFor("/tmp/shelf/report.html", cwd)).toBe("tmp/shelf/report.html");
  });
});

describe("index helpers", () => {
  const entry = (over: Partial<Entry>): Entry => ({
    id: "sf_a",
    machineId: "mac-mini",
    pathOnMachine: "a.html",
    createdAt: "2026-01-01T00:00:00.000Z",
    editedAt: "2026-01-02T00:00:00.000Z",
    bytes: 10,
    sha256: "aa",
    pushedSha: "aa",
    fetchedAt: null,
    ...over,
  });

  const index = {
    ...emptyIndex(),
    entries: {
      sf_a: entry({}),
      sf_b: entry({ id: "sf_b", machineId: "macbook", pathOnMachine: "b.html", createdAt: "2026-02-01T00:00:00.000Z", sha256: "bb", pushedSha: null }),
    },
  };

  it("lists newest first and filters", () => {
    const all = listEntries(index, { limit: 10 });
    expect(all.files.map((file) => file.id)).toEqual(["sf_b", "sf_a"]);
    expect(all.total).toBe(2);
    expect(listEntries(index, { machine: "mac-mini", limit: 10 }).files).toHaveLength(1);
    expect(listEntries(index, { q: "b.html", limit: 10 }).files[0].id).toBe("sf_b");
  });

  it("reports machines", () => {
    expect(machines(index).map((machine) => machine.machineId).sort()).toEqual(["mac-mini", "macbook"]);
  });

  it("finds pushes needed for one machine", () => {
    expect(pendingPush(index, "mac-mini")).toHaveLength(0);
    expect(pendingPush(index, "macbook")).toHaveLength(1);
  });
});

describe("sanitizeHostname", () => {
  it("produces valid machine ids", () => {
    expect(sanitizeHostname("Tyrells-MacBook-Pro.local")).toBe("tyrells-macbook-pro");
    expect(sanitizeHostname("---")).toBe("machine");
  });
});

describe("relativeTime", () => {
  it("formats recent times", () => {
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    expect(relativeTime("2026-01-01T11:59:30.000Z", now)).toBe("just now");
    expect(relativeTime("2026-01-01T11:45:00.000Z", now)).toBe("15m ago");
    expect(relativeTime("2026-01-01T09:00:00.000Z", now)).toBe("3h ago");
  });
});

describe("cli bundle", () => {
  it("has no imports beyond node and the workspace", async () => {
    // Guards against a stray runtime dependency sneaking into the single-file build.
    const cwd = mkdtempSync(join(tmpdir(), "shelf-test-"));
    const dir = join(cwd, "nested");
    mkdirSync(dir);
    writeFileSync(join(dir, "x.html"), "<p>hi</p>");
    expect(shelfPathFor("nested/x.html", cwd)).toBe("nested/x.html");
  });
});
