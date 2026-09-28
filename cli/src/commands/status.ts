import { flagBool, type ParsedArgs } from "../lib/flags.js";
import { createApi } from "../lib/api.js";
import { isValidMachineId } from "@shelf/shared";
import { loadConfig, saveConfig, shelfHome, UserError } from "../lib/config.js";
import type { Output } from "../lib/output.js";
import { loadIndexOrRebuild, machines, pendingPush, renameMachine, saveIndex } from "../lib/store.js";
import { sanitizeHostname } from "./setup.js";
import { hostname } from "node:os";
import { shelfBinaryPath } from "../lib/launch.js";

export async function statusCommand(args: ParsedArgs, output: Output): Promise<void> {
  const config = loadConfig();
  const index = loadIndexOrRebuild();
  const machineId = config?.machineId ?? sanitizeHostname(hostname());
  const entries = Object.values(index.entries);
  const pending = config ? pendingPush(index, machineId).length : 0;

  let remoteReachable: boolean | null = null;
  if (config?.token && flagBool(args, "--check")) {
    try {
      await createApi(config.apiUrl, config.token).health();
      remoteReachable = true;
    } catch {
      remoteReachable = false;
    }
  }

  const payload = {
    ok: true,
    configured: Boolean(config?.token),
    apiUrl: config?.apiUrl ?? null,
    user: config?.user ?? null,
    machineId: config?.machineId ?? null,
    fileCount: entries.length,
    localCount: entries.filter((entry) => entry.machineId === machineId).length,
    pending,
    lastSyncAt: index.lastSyncAt,
    machines: machines(index),
    home: shelfHome(),
    cliPath: shelfBinaryPath(),
    cliVersion: SHELF_VERSION,
    remoteReachable,
    error: config?.token ? undefined : "run shelf setup",
  };

  const human = [
    `home:      ${payload.home}`,
    `cli:       ${payload.cliVersion} (${payload.cliPath})`,
    `account:   ${config?.user?.email ?? "not signed in"}`,
    `api:       ${config?.apiUrl ?? "not configured"}`,
    `machine:   ${payload.machineId ?? "not set"}`,
    `files:     ${payload.fileCount} on this device (${payload.localCount} from ${payload.machineId})`,
    `pending:   ${payload.pending} to push`,
    `last sync: ${payload.lastSyncAt ? new Date(payload.lastSyncAt).toLocaleString() : "never"}`,
    ...(payload.machines.length
      ? [
          "machines:",
          ...payload.machines.map(
            (machine) => `  ${machine.machineId.padEnd(16)} ${machine.count} file(s)`,
          ),
        ]
      : []),
  ].join("\n");

  output.emit(payload, human);
}

export async function machineCommand(args: ParsedArgs, output: Output): Promise<void> {
  const config = loadConfig();
  if (!config) throw new UserError("not set up yet", "not_configured", "run: shelf setup");
  const index = loadIndexOrRebuild();
  const action = args.positional[0];
  const value = args.positional[1] ?? args.positional[0];

  if (action === "set") {
    if (!value || !isValidMachineId(value)) {
      throw new UserError(
        `invalid machine id: ${value ?? "(missing)"}`,
        "bad_machine_id",
        "lowercase letters, digits and dashes",
      );
    }
    saveConfig({ ...config, machineId: value });
    output.emit(
      { ok: true, machineId: value },
      `machine id is now ${value}\nFiles already on this device stay where they are; \`shelf machine rename\` moves them.`,
    );
    return;
  }

  if (action === "rename") {
    // `machine rename <to>` renames this machine; `<from> <to>` adopts another's files.
    const first = args.positional[1];
    const second = args.positional[2];
    const from = second ? first : config.machineId;
    const to = second ?? first;
    for (const [label, id] of [
      ["from", from],
      ["to", to],
    ] as const) {
      if (!id || !isValidMachineId(id)) {
        throw new UserError(
          `invalid ${label} machine id: ${id ?? "(missing)"}`,
          "bad_machine_id",
          "usage: shelf machine rename <id> | <from> <to> — lowercase letters, digits and dashes",
        );
      }
    }

    const summary = renameMachine(index, from, to);
    // The pull cursor belonged to the old identity, so it means nothing now.
    index.lastSyncAt = null;
    saveIndex(index);
    if (config.machineId !== to) saveConfig({ ...config, machineId: to });

    for (const file of summary.versioned) {
      output.warn(`${file.from} already existed on ${to} — kept as ${file.to}`);
    }
    for (const file of summary.missing) {
      output.warn(`${file}: bytes missing from the store, left under ${from}`);
    }

    const human = summary.renamed
      ? [
          `renamed ${summary.renamed} file(s): ${from} → ${to}`,
          summary.missing.length ? `${summary.missing.length} left behind (no bytes)` : null,
          "nothing has been pushed yet — run: shelf sync",
        ]
          .filter(Boolean)
          .join("\n")
      : `nothing to rename from ${from}${from === to ? " (that is already this machine)" : ""}`;

    output.emit(
      {
        ok: true,
        from,
        to,
        renamed: summary.renamed,
        versioned: summary.versioned,
        missing: summary.missing,
        cursorReset: true,
        machineId: to,
        machines: machines(index),
      },
      human,
    );
    return;
  }

  output.emit(
    {
      ok: true,
      machineId: config.machineId,
      hostname: sanitizeHostname(hostname()),
      machines: machines(index),
    },
    [`machine id: ${config.machineId}`, `hostname:   ${sanitizeHostname(hostname())}`].join("\n"),
  );
}

export async function logoutCommand(_args: ParsedArgs, output: Output): Promise<void> {
  const config = loadConfig();
  if (!config) throw new UserError("not set up yet", "not_configured");
  const { saveConfig } = await import("../lib/config.js");
  saveConfig({ ...config, token: "", user: null });
  output.emit(
    { ok: true, apiUrl: config.apiUrl, machineId: config.machineId },
    `signed out of ${config.apiUrl}\nLocal files are untouched. Run shelf setup to authorize again (it rotates this machine's key).`,
  );
}
