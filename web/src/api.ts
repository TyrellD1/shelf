import { sql } from "kysely";
import type { Kysely } from "kysely";
import {
  MAX_HTML_BYTES,
  appendScopeAllows,
  fileId,
  isValidMachineId,
  parseMachineList,
  normalizePath,
  pathError,
  type ChangesResponse,
  type ErrorResponse,
  type ListResponse,
  type MachineSummary,
  type MeResponse,
  type WriteRequestBody,
  type WriteResponse,
} from "@shelf/shared";
import { credentialScope, type Auth } from "./auth.js";
import type { Database } from "./db.js";
import type { Env } from "./env.js";
import { getFile, listFiles, metaSelect, sha256Hex, toIso, toMeta } from "./files.js";
import { notifyNewFile, type Defer } from "./notify.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const DEFAULT_CHANGES_LIMIT = 500;
const MAX_CHANGES_LIMIT = 2000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function fail(status: number, error: string, message?: string, extra?: object): Response {
  const body: ErrorResponse = { error, ...(message ? { message } : {}), ...extra };
  return json(body, status);
}

function isUnchanged(stored: string | null | undefined, digest: string): boolean {
  return Boolean(stored) && stored === digest;
}

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export async function handleApi(
  request: Request,
  env: Env,
  auth: Auth,
  db: Kysely<Database>,
  defer: Defer,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/api/health") {
    const started = Date.now();
    await db.selectFrom("shelf_files").select("id").limit(1).execute();
    return json({ ok: true, db: "up", ms: Date.now() - started });
  }

  let session: Awaited<ReturnType<typeof auth.api.getSession>> = null;
  try {
    session = await auth.api.getSession({ headers: request.headers });
  } catch {
    return fail(401, "unauthorized", "Invalid or expired credential.");
  }
  if (!session) {
    return fail(401, "unauthorized", "Sign in with the shelf CLI or the web app.");
  }
  const userId = session.user.id;

  const scope = await credentialScope(auth, request.headers);
  if (!scope) return fail(401, "unauthorized", "Invalid or expired credential.");
  if (scope === "append" && !appendScopeAllows(method, path)) {
    return fail(403, "forbidden_scope", "This key is append-only: it can write new documents, not read the shelf.");
  }

  if (path === "/api/me" && method === "GET" && scope === "append") {
    const body: MeResponse = {
      user: { id: session.user.id, email: session.user.email, name: session.user.name ?? null },
      machines: [],
      fileCount: 0,
      appUrl: env.APP_URL,
      scope,
    };
    return json(body);
  }

  if (path === "/api/me" && method === "GET") {
    const [machines, countRow] = await Promise.all([
      db
        .selectFrom("shelf_files")
        .select(["machine_id"])
        .select((eb) => [eb.fn.countAll<number>().as("count"), sql<Date>`max(edited_at)`.as("latest")])
        .where("user_id", "=", userId)
        .groupBy("machine_id")
        .execute(),
      db
        .selectFrom("shelf_files")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow(),
    ]);
    const body: MeResponse = {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name ?? null,
      },
      machines: machines.map<MachineSummary>((row) => ({
        machineId: row.machine_id,
        count: Number(row.count ?? 0),
        latestAt: row.latest ? toIso(row.latest) : new Date(0).toISOString(),
      })),
      fileCount: Number(countRow.count ?? 0),
      appUrl: env.APP_URL,
      scope,
    };
    return json(body);
  }

  if (path === "/api/machines" && method === "GET") {
    const rows = await db
      .selectFrom("shelf_files")
      .select(["machine_id"])
      .select((eb) => [eb.fn.countAll<number>().as("count"), sql<Date>`max(edited_at)`.as("latest")])
      .where("user_id", "=", userId)
      .groupBy("machine_id")
      .orderBy("machine_id", "asc")
      .execute();
    return json(
      rows.map<MachineSummary>((row) => ({
        machineId: row.machine_id,
        count: Number(row.count ?? 0),
        latestAt: row.latest ? toIso(row.latest) : new Date(0).toISOString(),
      })),
    );
  }

  // Delta feed for `shelf sync`: everything edited after `since`.
  if (path === "/api/changes" && method === "GET") {
    const since = url.searchParams.get("since");
    const excludeMachine = url.searchParams.get("excludeMachine");
    const limit = intParam(url.searchParams.get("limit"), DEFAULT_CHANGES_LIMIT, 1, MAX_CHANGES_LIMIT);

    let query = db.selectFrom("shelf_files").selectAll().where("user_id", "=", userId);
    if (since) {
      const sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) return fail(400, "bad_request", "since is not a date");
      query = query.where("edited_at", ">", sinceDate);
    }
    if (excludeMachine) query = query.where("machine_id", "!=", excludeMachine);

    const rows = await query.orderBy("edited_at", "asc").limit(limit + 1).execute();
    const page = rows.slice(0, limit);
    const body: ChangesResponse = {
      files: page.map((row) => ({
        ...toMeta(row),
        bytes: new TextEncoder().encode(row.html).length,
        html: row.html,
      })),
      nextSince: page.length > 0 ? toIso(page[page.length - 1].edited_at) : since,
      hasMore: rows.length > limit,
    };
    return json(body);
  }

  if (path === "/api/files" && method === "GET") {
    const limit = intParam(url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = intParam(url.searchParams.get("offset"), 0, 0, 100_000);
    const search = url.searchParams.get("q")?.trim();
    const machineIds = parseMachineList(url.searchParams.get("machine"));
    const body: ListResponse = await listFiles(db, userId, {
      q: search,
      machines: machineIds,
      sort: url.searchParams.get("sort") === "edited" ? "edited" : "created",
      dir: url.searchParams.get("dir") === "asc" ? "asc" : "desc",
      limit,
      offset,
    });
    return json(body);
  }

  if (path === "/api/files/by-path" && method === "GET") {
    const machineId = url.searchParams.get("machineId")?.trim() ?? "";
    const rawPath = normalizePath(url.searchParams.get("path") ?? "");
    if (!isValidMachineId(machineId)) return fail(400, "bad_request", "bad machineId");
    const row = await db
      .selectFrom("shelf_files")
      .select(metaSelect())
      .where("user_id", "=", userId)
      .where("machine_id", "=", machineId)
      .where("path_on_machine", "=", rawPath)
      .executeTakeFirst();
    if (!row) return fail(404, "not_found", "no file at that path");
    return json(toMeta(row));
  }

  if (path === "/api/files" && method === "POST") {
    const body = (await request.json().catch(() => null)) as WriteRequestBody | null;
    if (!body) return fail(400, "bad_request", "body must be JSON");

    const machineId = (body.machineId ?? "").trim();
    const filePath = normalizePath(body.path ?? "");
    const id = (body.id ?? "").trim();
    const html = typeof body.html === "string" ? body.html : "";

    if (!isValidMachineId(machineId)) {
      return fail(400, "bad_request", "machineId must be lowercase letters, digits and dashes");
    }
    const badPath = pathError(filePath);
    if (badPath) return fail(400, "bad_request", badPath);
    if (!html.trim()) return fail(400, "bad_request", "html is empty");
    if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
      return fail(413, "too_large", `html is larger than ${MAX_HTML_BYTES} bytes`);
    }
    const expectedId = fileId(machineId, filePath);
    if (id !== expectedId) {
      return fail(400, "bad_request", `id must be ${expectedId} for that machine + path`);
    }

    const existing = await db
      .selectFrom("shelf_files")
      .selectAll()
      .where("user_id", "=", userId)
      .where("id", "=", id)
      .executeTakeFirst();

    const digest = await sha256Hex(html);

    if (existing) {
      if (isUnchanged(existing.sha256, digest)) {
        return json({
          file: toMeta({ ...existing, bytes: new TextEncoder().encode(html).length }),
          created: false,
          replaced: false,
        });
      }
      // Append-only keys never overwrite: the client versions up on the 409.
      if (body.replace && scope === "full") {
        const updated = await db
          .updateTable("shelf_files")
          .set({ html, sha256: digest, edited_at: new Date() })
          .where("user_id", "=", userId)
          .where("id", "=", id)
          .returning(["id", "machine_id", "path_on_machine", "created_at", "edited_at", "sha256"])
          .executeTakeFirstOrThrow();
        const response: WriteResponse = {
          file: toMeta({ ...updated, html }),
          created: false,
          replaced: true,
        };
        return json(response);
      }
      const response: ErrorResponse = {
        error: "exists",
        message: `${filePath} is already on the shelf`,
        existing: toMeta(existing),
      };
      return json(response, 409);
    }

    const inserted = await db
      .insertInto("shelf_files")
      .values({
        user_id: userId,
        id,
        machine_id: machineId,
        path_on_machine: filePath,
        html,
        sha256: digest,
        created_at: new Date(),
        edited_at: new Date(),
      })
      .returning(["id", "machine_id", "path_on_machine", "created_at", "edited_at", "sha256"])
      .executeTakeFirstOrThrow();

    const response: WriteResponse = {
      file: toMeta({ ...inserted, html }),
      created: true,
      replaced: false,
    };
    defer(notifyNewFile(env, response.file));
    return json(response, 201);
  }

  const fileMatch = /^\/api\/files\/([A-Za-z0-9_-]{3,64})$/.exec(path);
  if (fileMatch && method === "GET") {
    const file = await getFile(db, userId, fileMatch[1]);
    if (!file) return fail(404, "not_found", "no such file");
    const { sha256: _sha256, ...body } = file;
    return json(body);
  }

  return fail(404, "not_found", `no route for ${method} ${path}`);
}
