/**
 * The words the CLI help and the MCP server both use, so the two surfaces
 * describe the shelf the same way. Keep each summary to one short line: the
 * detail lives in flags / parameter descriptions and in error hints.
 */

export const SHELF_TAGLINE = "a local-first shelf for HTML written by agents";

/** Commands that exist on both surfaces (`shelf <name>` and the MCP tool `<name>`). */
export const COMMANDS = {
  list: "list files, newest first",
  read: "get a file's HTML (or its metadata)",
  write: "write an HTML file to the shelf",
} as const;
