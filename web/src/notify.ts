import { fileUrl, type ShelfFileMeta } from "@shelf/shared";
import type { Env } from "./env.js";

/**
 * Posts a short "new on the shelf" message to Discord when a write adds a
 * file, whoever wrote it (CLI over REST, or claude.ai over MCP). Off unless
 * `DISCORD_WEBHOOK_URL` is set. Never throws: a notification must not fail a write.
 */
export async function notifyNewFile(
  env: Pick<Env, "APP_URL" | "DISCORD_WEBHOOK_URL">,
  file: ShelfFileMeta,
): Promise<void> {
  const webhook = env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhook) return;
  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(discordMessage(env.APP_URL, file)),
    });
    if (!response.ok) console.error("shelf: discord webhook", response.status);
  } catch (error) {
    console.error("shelf: discord webhook", error instanceof Error ? error.message : String(error));
  }
}

export function discordMessage(appUrl: string, file: ShelfFileMeta) {
  return {
    // Paths are user text: never let one ping anyone.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: file.path,
        url: fileUrl(appUrl, file.id),
        description: "New on the shelf",
        footer: { text: file.machineId },
        timestamp: file.createdAt,
      },
    ],
  };
}
