import { isJsonString, type JsonObject } from "./json-value.js";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { writeTestDevspaceConfig } from "./test-support/config.js";

test("Cloudflare Access mode requires a verified assertion on MCP requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-cloudflare-access-"));

  const env = writeTestDevspaceConfig(join(root, "config"), {
    server: { publicBaseUrl: "https://agent.example.com" },
    storage: { stateDir: join(root, "state") },
    workspaces: { allowedRoots: [root] },
    cloudflareAccess: {
      teamDomain: "team.cloudflareaccess.com",
      audience: "expected-access-audience",
    },
    logging: { level: "silent" },
  });

  const config = loadConfig({ DEVSPACE_CONFIG_DIR: env.DEVSPACE_CONFIG_DIR });

  assert.equal(config.oauth, undefined);

  const running = createServer(config, {
    cloudflareAccessVerifier: {
      async verify(assertion) {
        return assertion === "valid-access-assertion"
          ? { sub: "access-user-id", email: "owner@example.com", exp: Math.floor(Date.now() / 1000) + 300 }
          : undefined;
      },
    },
  });

  const listener = running.app.listen(0, "127.0.0.1");

  t.after(async () => {
    await running.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });

  await once(listener, "listening");
  const address = listener.address();

  assert.ok(address && !isJsonString(address));

  const url = `http://127.0.0.1:${address.port}/mcp`;

  const request = (
    method: string,
    params: JsonObject = {},
    headers: Record<string, string> = {},
  ) => fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "access-test", version: "1.0.0" } }
        : params,
    }),
    signal: AbortSignal.timeout(5000),
  });

  assert.equal((await request("initialize")).status, 401);
  assert.equal((await request("initialize", {}, { "Cf-Access-Jwt-Assertion": "invalid-access-assertion" })).status, 401);
  assert.equal((await request("initialize", {}, { Authorization: "Bearer anything" })).status, 401);

  const accepted = await request("initialize", {}, { "Cf-Access-Jwt-Assertion": "valid-access-assertion" });
  assert.equal(accepted.status, 200, await accepted.text());

  const listed = await request("tools/list", {}, { "Cf-Access-Jwt-Assertion": "valid-access-assertion" });
  assert.equal(listed.status, 200, await listed.clone().text());
  assert.match(await listed.text(), /"tools"/);
});

test("Cloudflare Access MCP CORS preflight permits the assertion header", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-cloudflare-cors-"));

  const env = writeTestDevspaceConfig(join(root, "config"), {
    storage: { stateDir: join(root, "state") },
    cloudflareAccess: {
      teamDomain: "team.cloudflareaccess.com",
      audience: "expected-access-audience",
    },
    logging: { level: "silent" },
  });

  const running = createServer(loadConfig({ DEVSPACE_CONFIG_DIR: env.DEVSPACE_CONFIG_DIR }), {
    cloudflareAccessVerifier: { async verify() { return undefined; } },
  });

  const listener = running.app.listen(0, "127.0.0.1");

  t.after(async () => {
    await running.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });

  await once(listener, "listening");
  const address = listener.address();

  assert.ok(address && !isJsonString(address));

  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: "OPTIONS",
    headers: { "Access-Control-Request-Headers": "content-type, cf-access-jwt-assertion" },
  });

  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers") ?? "", /Cf-Access-Jwt-Assertion/i);
});
