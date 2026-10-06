/**
 * What a CLI key may do. A browser session is always `full`; only API keys can
 * be narrowed, and the scope is fixed when the key is minted.
 *
 * - `full`: list, read, sync down, write, replace.
 * - `append`: write new documents only. It can never read HTML back, list the
 *   shelf, or overwrite a path: a rewrite lands on the next free version.
 */
export type KeyScope = "full" | "append";

export const KEY_SCOPES: readonly KeyScope[] = ["full", "append"];

/** Better Auth api-key permissions stored on the key for each scope. */
export const SCOPE_PERMISSIONS: Record<KeyScope, Record<string, string[]>> = {
  full: { files: ["read", "write"] },
  append: { files: ["append"] },
};

/** Lenient parse for query strings and form fields; anything unknown is `full`. */
export function parseScope(value: unknown): KeyScope {
  return value === "append" ? "append" : "full";
}

/**
 * The scope a stored key carries. Keys minted before scopes existed have no
 * permissions at all and stay `full`, which is what they were issued as.
 */
export function scopeFromPermissions(permissions: unknown): KeyScope {
  if (!permissions || typeof permissions !== "object") return "full";
  const files = (permissions as Record<string, unknown>).files;
  if (!Array.isArray(files)) return "full";
  return files.includes("read") ? "full" : "append";
}

/**
 * Whether a request is open to an append-only key: its own account, writing,
 * and looking up one path's metadata (no HTML) so a rewrite can pick the next
 * version. Everything else that reads the shelf is refused.
 */
export function appendScopeAllows(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (path === "/api/me" && verb === "GET") return true;
  if (path === "/api/files" && verb === "POST") return true;
  if (path === "/api/files/by-path" && verb === "GET") return true;
  return false;
}
