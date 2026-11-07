import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { repairDesktopRuntime } from "../scripts/repair-desktop-runtime.mjs";

test("desktop runtime repair is idempotent and leaves valid JavaScript", () => {
  const fixture = mkdtempSync(join(tmpdir(), "devspace-desktop-repair-"));

  try {
    mkdirSync(join(fixture, "dist/modules"), { recursive: true });
    writeFileSync(join(fixture, "dist/computer-use-session.js"), `class Session {
    async start(options = {}) {
        const existing = await this.refresh();
        if (existing.state === "ready" && existing.mode !== "host-fallback") {
            return existing;
        }
    }
    launch(runtimeDir, outerWayland) {
        return {
            env: {
                ...process.env,
                XDG_RUNTIME_DIR: runtimeDir,
                ...(outerWayland ? { WAYLAND_DISPLAY: outerWayland } : {}),
            },
        };
    }
    restore(parsed) {
        this.indicatorState = parsed.state;
    }
}
`);
    writeFileSync(join(fixture, "dist/hot-modules.mjs"), `class Session {
  async start(options = {}) {
    const existing = await this.refresh();
    if (existing.state === "ready" && existing.mode !== "host-fallback") {
      return existing;
    }
  }
  launch(runtimeDir, outerWayland) {
    return {
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: runtimeDir,
        ...outerWayland ? { WAYLAND_DISPLAY: outerWayland } : {},
      },
    };
  }
  restore(parsed) {
    this.indicatorState = parsed.state;
  }
}
const description = "Allow the legacy live-desktop path if the isolated compositor cannot start. Defaults to false for safe concurrent use.";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
function configuredUpstreams(config) {
  return config.upstreamMcpServers.flatMap((entry) => {
    try {
      const url = new URL(entry.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported protocol");
      return [{ name: entry.name, url, enabled: entry.enabled !== false }];
    } catch {
      return [];
    }
  });
}
var stdioUpstreamClients = new Map();
async function withClient(upstream, action, options = {}) {
  const client = new Client({ name: "devspace-upstream-bridge", version: "1.0.0" });
  return action(client);
}
function errorResult(message) { return message; }
`);
    writeFileSync(join(fixture, "dist/modules/desktop-agent.js"), `const description = "Allow the legacy live-desktop path if the isolated compositor cannot start. Defaults to false for safe concurrent use.";
`);

    writeFileSync(join(fixture, "dist/upstream-mcp.js"), [
      'import { Client } from "@modelcontextprotocol/sdk/client/index.js";',
      'import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";',
      "function configuredUpstreams(config) {",
      "    return config.upstreamMcpServers.flatMap((entry) => {",
      "        try {",
      "            const url = new URL(entry.url);",
      '            if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported protocol");',
      '            return [{ name: entry.name, url, enabled: entry.enabled !== false }];',
      "        }",
      "    });",
      "}",
      "var stdioUpstreamClients = new Map();",
      "async function withClient(upstream, action, options = {}) {",
      '    const client = new Client({ name: "devspace-upstream-bridge", version: "1.0.0" });',
      "    return action(client);",
      "}",
      "function errorResult(message) { return message; }",
    ].join("\n"));

    repairDesktopRuntime(fixture);

    const once = [
      readFileSync(join(fixture, "dist/computer-use-session.js"), "utf8"),
      readFileSync(join(fixture, "dist/hot-modules.mjs"), "utf8"),
      readFileSync(join(fixture, "dist/modules/desktop-agent.js"), "utf8"),
    ];

    repairDesktopRuntime(fixture);

    const twice = [
      readFileSync(join(fixture, "dist/computer-use-session.js"), "utf8"),
      readFileSync(join(fixture, "dist/hot-modules.mjs"), "utf8"),
      readFileSync(join(fixture, "dist/modules/desktop-agent.js"), "utf8"),
    ];

    assert.deepEqual(twice, once, "a second repair must make no additional edits");
    assert.match(once[0], /delete env\.WAYLAND_DISPLAY/);
    assert.match(once[0], /Physical desktop observation mode selected explicitly/);
    assert.match(once[0], /this\.active \|\| this\.readSessionMetadata\(\)/);
    assert.match(once[0], /parsed\.sessionState === "ready" && parsed\.mode === "host-fallback"/);
    assert.match(once[2], /selection persists until stopped or switched to isolated mode/i);

    for (const path of [
      join(fixture, "dist/computer-use-session.js"),
      join(fixture, "dist/hot-modules.mjs"),
      join(fixture, "dist/modules/desktop-agent.js"),
    ]) {
      const checked = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
      assert.equal(checked.status, 0, checked.stderr || `node --check failed for ${path}`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
