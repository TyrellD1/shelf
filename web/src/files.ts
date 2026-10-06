import { sql } from "kysely";
import type { Kysely, SelectExpression } from "kysely";
import {
  FAMILY_SQL,
  MAX_HTML_BYTES,
  VERSION_SQL,
  familyKey,
  fileId,
  isValidMachineId,
  nextVersionPath,
  normalizePath,
  pathError,
  type ListResponse,
  type ShelfFile,
  type ShelfFileMeta,
} from "@shelf/shared";
import type { Database } from "./db.js";

/**
 * The shelf's file queries, shared by the REST API (`api.ts`) and the MCP
 * server (`mcp.ts`) so the two cannot answer the same question differently.
 */

/** Row shape `toMeta` accepts: either a metadata selection or a full row. */
interface MetaInput {
  id: string;
  machine_id: string;
  path_on_machine: string;
  created_at: Date | string;
  edited_at: Date | string;
  bytes?: number;
  sha256?: string | null;
  html?: string;
}

export interface ListOptions {
  q?: string;
  machines?: string[];
  sort?: "created" | "edited";
  dir?: "asc" | "desc";
  limit: number;
  offset?: number;
  /** Keep every version instead of the newest of each family. */
  allVersions?: boolean;
  /** Only this file's version family (an id or path), newest version first. */
  versionsOf?: string;
}

export type WriteAction = "created" | "versioned" | "replaced" | "unchanged";

export interface WriteInput {
  machineId: string;
  path: string;
  html: string;
  /** Overwrite the path in place instead of versioning it. */
  replace?: boolean;
  /** Always write a new version, even when an identical one already exists. */
  asNew?: boolean;
}

export type WriteResult =
  | { ok: true; action: WriteAction; requestedPath: string; file: ShelfFileMeta }
  | { ok: false; error: string; message: string; hint?: string };

/** Selection for list responses: metadata plus the html size, never the html itself. */
export function metaSelect(): SelectExpression<Database, "shelf_files">[] {
  return [
    "id",
    "machine_id",
    "path_on_machine",
    "created_at",
    "edited_at",
    "sha256",
    sql<number>`octet_length(html)`.as("bytes"),
  ];
}

export function toMeta(row: MetaInput): ShelfFileMeta {
  const bytes = row.bytes ?? (row.html ? byteLength(row.html) : 0);
  return {
    id: row.id,
    machineId: row.machine_id,
    path: row.path_on_machine,
    createdAt: toIso(row.created_at),
    editedAt: toIso(row.edited_at),
    bytes: Number(bytes),
    sha256: row.sha256 ?? "",
  };
}

export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Hex sha256 of a string, using Web Crypto (available in Workers). */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `familyKey(path_on_machine)` in SQL; see `FAMILY_SQL` in shared/. */
const familySql = sql<string>`regexp_replace(path_on_machine, ${FAMILY_SQL.pattern}, ${FAMILY_SQL.replacement})`;
/** `versionNumber(path_on_machine)` in SQL. */
const versionSql = sql<number>`coalesce(substring(path_on_machine from ${VERSION_SQL})::numeric, 1)`;

/**
 * Lists files. By default each version family (per machine) shows only its
 * newest member, ranked like `compareVersions`, and the search runs after that,
 * as `shelf list` does.
 */
