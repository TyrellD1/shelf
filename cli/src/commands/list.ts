import { parseMachineList, versionNumber } from "@shelf/shared";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../lib/flags.js";
import type { Output } from "../lib/output.js";
import { UserError } from "../lib/config.js";
import {
  familyOf,
  listEntries,
  loadIndexOrRebuild,
  machines,
  resolveEntry,
  type Entry,
} from "../lib/store.js";
import { relativeTime } from "../lib/writer.js";

export async function listCommand(args: ParsedArgs, output: Output): Promise<void> {
  const index = loadIndexOrRebuild();
  const versionsOf = flagString(args, "--versions-of");
  const family = versionsOf ? resolveEntry(index, versionsOf) : undefined;
  if (versionsOf && !family) {
    throw new UserError(`not found: ${versionsOf}`, "not_found", "shelf list to see what is on the shelf");
  }
  const { files, total, hasMore } = listEntries(index, {
    q: flagString(args, "--search") ?? args.positional[0],
    // `--machine a,b` keeps several machines; the same rule as the Worker's `machine`.
    machines: parseMachineList(flagString(args, "--machine") ?? process.env.SHELF_MACHINE),
    sort: flagString(args, "--sort") === "edited" ? "edited" : "created",
    dir: flagString(args, "--dir") === "asc" ? "asc" : "desc",
    limit: flagNumber(args, "--limit", 20),
    offset: flagNumber(args, "--offset", 0),
    allVersions: flagBool(args, "--all-versions"),
    versionsOf: family,
  });

  const human = files.length
    ? [
        ...files.map(
          (file) =>
            `${relativeTime(file.createdAt).padEnd(10)} ${file.machineId.padEnd(14)} ${file.path}  (${Math.round(file.bytes / 1024)} KB${
              !versionsOf && (file.versions ?? 1) > 1 ? `, ${file.versions} versions` : ""
            })`,
        ),
        `${files.length} of ${total}${hasMore ? " · more available (--limit)" : ""}`,
      ].join("\n")
    : "the shelf is empty";

  output.emit(
    {
      ok: true,
      files,
      total,
      hasMore,
      machines: machines(index),
      lastSyncAt: index.lastSyncAt,
      syncedAt: index.syncedAt ?? null,
    },
    human,
  );
}

export async function readCommand(args: ParsedArgs, output: Output): Promise<void> {
  const target = args.positional[0];
  if (!target) throw new Error("usage: shelf read <id|path> [--meta] [--latest]");

  const index = loadIndexOrRebuild();
  const found = resolveEntry(index, target);
  const family = found ? familyOf(index, found) : [];
  // `--latest`: the newest version of whatever the target names, to build the next one on.
  const entry = flagBool(args, "--latest") ? family[0] : found;

  if (!entry) {
    output.emit({ ok: false, error: `not found: ${target}`, code: "not_found" }, "");
    process.exitCode = 1;
    return;
  }

  const { readHtmlFile, toMeta } = await import("../lib/store.js");
  const meta = { ...toMeta(entry), ...versionInfo(entry, family) };

  if (flagBool(args, "--meta")) {
    const versions = meta.versions > 1 ? ` · ${meta.versions} versions` : "";
    const newer = meta.latest ? ` · newest is ${meta.latest.path}` : "";
    output.emit(
      { ok: true, file: meta },
      `${meta.machineId} ${meta.path} · ${meta.bytes} bytes${versions}${newer}`,
    );
    return;
  }
  if (meta.latest && !output.json) {
    output.progress(`${meta.path} has a newer version: ${meta.latest.path} (read --latest)`);
  }

  const html = readHtmlFile(entry.machineId, entry.pathOnMachine);
  if (html === null) {
    output.emit(
      { ok: false, error: `missing bytes for ${entry.pathOnMachine}`, code: "missing_bytes" },
      "",
    );
    process.exitCode = 1;
    return;
  }

  if (output.json) {
    output.emit({ ok: true, file: { ...meta, html } }, "");
    return;
  }
  process.stdout.write(html);
}

/**
 * Where a file sits in its version family: its `version`, the family size, and
 * the newest version when that is another file, so an agent reading an old
 * version knows to build on the newer one.
 */
function versionInfo(entry: Entry, family: Entry[]) {
  const latest = family[0];
  return {
    version: versionNumber(entry.pathOnMachine),
    versions: family.length,
    ...(latest && latest.id !== entry.id
      ? { latest: { id: latest.id, path: latest.pathOnMachine, version: versionNumber(latest.pathOnMachine) } }
      : {}),
  };
}
