import { flagBool, flagNumber, flagString, type ParsedArgs } from "../lib/flags.js";
import type { Output } from "../lib/output.js";
import { listEntries, loadIndexOrRebuild, machines } from "../lib/store.js";
import { relativeTime } from "../lib/writer.js";

export async function listCommand(args: ParsedArgs, output: Output): Promise<void> {
  const index = loadIndexOrRebuild();
  const { files, total, hasMore } = listEntries(index, {
    q: flagString(args, "--search") ?? args.positional[0],
    machine: flagString(args, "--machine") ?? process.env.SHELF_MACHINE,
    sort: flagString(args, "--sort") === "edited" ? "edited" : "created",
    dir: flagString(args, "--dir") === "asc" ? "asc" : "desc",
    limit: flagNumber(args, "--limit", 20),
    offset: flagNumber(args, "--offset", 0),
  });

  const human = files.length
    ? [
        ...files.map(
          (file) =>
            `${relativeTime(file.createdAt).padEnd(10)} ${file.machineId.padEnd(14)} ${file.path}  (${Math.round(file.bytes / 1024)} KB)`,
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
    },
    human,
  );
}

export async function readCommand(args: ParsedArgs, output: Output): Promise<void> {
  const target = args.positional[0];
  if (!target) throw new Error("usage: shelf read <id|path> [--meta]");

  const index = loadIndexOrRebuild();
  const entry =
    index.entries[target] ??
    Object.values(index.entries).find(
      (candidate) =>
        candidate.pathOnMachine === target.replace(/^\.\//, "") ||
        candidate.pathOnMachine.endsWith(`/${target.replace(/^\.\//, "")}`),
    );

  if (!entry) {
    output.emit({ ok: false, error: `not found: ${target}`, code: "not_found" }, "");
    process.exitCode = 1;
    return;
  }

  const { readHtmlFile, toMeta } = await import("../lib/store.js");
  const meta = toMeta(entry);

  if (flagBool(args, "--meta")) {
    output.emit({ ok: true, file: meta }, `${meta.machineId} ${meta.path} · ${meta.bytes} bytes`);
    return;
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
