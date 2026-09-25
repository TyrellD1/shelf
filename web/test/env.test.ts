import { describe, expect, it } from "vitest";
import { allowedEmails, databaseUrl, isAllowedEmail } from "../src/env.js";

describe("isAllowedEmail", () => {
  it("allows everyone when no allowlist is configured (local development)", () => {
    expect(isAllowedEmail({ ALLOWED_EMAILS: "" }, "anyone@example.com")).toBe(true);
    expect(allowedEmails({ ALLOWED_EMAILS: "" })).toEqual([]);
  });

  it("matches the allowlist case-insensitively and ignores whitespace", () => {
    const env = { ALLOWED_EMAILS: " Me@Example.com , second@example.com " };
    expect(allowedEmails(env)).toEqual(["me@example.com", "second@example.com"]);
    expect(isAllowedEmail(env, "me@example.com")).toBe(true);
    expect(isAllowedEmail(env, "ME@EXAMPLE.COM")).toBe(true);
    expect(isAllowedEmail(env, "second@example.com")).toBe(true);
  });

  it("rejects everyone else", () => {
    const env = { ALLOWED_EMAILS: "me@example.com" };
    expect(isAllowedEmail(env, "someone@example.com")).toBe(false);
    expect(isAllowedEmail(env, "me@example.com.evil.com")).toBe(false);
  });
});

describe("databaseUrl", () => {
  it("prefers the Hyperdrive binding and falls back to DATABASE_URL", () => {
    expect(databaseUrl({ HYPERDRIVE: { connectionString: "postgres://hd" } })).toBe("postgres://hd");
    expect(databaseUrl({ DATABASE_URL: "postgres://local" })).toBe("postgres://local");
  });

  it("explains itself when nothing is configured", () => {
    expect(() => databaseUrl({})).toThrow(/no database configured/);
  });
});
