import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../lib/config.js";
import { flagBool, type ParsedArgs } from "../lib/flags.js";
import { shelfBinaryPath } from "../lib/launch.js";
import type { Output } from "../lib/output.js";
import { VERSION } from "../lib/version.js";

const REPO = process.env.SHELF_REPO ?? "TyrellD1/shelf";

interface Release {
  tag_name?: string;
  assets?: { name: string; browser_download_url: string }[];
}

/** Replaces the installed CLI with the latest GitHub release artifact. */
export async function upgradeCommand(args: ParsedArgs, output: Output): Promise<void> {
  const target = process.argv[1] ?? "";
  const release = await fetchRelease();
  const latest = (release.tag_name ?? "").replace(/^v/, "");
  const updateAvailable = Boolean(latest) && latest !== VERSION;

  if (flagBool(args, "--check") || !updateAvailable) {
    output.emit(
      { ok: true, current: VERSION, latest: latest || VERSION, updateAvailable },
      updateAvailable
        ? `${VERSION} → ${latest} available. Run: shelf upgrade`
        : `${VERSION} is up to date`,
    );
    return;
  }

  if (!target.endsWith(".cjs")) {
    throw new UserError(
      "this shelf was not installed from a release",
      "not_release_build",
      "update the checkout instead: git pull && npm run build",
    );
  }

  const asset = release.assets?.find((candidate) => candidate.name === "shelf.cjs");
  if (!asset) throw new UserError(`release ${latest} has no shelf.cjs asset`, "no_asset");

  const scratch = mkdtempSync(join(tmpdir(), "shelf-upgrade-"));
  const next = join(scratch, "shelf.cjs");
  const response = await fetch(asset.browser_download_url);
  if (!response.ok) throw new UserError(`download failed: HTTP ${response.status}`, "download_failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(next, bytes);

  const sums = release.assets?.find((candidate) => candidate.name === "SHA256SUMS");
  if (sums) {
    const sumsResponse = await fetch(sums.browser_download_url);
    const text = await sumsResponse.text();
    const expected = text
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts[1] === "shelf.cjs")?.[0];
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (expected && expected !== actual) {
      throw new UserError("checksum mismatch — upgrade aborted", "checksum_mismatch");
    }
  }

  chmodSync(next, 0o755);
  const resolved = existsSync(target) ? target : shelfBinaryPath();
  renameSync(next, resolved);

  output.emit(
    { ok: true, current: VERSION, latest, path: resolved, bytes: bytes.length },
    `upgraded ${VERSION} → ${latest} (${resolved})`,
  );
}

async function fetchRelease(): Promise<Release> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "shelf-cli" },
  });
  if (!response.ok) {
    throw new UserError(
      `could not read the latest release from ${REPO} (HTTP ${response.status})`,
      "release_lookup_failed",
    );
  }
  return (await response.json()) as Release;
}

export function releaseAssetName(): string {
  return "shelf.cjs";
}

export { REPO };
