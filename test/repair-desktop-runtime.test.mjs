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
    mkdirSync(join(fixture, "dist/bin"), { recursive: true });
    writeFileSync(join(fixture, "dist/bin/devspace-accessibility-helper.py"), `import argparse
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

def snapshot(args):
    desktop = Atspi.get_desktop(0)
    return {"desktop": desktop}

def perform_action(args):
    return {"performed": True}
`);
    writeFileSync(join(fixture, "dist/computer-use-session.js"), `const existsSync = () => true;
class Session {
    constructor(hostClient, stateDir) {
        this.hostClient = hostClient ?? new DesktopAgentClient({ stateDir });
    }
    async start(options = {}) {
        const existing = await this.refresh();
        if (existing.state === "ready" && existing.mode !== "host-fallback") {
            return existing;
        }
    }
    async refresh() {
        if (this.mode === "host-fallback" && this.state === "ready")
            return this.snapshot();
        return this.snapshot();
    }
    async stop() {
        this.state = "stopped";
    }
    async agentInput(request) {
        await this.ensureIsolatedForInteraction();
    }
    takeUserControl() {}
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
    writeIndicator(state) {
        this.indicatorState = state;
    }
}
`);
    writeFileSync(join(fixture, "dist/hot-modules.mjs"), `const existsSync4 = () => true;
class Session {
  constructor(hostClient, stateDir) {
    this.hostClient = hostClient ?? new DesktopAgentClient({ stateDir });
  }
  async start(options = {}) {
    const existing = await this.refresh();
    if (existing.state === "ready" && existing.mode !== "host-fallback") {
      return existing;
    }
  }
  async refresh() {
    if (this.mode === "host-fallback" && this.state === "ready") return this.snapshot();
    return this.snapshot();
  }
  async stop() {
    this.state = "stopped";
  }
  async agentInput(request2) {
    await this.ensureIsolatedForInteraction();
  }
  takeUserControl() {}
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
  writeIndicator(state) {
    this.indicatorState = state;
  }
}
const description = "Allow the legacy live-desktop path if the isolated compositor cannot start. Defaults to false for safe concurrent use.";
const hostClient = new DesktopAgentClient({ stateDir: config.stateDir });
registerAppTool4(server, "computer_use_start", {
  title: "Start Isolated Computer Use",
  description: "Start a nested KDE/Wayland desktop dedicated to DevSpace Computer Use. Apps, screenshots, accessibility, clipboard, mouse, and keyboard operations then target that isolated desktop so the user can keep using their normal desktop. Windowed sessions can start visible or minimized in the background and can be shown/hidden later without stopping the work. True headless mode has no attachable viewer. If isolation cannot start, host fallback is allowed only when requested.",
  inputSchema: {
    allowHostFallback: z5.boolean().optional().describe("Select the physical KDE desktop for read-only observation. This selection persists until stopped or switched to isolated mode. Mouse and keyboard actions still use the isolated desktop."),
  },
}, async (input) => computerUse.start({
  allowHostFallback: input.allowHostFallback ?? false,
  indicator: input.indicator,
}));
registerAppTool4(server, "computer_use_stop", {}, async () => computerUse.stop());
registerAppTool4(server, "agent_desktop_stop", {}, async () => computerUse.stop());
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
    writeFileSync(join(fixture, "dist/modules/desktop-agent.js"), `const hostClient = new DesktopAgentClient({ stateDir: config.stateDir });
const description = "Allow the legacy live-desktop path if the isolated compositor cannot start. Defaults to false for safe concurrent use.";
registerAppTool(server, "computer_use_start", {
  inputSchema: {
    allowHostFallback: z.boolean().optional().describe("Select the physical KDE desktop for read-only observation. This selection persists until stopped or switched to isolated mode. Mouse and keyboard actions still use the isolated desktop."),
  },
}, async (input) => {
  const computer = await computerUse.start({
    allowHostFallback: input.allowHostFallback ?? false,
    indicator: input.indicator,
  });
});
registerAppTool(server, "computer_use_stop", {}, async () => computerUse.stop());
registerAppTool(server, "agent_desktop_stop", {}, async () => computerUse.stop());
`);
    writeFileSync(join(fixture, "dist/desktop-agent-daemon.js"), `        this.inputProvider = options.input ?? createYdotoolInputProvider({ now: options.now });\n`);
    writeFileSync(join(fixture, "dist/desktop-input-eis.js"), `export function defaultEisInputHelperPath() {\n    const built = fileURLToPath(new URL("./bin/devspace-eis-input-helper.py", import.meta.url));\n}\n`);

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
    assert.match(once[0], /Physical KDE desktop interaction mode selected explicitly/);
    assert.match(once[0], /this\.active \|\| this\.readSessionMetadata\(\)/);
    assert.match(once[0], /parsed\.sessionState === "ready" && parsed\.mode === "host-fallback"/);
    assert.match(once[0], /desktop-selection\.json/);
    assert.match(once[0], /options\.allowHostFallback === undefined && this\.hasPersistedPhysicalSelection\(\)/);
    assert.match(once[0], /writeFileSync\(path, JSON\.stringify/);
    assert.match(once[1], /writeFileSync\(path, JSON\.stringify/);
    assert.match(once[0], /DEVSPACE STOP PRESERVES PHYSICAL SELECTION/);
    assert.match(once[0], /clearPhysicalSelection === true/);
    assert.match(once[2], /observation and direct interaction/i);
    assert.match(once[2], /requestTimeoutMs: 150_000/);
    assert.match(once[1], /allowHostFallback: z5\.boolean\(\).*after its permission is granted/s);
    assert.match(once[1], /allowHostFallback: input\.allowHostFallback,/);
    assert.doesNotMatch(once[1], /allowHostFallback: input\.allowHostFallback \?\? false/);
    assert.match(once[1], /computerUse\.stop\(\{ clearPhysicalSelection: true \}\)/);
    assert.doesNotMatch(once[1], /Physical desktop input is disabled/);
    assert.doesNotMatch(once[1], /allowHostControl/);
    assert.match(once[1], /Select Desktop Interaction Mode/);
    assert.match(readFileSync(join(fixture, "dist/computer-use-session.js"), "utf8"), /hostClient\.input\(request\)/);
    assert.match(readFileSync(join(fixture, "dist/hot-modules.mjs"), "utf8"), /hostClient\.input\(request2\)/);
    assert.match(readFileSync(join(fixture, "dist/desktop-agent-daemon.js"), "utf8"), /DEVSPACE_PHYSICAL_INPUT/);
    assert.match(readFileSync(join(fixture, "dist/desktop-input-eis.js"), "utf8"), /devspace-xdg-portal-input\.py/);
    const physicalInput = readFileSync(join(fixture, "dist/bin/devspace-xdg-portal-input.py"), "utf8");
    assert.match(physicalInput, /org\.freedesktop\.host\.portal\.Registry/);
    assert.match(physicalInput, /org\.shiryustudios\.DevSpace\.ComputerUse/);
    assert.ok(physicalInput.indexOf("registry.Register(") < physicalInput.indexOf("self._remote.CreateSession"));
    assert.ok(physicalInput.includes("XDG RemoteDesktop"));
    const accessibilityHelper = readFileSync(join(fixture, "dist/bin/devspace-accessibility-helper.py"), "utf8");
    assert.match(accessibilityHelper, /DEVSPACE KDE AT-SPI REGISTRY FALLBACK/);
    assert.match(accessibilityHelper, /start_new_session=True/);
    const checkedAccessibility = spawnSync("python", ["-m", "py_compile", join(fixture, "dist/bin/devspace-accessibility-helper.py")], { encoding: "utf8" });
    assert.equal(checkedAccessibility.status, 0, checkedAccessibility.stderr || "Python accessibility helper did not compile");

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
