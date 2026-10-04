#!/usr/bin/env node
// End-to-end check of the MCP endpoint, playing claude.ai's part: discovery,
// client registration, sign-in, consent, token exchange, refresh, then the
// list / read / write tools. Runs against a local Worker (see scripts/smoke.sh).
//
//   node scripts/smoke-mcp.mjs <api-url> <email> <password> [tag]
//
// It writes smoke/mcp-<tag>.html under the `mcp` machine.

import { createHash, randomBytes } from "node:crypto";
import http1 from "node:http";
import https from "node:https";

const [API = "http://localhost:8787", EMAIL, PASSWORD, TAG = String(process.pid)] = process.argv.slice(2);
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const MCP = `${API}/mcp`;
let pass = 0;
let fail = 0;

function check(desc, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${desc}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${desc}${detail ? `\n      ${String(detail).slice(0, 400)}` : ""}`);
  }
  return condition;
}

// The browser's cookie jar; only browser steps send it, as on claude.ai.
const cookies = new Map();

function remember(setCookies) {
  for (const line of setCookies ?? []) {
    const [pair] = line.split(";");
    const at = pair.indexOf("=");
    cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
}

/** A server-to-server call, as claude.ai's backend makes them: no cookies. */
function http(url, init = {}) {
  return fetch(new URL(url, API), { ...init, redirect: "manual" });
}

/**
 * A top-level browser navigation. Node's fetch always claims
 * `sec-fetch-mode: cors`, which Better Auth answers with JSON instead of a
 * redirect, so browser steps go through node:http with the headers a browser sends.
 */
function navigate(url, init = {}) {
  const target = new URL(url, API);
  const headers = { accept: "text/html", "sec-fetch-mode": "navigate", ...init.headers };
  if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const body = init.body === undefined ? undefined : String(init.body);
  if (body !== undefined) headers["content-length"] = Buffer.byteLength(body);
  const client = target.protocol === "https:" ? https : http1;
  return new Promise((resolve, reject) => {
    const req = client.request(target, { method: init.method ?? "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        remember(res.headers["set-cookie"]);
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          ok: (res.statusCode ?? 0) < 400,
          headers: { get: (name) => res.headers[name.toLowerCase()] ?? null },
          text: async () => text,
        });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const base64url = (buffer) => Buffer.from(buffer).toString("base64url");

let rpcId = 0;
async function rpc(token, method, params) {
  const response = await http(MCP, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await response.text();
  const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("data: ").pop());
  return { status: response.status, json };
}

async function tool(token, name, args) {
  const { json } = await rpc(token, "tools/call", { name, arguments: args });
  const content = json.result?.content ?? [];
  return { isError: Boolean(json.result?.isError), content, data: safeJson(content[0]?.text), raw: json };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

console.log("\n\x1b[1mmcp: discovery\x1b[0m");
const anonymous = await http(MCP, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
const challenge = anonymous.headers.get("www-authenticate") ?? "";
check("an unauthenticated call gets 401", anonymous.status === 401, anonymous.status);
const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
check("the 401 points at protected resource metadata", Boolean(metadataUrl), challenge);

const resourceMeta = await (await http(metadataUrl)).json();
check("its resource is the MCP url", resourceMeta.resource === MCP, JSON.stringify(resourceMeta));
const issuer = resourceMeta.authorization_servers?.[0];
const issuerPath = new URL(issuer).pathname.replace(/\/$/, "");
const asMeta = await (await http(`/.well-known/oauth-authorization-server${issuerPath}`)).json();
check("authorization server metadata is served", asMeta.issuer === issuer, JSON.stringify(asMeta));
check("it supports S256 PKCE", asMeta.code_challenge_methods_supported?.includes("S256"));
check("it allows registration", Boolean(asMeta.registration_endpoint));

console.log("\n\x1b[1mmcp: registration\x1b[0m");
const register = (redirectUris) =>
  http(asMeta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
const refused = await register(["https://evil.example/callback"]);
check("a client with someone else's callback is refused", refused.status === 400, refused.status);
const registered = await register([CALLBACK]);
const client = await registered.json();
check("claude.ai's callback registers", Boolean(client.client_id), JSON.stringify(client));

console.log("\n\x1b[1mmcp: sign-in and consent\x1b[0m");
const verifier = base64url(randomBytes(32));
const state = base64url(randomBytes(12));
const authorize = new URL(asMeta.authorization_endpoint);
authorize.search = new URLSearchParams({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: CALLBACK,
  code_challenge: base64url(createHash("sha256").update(verifier).digest()),
  code_challenge_method: "S256",
  state,
  resource: MCP,
  scope: "offline_access",
}).toString();

let step = await navigate(authorize);
let location = step.headers.get("location") ?? "";
check("signed out, authorize sends you to /oauth/login", location.includes("/oauth/login?"), `${step.status} ${location}`);
step = await navigate(location);
location = step.headers.get("location") ?? "";
check("which hands over to the app's /login with next", location.includes("/login?next="), location);
const next = new URL(location, API).searchParams.get("next");

const signIn = await navigate("/api/auth/sign-in/email", {
  method: "POST",
  headers: { "content-type": "application/json", origin: API },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
check("sign-in works", signIn.ok, signIn.status);

step = await navigate(next);
location = step.headers.get("location") ?? "";
check("next replays authorize and reaches consent", location.includes("/oauth/consent?"), `${step.status} ${location}`);
const consentPage = await navigate(location);
const consentHtml = await consentPage.text();
check("the consent page names the app and where it returns", consentHtml.includes("Claude") && consentHtml.includes("claude.ai"), consentHtml.slice(0, 300));
const oauthQuery = /name="oauth_query" value="([^"]+)"/.exec(consentHtml)?.[1]?.replace(/&amp;/g, "&");

const allow = await navigate("/oauth/consent", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: API },
  body: new URLSearchParams({ oauth_query: oauthQuery ?? "", accept: "yes" }),
});
const callback = new URL(allow.headers.get("location") ?? "about:blank");
check("Allow returns to claude.ai with a code", callback.href.startsWith(CALLBACK) && callback.searchParams.get("code"), `${allow.status} ${callback.href} ${allow.status >= 400 ? (await allow.text()).replace(/[\s\S]*<h1>/, "") : ""}`);
check("and the original state", callback.searchParams.get("state") === state);

console.log("\n\x1b[1mmcp: tokens\x1b[0m");
const exchange = await http(asMeta.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: callback.searchParams.get("code") ?? "",
    code_verifier: verifier,
    redirect_uri: CALLBACK,
    client_id: client.client_id,
    resource: MCP,
  }),
});
const tokens = await exchange.json();
check("the code exchanges for an access token", Boolean(tokens.access_token), JSON.stringify(tokens));
check("and a refresh token", Boolean(tokens.refresh_token));

const refreshed = await (
  await http(asMeta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
      client_id: client.client_id,
      resource: MCP,
    }),
  })
).json();
check("the refresh token rotates", Boolean(refreshed.access_token && refreshed.refresh_token), JSON.stringify(refreshed));
const token = refreshed.access_token ?? tokens.access_token;

console.log("\n\x1b[1mmcp: tools\x1b[0m");
const init = await rpc(token, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke", version: "1" },
});
check("initialize answers", init.json.result?.serverInfo?.name === "shelf", JSON.stringify(init.json));
check("with one line of instructions", (init.json.result?.instructions ?? "").split("\n").length === 1);
const listed = await rpc(token, "tools/list", {});
const names = (listed.json.result?.tools ?? []).map((t) => t.name).sort();
check("tools are list, read, write", names.join(",") === "list,read,write", JSON.stringify(listed.json));

const path = `smoke/mcp-${TAG}.html`;
const html = `<!doctype html><title>smoke ${TAG}</title><p>one</p>`;
let result = await tool(token, "write", { path, html });
check("write creates", result.data?.action === "created" && result.data?.path === path, JSON.stringify(result.raw));
check("under the mcp machine", result.data?.machine === "mcp");
const id = result.data?.id;
result = await tool(token, "write", { path, html });
check("the same bytes again are a no-op", result.data?.action === "unchanged", JSON.stringify(result.data));
result = await tool(token, "write", { path, html: html.replace("one", "two") });
check("new bytes become -v2", result.data?.action === "versioned" && result.data?.path.endsWith("-v2.html"), JSON.stringify(result.data));
result = await tool(token, "write", { path, html: html.replace("one", "two") });
check("re-sending -v2's bytes does not stack a -v3", result.data?.action === "unchanged", JSON.stringify(result.data));
result = await tool(token, "write", { path, html: html.replace("one", "three"), replace: true });
check("replace overwrites in place", result.data?.action === "replaced" && result.data?.path === path, JSON.stringify(result.data));
result = await tool(token, "write", { path: "/etc/passwd", html });
check("a bad path is an error with a hint", result.isError && result.data?.code === "bad_path" && Boolean(result.data?.hint), JSON.stringify(result.data));

result = await tool(token, "list", { search: `mcp-${TAG}` });
check("list finds both versions", result.data?.total === 2, JSON.stringify(result.data));
check("list carries no html", !JSON.stringify(result.data).includes("<p>"));
result = await tool(token, "read", { file: id });
check("read by id returns the html", result.content[1]?.text?.includes("three"), JSON.stringify(result.raw).slice(0, 300));
result = await tool(token, "read", { file: `mcp-${TAG}.html` });
check("read by path suffix finds it", result.data?.id === id, JSON.stringify(result.data));
result = await tool(token, "read", { file: id, meta: true });
check("read meta has no html", result.content.length === 1 && Boolean(result.data?.url), JSON.stringify(result.raw));
result = await tool(token, "read", { file: "nope.html" });
check("a missing file is an error", result.isError && result.data?.code === "not_found");

const forged = await rpc(`${token.slice(0, -4)}AAAA`, "tools/list", {});
check("a tampered token is refused", forged.status === 401, forged.status);

console.log(`\nmcp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
