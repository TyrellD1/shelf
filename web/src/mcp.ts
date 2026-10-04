import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import type { Kysely } from "kysely";
import { z } from "zod";
import {
  COMMANDS,
  SHELF_TAGLINE,
  fileUrl,
  parseMachineList,
  type ShelfFileMeta,
} from "@shelf/shared";
import { mcpResource, type Auth } from "./auth.js";
import type { Database } from "./db.js";
import type { Env } from "./env.js";
import { listFiles, resolveFile, writeVersioned } from "./files.js";

/**
 * The shelf over MCP, for claude.ai: the document commands of the CLI
 * (`list`, `read`, `write`) as tools, described in the CLI's own words
 * (`COMMANDS` in shared/). Descriptions stay one line; the rules show up as
 * parameter descriptions and as error hints when a call breaks one.
 *
 * Stateless: each POST is verified and served on its own, so there is nothing
 * to keep between requests (no Durable Objects, no sessions).
 */

/** Files written over MCP live under this machine id, beside your real machines. */
export const MCP_MACHINE_ID = "mcp";

export async function handleMcp(
  request: Request,
  env: Env,
  auth: Auth,
  db: Kysely<Database>,
): Promise<Response> {
  const resource = mcpResource(env.APP_URL);
  const userId = await verifiedUser(request, env, auth, resource);
  if (!userId) return challenge(env);

  const handler = createMcpHandler(() => createServer(env, db, userId), {
    responseMode: "json",
    onerror: (error) => console.error("shelf: mcp", error.message),
  });
  return handler.fetch(request);
}

/** The user id from a valid access token for this resource, or null. */
async function verifiedUser(
  request: Request,
  env: Env,
  auth: Auth,
  resource: string,
): Promise<string | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return null;
  try {
    // Keys come straight from the database, so the Worker never fetches itself.
    const claims = await verifyJwsAccessToken(token, {
      jwksFetch: async () => auth.api.getJwks(),
      verifyOptions: { issuer: `${env.APP_URL}/api/auth`, audience: resource },
    });
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

/** RFC 9728: tells the client where to find the authorization server. */
function challenge(env: Env): Response {
  const metadata = `${env.APP_URL}/.well-known/oauth-protected-resource/mcp`;
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Sign in to your shelf to use it." },
      id: null,
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${metadata}"`,
      },
    },
  );
}

function createServer(env: Env, db: Kysely<Database>, userId: string): McpServer {
  const server = new McpServer(
    { name: "shelf", version: "1" },
    { instructions: `Shelf: ${SHELF_TAGLINE}. Files are addressed by id or path.` },
  );
  const link = (file: ShelfFileMeta) => ({
    id: file.id,
    machine: file.machineId,
    path: file.path,
    editedAt: file.editedAt,
    bytes: file.bytes,
    url: fileUrl(env.APP_URL, file.id),
  });

  server.registerTool(
    "list",
    {
      description: `${COMMANDS.list}. Metadata only; read a file for its HTML.`,
      inputSchema: z.object({
        search: z.string().optional().describe("matches path or machine"),
        machine: z.string().optional().describe("one machine id, or several comma-separated"),
        sort: z.enum(["created", "edited"]).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("default 20"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ search, machine, sort, limit, offset }) => {
      const result = await listFiles(db, userId, {
        q: search,
        machines: parseMachineList(machine),
        sort,
        limit: limit ?? 20,
        offset,
      });
      return ok({ files: result.files.map(link), total: result.total, hasMore: result.hasMore });
    },
  );

  server.registerTool(
    "read",
    {
      description: `${COMMANDS.read}.`,
      inputSchema: z.object({
        file: z.string().describe("id (sf_…) or path"),
        machine: z.string().optional().describe("when the path exists on several machines"),
        meta: z.boolean().optional().describe("metadata only, no HTML"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ file, machine, meta }) => {
      const found = await resolveFile(db, userId, file, machine);
      if (!found) return fail("not_found", `not found: ${file}`, "list to see what is on the shelf");
      if (meta) return ok(link(found));
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(link(found)) },
          { type: "text" as const, text: found.html },
        ],
      };
    },
  );

  server.registerTool(
    "write",
    {
      description: `${COMMANDS.write}. A path that exists gets a new version (-v2) unless replace.`,
      inputSchema: z.object({
        path: z.string().describe("relative, ends in .html, e.g. reports/q3.html"),
        html: z
          .string()
          .describe("the whole document; inline all CSS, JS and images (no network access)"),
        replace: z.boolean().optional().describe("overwrite the path in place"),
        asNew: z.boolean().optional().describe("new version even if identical content exists"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ path, html, replace, asNew }) => {
      const result = await writeVersioned(db, userId, {
        machineId: MCP_MACHINE_ID,
        path,
        html,
        replace,
        asNew,
      });
      if (!result.ok) return fail(result.error, result.message, result.hint);
      return ok({
        action: result.action,
        ...(result.file.path !== result.requestedPath ? { requestedPath: result.requestedPath } : {}),
        ...link(result.file),
      });
    },
  );

  return server;
}

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/** Same shape as the CLI's `--json` failures: `{ ok: false, error, code, hint? }`. */
function fail(code: string, message: string, hint?: string) {
  const body = { ok: false, error: message, code, ...(hint ? { hint } : {}) };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}
