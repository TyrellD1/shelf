import { flagBool, type ParsedArgs } from "../lib/flags.js";
import { UserError } from "../lib/config.js";
import { deepLink, findAppBundle, openPath, openUrl } from "../lib/launch.js";
import type { Output } from "../lib/output.js";
import { htmlPath } from "../lib/store.js";
import { toMeta, writeToShelf } from "../lib/writer.js";

/**
 * `shelf open <path>` — write the file if it is not on the shelf yet, then open
 * it in the desktop app (falling back to the default browser).
 */
export async function openCommand(args: ParsedArgs, output: Output): Promise<void> {
  const input = args.positional[0];
  if (!input) {
    throw new UserError("usage: shelf open <path.html>", "usage", "shelf open ./report.html");
  }

  const outcome = await writeToShelf({
    inputPath: input,
    asNew: true,
    push: !flagBool(args, "--no-push"),
    output,
  });

  for (const warning of outcome.warnings) output.warn(warning);

  const forceBrowser = flagBool(args, "--browser");
  const app = findAppBundle();
  let openedIn: "app" | "browser" = "browser";

  if (!forceBrowser && app) {
    try {
      await openUrl(deepLink(outcome.entry.id));
      openedIn = "app";
    } catch (error) {
      output.warn(`could not open the desktop app: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (openedIn === "browser") {
    await openPath(htmlPath(outcome.entry.machineId, outcome.entry.pathOnMachine));
  }

  output.emit(
    {
      ok: true,
      action: outcome.action,
      path: outcome.path,
      file: toMeta(outcome.entry),
      pushed: outcome.pushed,
      openedIn,
      appInstalled: Boolean(app),
    },
    `opened ${outcome.path} in ${openedIn === "app" ? "Shelf" : "your browser"}`,
  );
}
