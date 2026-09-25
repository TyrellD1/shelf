import { describe, expect, it } from "vitest";
import { fileId, nextVersionPath, normalizePath, pathError, isValidMachineId } from "../src/paths.js";
import { sha1Hex } from "../src/hash.js";
import { machineHue } from "../src/color.js";

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

describe("isValidMachineId", () => {
  it("enforces the id shape", () => {
    expect(isValidMachineId("mac-mini")).toBe(true);
    expect(isValidMachineId("Mac Mini")).toBe(false);
    expect(isValidMachineId("-bad")).toBe(false);
    expect(isValidMachineId("a".repeat(64))).toBe(false);
  });
});
