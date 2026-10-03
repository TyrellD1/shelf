import { describe, expect, it } from "vitest";
import {
  appendScopeAllows,
  parseScope,
  SCOPE_PERMISSIONS,
  scopeFromPermissions,
} from "../src/scope.js";

describe("parseScope", () => {
  it("only recognises append; anything else is full", () => {
    expect(parseScope("append")).toBe("append");
    expect(parseScope("full")).toBe("full");
    expect(parseScope("")).toBe("full");
    expect(parseScope("APPEND")).toBe("full");
    expect(parseScope(undefined)).toBe("full");
  });
});

describe("scopeFromPermissions", () => {
  it("round-trips the permissions each scope is minted with", () => {
    expect(scopeFromPermissions(SCOPE_PERMISSIONS.full)).toBe("full");
    expect(scopeFromPermissions(SCOPE_PERMISSIONS.append)).toBe("append");
  });

  it("treats keys minted before scopes existed as full", () => {
    expect(scopeFromPermissions(null)).toBe("full");
    expect(scopeFromPermissions(undefined)).toBe("full");
    expect(scopeFromPermissions({})).toBe("full");
  });

  it("is append whenever read is missing", () => {
    expect(scopeFromPermissions({ files: [] })).toBe("append");
    expect(scopeFromPermissions({ files: ["write"] })).toBe("append");
  });
});

describe("appendScopeAllows", () => {
  it("allows writing, its account and path lookups", () => {
    expect(appendScopeAllows("POST", "/api/files")).toBe(true);
    expect(appendScopeAllows("get", "/api/me")).toBe(true);
    expect(appendScopeAllows("GET", "/api/files/by-path")).toBe(true);
  });

  it("refuses everything that reads the shelf", () => {
    expect(appendScopeAllows("GET", "/api/files")).toBe(false);
    expect(appendScopeAllows("GET", "/api/files/abc123")).toBe(false);
    expect(appendScopeAllows("GET", "/api/changes")).toBe(false);
    expect(appendScopeAllows("GET", "/api/machines")).toBe(false);
    expect(appendScopeAllows("POST", "/api/files/by-path")).toBe(false);
  });
});
