import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShelfFileMeta } from "@shelf/shared";
import { discordMessage, notifyNewFile } from "../src/notify.js";

const file: ShelfFileMeta = {
  id: "sf_0123456789abcdef0123",
  machineId: "claude-mcp",
  path: "reports/q3.html",
  createdAt: "2026-10-09T12:00:00.000Z",
  editedAt: "2026-10-09T12:00:00.000Z",
  bytes: 10,
  sha256: "",
};

afterEach(() => vi.unstubAllGlobals());

describe("notifyNewFile", () => {
  it("does nothing when no webhook is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await notifyNewFile({ APP_URL: "https://shelf.test" }, file);
    await notifyNewFile({ APP_URL: "https://shelf.test", DISCORD_WEBHOOK_URL: " " }, file);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the file's name and link to the webhook", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await notifyNewFile({ APP_URL: "https://shelf.test", DISCORD_WEBHOOK_URL: "https://hook.test/x" }, file);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hook.test/x");
    expect(JSON.parse(init.body)).toEqual(discordMessage("https://shelf.test", file));
  });

  it("swallows webhook failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      notifyNewFile({ APP_URL: "https://shelf.test", DISCORD_WEBHOOK_URL: "https://hook.test/x" }, file),
    ).resolves.toBeUndefined();
  });
});

describe("discordMessage", () => {
  it("links the reader and never pings", () => {
    const message = discordMessage("https://shelf.test/", file);
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.embeds[0]).toMatchObject({
      title: "reports/q3.html",
      url: "https://shelf.test/#/f/sf_0123456789abcdef0123",
      footer: { text: "claude-mcp" },
    });
  });
});
