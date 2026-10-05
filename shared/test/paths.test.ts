import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands.js";
import {
  familyKey,
  fileId,
  fileUrl,
  nextVersionPath,
  normalizePath,
  pathError,
  isValidMachineId,
  mcpMachineId,
  parseMachineList,
  compareVersions,
  latestVersions,
  versionNumber,
  FAMILY_SQL,
  VERSION_SQL,
} from "../src/paths.js";
import { sha1Hex } from "../src/hash.js";
import { machineColor, machineHue, machineHues } from "../src/color.js";

describe("sha1Hex", () => {
  it("matches known vectors", () => {
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex("shelf 📚")).toHaveLength(40);
  });
});

describe("fileId", () => {
  it("is deterministic and machine scoped", () => {
    const a = fileId("mac-mini", "reports/q3.html");
    expect(a).toBe(fileId("mac-mini", "reports/q3.html"));
    expect(a).not.toBe(fileId("macbook", "reports/q3.html"));
    expect(a.startsWith("sf_")).toBe(true);
    expect(a).toHaveLength(23);
  });
});

describe("normalizePath", () => {
  it("strips leading ./ and collapses slashes", () => {
    expect(normalizePath("./out//a.html")).toBe("out/a.html");
    expect(normalizePath("out\\a.html")).toBe("out/a.html");
  });
});

describe("pathError", () => {
  it("accepts relative html paths", () => {
    expect(pathError("a.html")).toBeNull();
    expect(pathError("nested/dir/b.htm")).toBeNull();
  });
  it("rejects escapes and non-html", () => {
    expect(pathError("/abs/a.html")).toBeTruthy();
    expect(pathError("../a.html")).toBeTruthy();
    expect(pathError("a.txt")).toBeTruthy();
    expect(pathError("")).toBeTruthy();
  });
});

describe("nextVersionPath", () => {
  it("adds and increments version suffixes", () => {
    expect(nextVersionPath("report.html")).toBe("report-v2.html");
    expect(nextVersionPath("report-v2.html")).toBe("report-v3.html");
    expect(nextVersionPath("deck-v11.htm")).toBe("deck-v12.htm");
    expect(nextVersionPath("a/b.c.html")).toBe("a/b.c-v2.html");
  });
});

describe("machineHue", () => {
  it("is stable and in range", () => {
    expect(machineHue("macbook-pro")).toBe(machineHue("macbook-pro"));
    expect(machineHue("macbook-pro")).toBeGreaterThanOrEqual(0);
    expect(machineHue("macbook-pro")).toBeLessThan(360);
  });
});

describe("machineHues", () => {
  it("separates machines whose hashes land side by side", () => {
    // 299° and 302° by hash: the pair that prompted slot assignment.
    const hues = machineHues(["tyrell-macbook-pro", "grokbot-box", "cmc-tyrell-macbook-pro"]);
    const values = [...hues.values()];
    expect(new Set(values).size).toBe(3);
    for (const a of values) {
      for (const b of values) {
        const gap = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
        if (a !== b) expect(gap).toBeGreaterThanOrEqual(45);
      }
    }
  });

  it("ignores input order and duplicates", () => {
    const a = machineHues(["b", "a", "c"]);
    const b = new Map(machineHues(["c", "a", "b", "a"]));
    expect(b).toEqual(new Map(a));
  });

  it("stays distinct past the minimum slot count", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `machine-${i}`);
    expect(new Set(machineHues(ids).values()).size).toBe(20);
  });

  it("falls back to the hash for an unknown machine", () => {
    expect(machineColor("solo").hue).toBe(machineHue("solo"));
    expect(machineColor("solo", ["other"]).hue).toBe(machineHue("solo"));
  });
});

describe("mcpMachineId", () => {
  it("names the machine after the client", () => {
    expect(mcpMachineId("Claude")).toBe("claude-mcp");
    expect(mcpMachineId("Claude Code (my-mac)")).toBe("claude-code-my-mac-mcp");
  });

  it("does not double the suffix", () => {
    expect(mcpMachineId("Shelf MCP")).toBe("shelf-mcp");
    expect(mcpMachineId("mcp")).toBe("mcp");
  });

  it("falls back to mcp and always yields a valid id", () => {
    expect(mcpMachineId(null)).toBe("mcp");
    expect(mcpMachineId("  ☃  ")).toBe("mcp");
    expect(isValidMachineId(mcpMachineId("x".repeat(200)))).toBe(true);
    expect(isValidMachineId(mcpMachineId("-- Agent --"))).toBe(true);
  });
});

