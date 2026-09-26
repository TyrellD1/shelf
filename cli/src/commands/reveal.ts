import { flagBool, type ParsedArgs } from "../lib/flags.js";
import { UserError } from "../lib/config.js";
import { openPath } from "../lib/launch.js";
import type { Output } from "../lib/output.js";
import { entryById, htmlPath, loadIndexOrRebuild, toMeta, type Entry } from "../lib/store.js";

/**
 * `shelf reveal <id|path>` — open the shelf's own copy of a file in the default
 * browser. `--print` resolves the path without opening anything.
 *
 * Nothing is written and nothing is pushed: this is for looking at the bytes
 * that are on the shelf right now. Unlike `shelf open`, which runs the input
 * through the writer and can create a new version, this never touches the
 * store — so it is safe to bind to a button in a reader.
 *
 * The file is served straight from disk, so it shows the artifact exactly as it
 * was written, with none of the desktop app's theme injection.
 */
export async function revealCommand(args: ParsedArgs, output: Output): Promise<void> {
  const target = args.positional[0];
  if (!target) {
    throw new UserError("usage: shelf reveal <id|path> [--print]", "usage", "shelf reveal report.html");
  }

  const entry = resolveEntry(target);
  if (!entry) {
    output.emit({ ok: false, error: `not found: ${target}`, code: "not_found" }, "");
    process.exitCode = 1;
    return;
  }

  const path = htmlPath(entry.machineId, entry.pathOnMachine);
  const printOnly = flagBool(args, "--print");

  if (!printOnly) {
    try {
      await openPath(path);
    } catch (error) {
      output.warn(`could not open your browser: ${error instanceof Error ? error.message : error}`);
    }
  }

  output.emit(
    {
      ok: true,
      path: entry.pathOnMachine,
      file: toMeta(entry),
      localPath: path,
      opened: !printOnly,
    },
    printOnly ? path : `opened the shelf's copy of ${entry.pathOnMachine} in your browser`,
  );
}

/** Same lookup rules as `shelf read`: a file id, or a path (or path suffix). */
function resolveEntry(target: string): Entry | undefined {
  const index = loadIndexOrRebuild();
  const byId = entryById(index, target);
  if (byId) return byId;

  const wanted = target.replace(/^\.\//, "");
  return Object.values(index.entries).find(
    (candidate) =>
      candidate.pathOnMachine === wanted || candidate.pathOnMachine.endsWith(`/${wanted}`),
  );
}