export async function listFiles(
  db: Kysely<Database>,
  userId: string,
  options: ListOptions,
): Promise<ListResponse> {
  const offset = options.offset ?? 0;
  const sort = options.sort === "edited" ? "edited_at" : "created_at";
  const dir = options.dir === "asc" ? "asc" : "desc";
  const search = options.q?.trim();
  const machines = options.machines ?? [];

  let family: { machine_id: string; family: string } | null = null;
  if (options.versionsOf) {
    const of = await resolveMeta(db, userId, options.versionsOf);
    if (!of) return { files: [], total: 0, hasMore: false };
    family = { machine_id: of.machine_id, family: familyKey(of.path_on_machine) };
  }

  const ranked = db
    .with("ranked", (qb) => {
      let inner = qb
        .selectFrom("shelf_files")
        .select([
          "id",
          "machine_id",
          "path_on_machine",
          "created_at",
          "edited_at",
          "sha256",
          sql<number>`octet_length(html)`.as("bytes"),
          familySql.as("family"),
          sql<number>`count(*) over (partition by machine_id, ${familySql})`.as("versions"),
          sql<number>`row_number() over (partition by machine_id, ${familySql} order by ${versionSql} desc, created_at desc, id desc)`.as(
            "rank",
          ),
        ])
        .where("user_id", "=", userId);
      if (family) inner = inner.where("machine_id", "=", family.machine_id);
      else if (machines.length > 0) inner = inner.where("machine_id", "in", machines);
      return inner;
    })
    .selectFrom("ranked");

  let base = ranked;
  if (family) {
    base = base.where("family", "=", family.family);
  } else {
    if (!options.allVersions) base = base.where("rank", "=", 1);
    if (search) {
      const needle = `%${search.replace(/[%_\\]/g, "")}%`;
      // Same rule as `shelf list --search`: a path, its family name or a machine name matches.
      base = base.where((eb) =>
        eb.or([
          eb("path_on_machine", "ilike", needle),
          eb("family", "ilike", needle),
          eb("machine_id", "ilike", needle),
        ]),
      );
    }
  }

  const page = family
    ? base.selectAll().orderBy("rank", "asc")
    : base.selectAll().orderBy(sort, dir).orderBy("id", "asc");
  const [rows, totalRow] = await Promise.all([
    page.offset(offset).limit(options.limit).execute(),
    base.select((eb) => eb.fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
  ]);

  const total = Number(totalRow.count ?? 0);
  const files = rows.map((row) => ({ ...toMeta(row), versions: Number(row.versions) }));
  return { files, total, hasMore: offset + files.length < total };
}

/** The size of `file`'s version family and its newest member (which may be `file`). */
export async function versionInfo(
  db: Kysely<Database>,
  userId: string,
  file: ShelfFileMeta,
): Promise<{ versions: number; latest: { id: string; path: string } }> {
  const { files, total } = await listFiles(db, userId, { versionsOf: file.id, limit: 1 });
  const latest = files[0] ?? file;
  return { versions: Math.max(total, 1), latest: { id: latest.id, path: latest.path } };
}

export async function getFile(
  db: Kysely<Database>,
  userId: string,
  id: string,
): Promise<ShelfFile | null> {
  const row = await db
    .selectFrom("shelf_files")
    .selectAll()
    .where("user_id", "=", userId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  return { ...toMeta(row), bytes: byteLength(row.html), html: row.html };
}

/**
 * Finds a file by id, or by path the way `shelf read <path>` does: an exact
 * path wins, then the shortest path ending in `/<target>`. `machineId` narrows
 * the search when the same path exists on several machines.
 */
export async function resolveFile(
  db: Kysely<Database>,
  userId: string,
  target: string,
  machineId?: string,
): Promise<ShelfFile | null> {
  const found = await resolveMeta(db, userId, target, machineId);
  return found ? getFile(db, userId, found.id) : null;
}

/** `resolveFile` without the html. */
async function resolveMeta(
  db: Kysely<Database>,
  userId: string,
  target: string,
  machineId?: string,
): Promise<{ id: string; machine_id: string; path_on_machine: string } | null> {
  const wanted = normalizePath(target);
  if (!wanted) return null;
  const columns = ["id", "machine_id", "path_on_machine"] as const;
  if (/^sf_[a-f0-9]{20}$/.test(wanted)) {
    const byId = await db
      .selectFrom("shelf_files")
      .select(columns)
      .where("user_id", "=", userId)
      .where("id", "=", wanted)
      .executeTakeFirst();
    if (byId) return byId;
  }

  const suffix = `%/${wanted.replace(/[%_\\]/g, "\\$&")}`;
  let query = db
    .selectFrom("shelf_files")
    .select(columns)
    .where("user_id", "=", userId)
    .where((eb) =>
      eb.or([eb("path_on_machine", "=", wanted), eb("path_on_machine", "like", suffix)]),
    );
  if (machineId) query = query.where("machine_id", "=", machineId);
  const matches = await query
    .orderBy(sql`path_on_machine = ${wanted}`, "desc")
    .orderBy(sql`length(path_on_machine)`, "asc")
    .orderBy("edited_at", "desc")
    .limit(1)
    .execute();
  return matches[0] ?? null;
}

/**
 * Writes with the shelf's path rules (AGENTS.md rule 3), as `shelf write`
 * does: identical bytes are a no-op, an existing path becomes `-v2`, `-v3`, …
 * unless `replace`, and re-sending bytes already in the path's version family
 * does not stack another version unless `asNew`.
 */
export async function writeVersioned(
  db: Kysely<Database>,
  userId: string,
  input: WriteInput,
): Promise<WriteResult> {
  const requestedPath = normalizePath(input.path);
  const badPath = pathError(requestedPath);
  if (badPath) {
    return { ok: false, error: "bad_path", message: badPath, hint: "e.g. reports/q3.html" };
  }
  if (!isValidMachineId(input.machineId)) {
    return { ok: false, error: "bad_machine", message: "bad machine id" };
  }
  if (!input.html.trim()) return { ok: false, error: "empty", message: "html is empty" };
  if (byteLength(input.html) > MAX_HTML_BYTES) {
    return { ok: false, error: "too_large", message: `html is over ${MAX_HTML_BYTES} bytes` };
  }

  const digest = await sha256Hex(input.html);
  const machineId = input.machineId;

  // Every path in the family, so versioning needs one query and no guessing.
  const family = await db
    .selectFrom("shelf_files")
    .select(metaSelect())
    .where("user_id", "=", userId)
    .where("machine_id", "=", machineId)
    .where("path_on_machine", "like", `${familyPrefix(requestedPath)}%`)
    .execute();
  const members = family.filter((row) => familyKey(row.path_on_machine) === familyKey(requestedPath));
  const taken = new Set(members.map((row) => row.path_on_machine));
  const existing = members.find((row) => row.path_on_machine === requestedPath);

  const done = (action: WriteAction, row: MetaInput): WriteResult => ({
    ok: true,
    action,
    requestedPath,
    file: toMeta(row),
  });

  if (existing) {
    if (existing.sha256 === digest) return done("unchanged", existing);
    if (input.replace) {
      const updated = await db
        .updateTable("shelf_files")
        .set({ html: input.html, sha256: digest, edited_at: new Date() })
        .where("user_id", "=", userId)
        .where("id", "=", existing.id)
        .returning(["id", "machine_id", "path_on_machine", "created_at", "edited_at", "sha256"])
        .executeTakeFirstOrThrow();
      return done("replaced", { ...updated, html: input.html });
    }
    if (!input.asNew) {
      const twin = members.find((row) => row.sha256 === digest);
      if (twin) return done("unchanged", twin);
    }
  }

  let path = requestedPath;
  if (existing) {
    for (let attempt = 0; taken.has(path); attempt++) {
      if (attempt >= 200) {
        return { ok: false, error: "no_free_path", message: "could not find a free version" };
      }
      path = nextVersionPath(path);
    }
  }

  const now = new Date();
  const inserted = await db
    .insertInto("shelf_files")
    .values({
      user_id: userId,
      id: fileId(machineId, path),
      machine_id: machineId,
      path_on_machine: path,
      html: input.html,
      sha256: digest,
      created_at: now,
      edited_at: now,
    })
    .onConflict((oc) => oc.doNothing())
    .returning(["id", "machine_id", "path_on_machine", "created_at", "edited_at", "sha256"])
    .executeTakeFirst();
  if (!inserted) {
    // Another writer took the path between the read and the insert.
    return { ok: false, error: "conflict", message: `${path} was just written`, hint: "retry" };
  }
  return done(existing ? "versioned" : "created", { ...inserted, html: input.html });
}

/** LIKE prefix that every member of the path's family starts with. */
function familyPrefix(path: string): string {
  const key = familyKey(path);
  const dot = key.lastIndexOf(".");
  const stem = dot > 0 ? key.slice(0, dot) : key;
  return stem.replace(/[%_\\]/g, "\\$&");
}