describe("isValidMachineId", () => {
  it("enforces the id shape", () => {
    expect(isValidMachineId("mac-mini")).toBe(true);
    expect(isValidMachineId("Mac Mini")).toBe(false);
    expect(isValidMachineId("-bad")).toBe(false);
    expect(isValidMachineId("a".repeat(64))).toBe(false);
  });
});

describe("parseMachineList", () => {
  it("splits, trims, validates and dedupes", () => {
    expect(parseMachineList("mac-mini")).toEqual(["mac-mini"]);
    expect(parseMachineList(" mac-mini , ci-runner,mac-mini ")).toEqual(["mac-mini", "ci-runner"]);
    expect(parseMachineList("mac-mini,Bad Id,,")).toEqual(["mac-mini"]);
    expect(parseMachineList("")).toEqual([]);
    expect(parseMachineList(null)).toEqual([]);
  });
});

describe("fileUrl", () => {
  it("links to the reader route on the API origin", () => {
    expect(fileUrl("https://shelf.example.dev/", "mac:docs/a b.html")).toBe(
      "https://shelf.example.dev/#/f/mac%3Adocs%2Fa%20b.html",
    );
  });
});

describe("familyKey", () => {
  it("groups a path with its versions", () => {
    expect(familyKey("reports/q3.html")).toBe("reports/q3.html");
    expect(familyKey("reports/q3-v2.html")).toBe("reports/q3.html");
    expect(familyKey("reports/q3-v12.htm")).toBe("reports/q3.htm");
    expect(familyKey(nextVersionPath(nextVersionPath("a.html")))).toBe("a.html");
  });
});

describe("versionNumber", () => {
  it("reads the -vN suffix, and 1 without one", () => {
    expect(versionNumber("reports/q3.html")).toBe(1);
    expect(versionNumber("reports/q3-v2.html")).toBe(2);
    expect(versionNumber("reports/q3-v12.htm")).toBe(12);
    expect(versionNumber("v2/report.html")).toBe(1);
  });
});

describe("FAMILY_SQL / VERSION_SQL", () => {
  // Postgres ARE and JS agree on these patterns, so JS stands in for the database here.
  const sqlFamily = (path: string) =>
    path.replace(new RegExp(FAMILY_SQL.pattern), FAMILY_SQL.replacement.replace("\\1", "$1"));
  const sqlVersion = (path: string) => Number(new RegExp(VERSION_SQL).exec(path)?.[1] ?? 1);

  it("match familyKey and versionNumber", () => {
    for (const path of ["a.html", "a-v2.html", "x/a-v10.htm", "-v2.html", ".html", "a.b/c-v3.html", "a-V2.html"]) {
      expect(sqlFamily(path)).toBe(familyKey(path));
      expect(sqlVersion(path)).toBe(versionNumber(path));
    }
  });
});

describe("latestVersions", () => {
  const file = (id: string, machineId: string, path: string, createdAt = "2026-01-01T00:00:00.000Z") => ({
    id,
    machineId,
    path,
    createdAt,
  });

  it("keeps the highest version of each family, per machine", () => {
    const files = [
      file("a1", "mac", "r.html"),
      file("a3", "mac", "r-v3.html"),
      file("a2", "mac", "r-v2.html"),
      file("b1", "ci", "r.html"),
      file("c1", "mac", "other.html"),
    ];
    const latest = latestVersions(files);
    expect(latest.map((f) => [f.id, f.versions])).toEqual([
      ["a3", 3],
      ["b1", 1],
      ["c1", 1],
    ]);
  });

  it("breaks a version tie by the later write", () => {
    const older = file("x", "mac", "r-v1.html", "2026-01-01T00:00:00.000Z");
    const newer = file("y", "mac", "r.html", "2026-02-01T00:00:00.000Z");
    expect([older, newer].sort(compareVersions)[0].id).toBe("y");
    expect(latestVersions([older, newer])[0].id).toBe("y");
  });
});

describe("COMMANDS", () => {
  it("keeps every summary to one short line", () => {
    for (const summary of Object.values(COMMANDS)) {
      expect(summary).not.toContain("\n");
      expect(summary.length).toBeLessThanOrEqual(40);
    }
  });
});
