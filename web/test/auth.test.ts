import { describe, expect, it } from "vitest";
import { isAllowedRedirectUri, mcpResource } from "../src/auth.js";

describe("mcpResource", () => {
  it("is the app's /mcp", () => {
    expect(mcpResource("https://shelf.example.dev")).toBe("https://shelf.example.dev/mcp");
    expect(mcpResource("https://shelf.example.dev/")).toBe("https://shelf.example.dev/mcp");
  });
});

describe("isAllowedRedirectUri", () => {
  it("accepts Claude's callbacks", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:3118/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:49152/callback")).toBe(true);
  });

  it("refuses everything else", () => {
    expect(isAllowedRedirectUri("https://evil.example/api/mcp/auth_callback")).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai/other")).toBe(false);
    expect(isAllowedRedirectUri("https://localhost/callback")).toBe(false);
    expect(isAllowedRedirectUri("http://localhost.evil.example/callback")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
    expect(isAllowedRedirectUri(42)).toBe(false);
  });
});
