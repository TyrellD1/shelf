import { ApiError, createApi } from "../lib/api.js";
import { requireConfig, UserError } from "../lib/config.js";
import { flagBool, type ParsedArgs } from "../lib/flags.js";
import type { Output } from "../lib/output.js";
import {
  loadIndexOrRebuild,
  pendingPush,
  readHtmlFile,
  saveIndex,
  sha256,
  writeHtmlFile,
} from "../lib/store.js";

/**
 * Push anything this machine wrote and pull what the other machines wrote.
 * Both directions are idempotent: content is compared by sha256, so a re-run
 * after a failure only moves what actually changed.
 */
export async function syncCommand(args: ParsedArgs, output: Output): Promise<void> {
  const config = requireConfig();
  const machineId = config.machineId;
  const api = createApi(config.apiUrl, config.token);
  const index = loadIndexOrRebuild();

  const errors: string[] = [];
  let pushed = 0;
  let pulled = 0;
  let skipped = 0;
  let bytesOut = 0;
  let bytesIn = 0;

  if (!flagBool(args, "--pull-only") && machineId) {
    const queue = pendingPush(index, machineId);
    output.progress(queue.length ? `pushing ${queue.length} file(s)` : "nothing to push");
    for (const entry of queue) {
      const html = readHtmlFile(entry.machineId, entry.pathOnMachine);
      if (html === null) {
        errors.push(`${entry.pathOnMachine}: bytes missing from the local store`);
        continue;
      }
      try {
        const response = await api.write({
          id: entry.id,
          machineId: entry.machineId,
          path: entry.pathOnMachine,
          html,
          replace: true,
        });
        entry.pushedSha = sha256(html);
        entry.bytes = Buffer.byteLength(html, "utf8");
        entry.editedAt = response.file.editedAt;
        pushed += 1;
        bytesOut += entry.bytes;
        output.progress(`pushed ${entry.pathOnMachine}`);
      } catch (error) {
        if (error instanceof ApiError && error.isUnauthorized) {
          throw new UserError(
            "the saved token was rejected (401)",
            "unauthorized",
            "run: shelf setup",
          );
        }
        errors.push(`${entry.pathOnMachine}: ${message(error)}`);
      }
    }
  }

  if (!flagBool(args, "--push-only")) {
    let cursor = index.lastSyncAt;
    let moved = false;
    for (let page = 0; page < 50; page++) {
      const response = await api.changes({ since: cursor, limit: 500 });
      if (response.files.length === 0) break;
      for (const file of response.files) {
        const digest = sha256(file.html);
        const existing = index.entries[file.id];
        const dirtyLocalCopy =
          existing &&
          existing.machineId === machineId &&
          existing.sha256 !== existing.pushedSha &&
          existing.sha256 !== digest;
        if (dirtyLocalCopy) {
          skipped += 1;
          output.progress(`kept local edits for ${file.path}`);
          continue;
        }
        if (existing && existing.sha256 === digest && existing.bytes === file.bytes) {
          skipped += 1;
          continue;
        }
        writeHtmlFile(file.machineId, file.path, file.html);
        index.entries[file.id] = {
          id: file.id,
          machineId: file.machineId,
          pathOnMachine: file.path,
          createdAt: file.createdAt,
          editedAt: file.editedAt,
          bytes: file.bytes,
          sha256: digest,
          pushedSha: digest,
          fetchedAt: new Date().toISOString(),
        };
        pulled += 1;
        bytesIn += file.bytes;
        output.progress(`pulled ${file.path}`);
      }
      if (response.nextSince) {
        cursor = response.nextSince;
        moved = true;
      }
      if (!response.hasMore) break;
    }
    if (moved) index.lastSyncAt = cursor;
  }

  saveIndex(index);

  output.emit(
    {
      ok: true,
      configured: true,
      machineId,
      pushed,
      pulled,
      skipped,
      bytesIn,
      bytesOut,
      lastSyncAt: index.lastSyncAt,
      errors,
    },
    `pushed ${pushed} · pulled ${pulled} · skipped ${skipped}${errors.length ? ` · ${errors.length} error(s)` : ""}`,
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
