import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { repairUpstreamMcpRuntime } from "../scripts/repair-upstream-mcp-stdio.mjs";

const source = [
  'import { Client } from "@modelcontextprotocol/sdk/client/index.js";',
  'import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";',
  "function configuredUpstreams(config) {",
  "  return config.upstreamMcpServers.flatMap((entry) => {",
  "    try {",
  "      const url = new URL(entry.url);",
  '      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported protocol");',
  '      return [{ name: entry.name, url, enabled: entry.enabled !== false }];',
  "    } catch {",
  "      return [];",
  "    }",
  "  });",
  "}",
  "var stdioUpstreamClients = new Map();",
  "async function withClient(upstream, action, options = {}) {",
  '  const client = new Client({ name: "devspace-upstream-bridge", version: "1.0.0" });',
  "  return action(client);",
  "}",
  "function errorResult(message) { return message; }",
  "async function callConfiguredTool(upstream, toolName, args) {",
  "  return withClient(upstream, (client, requestTimeoutMs) => client.callTool({ name: toolName, arguments: args }, undefined, { timeout: requestTimeoutMs }));",
  "}",
].join("\n");

test("upstream MCP repair enables persistent stdio clients and is idempotent", () => {
  const fixture = mkdtempSync(join(tmpdir(), "devspace-upstream-stdio-"));
  try {
    mkdirSync(join(fixture, "dist"), { recursive: true });
    writeFileSync(join(fixture, "dist/upstream-mcp.js"), source);
    writeFileSync(join(fixture, "dist/hot-modules.mjs"), source);
    repairUpstreamMcpRuntime(fixture);
    const once = ["upstream-mcp.js", "hot-modules.mjs"].map((name) => readFileSync(join(fixture, "dist", name), "utf8"));
    repairUpstreamMcpRuntime(fixture);
    const twice = ["upstream-mcp.js", "hot-modules.mjs"].map((name) => readFileSync(join(fixture, "dist", name), "utf8"));
    assert.deepEqual(twice, once);
    for (const output of once) {
      assert.match(output, /StdioClientTransport/);
      assert.match(output, /transport: "stdio"/);
      assert.match(output, /stdioUpstreamClients/);
      assert.match(output, /callUpstreamMcpTool\(client, upstream, toolName, args, requestTimeoutMs\)/);
      assert.match(output, /upstream\.name !== "rea"/);
      assert.match(output, /client\.cacheToolMetadata\(listed\.tools\)/);
      const file = join(fixture, "check.mjs");
      writeFileSync(file, output);
      const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      assert.equal(checked.status, 0, checked.stderr);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
