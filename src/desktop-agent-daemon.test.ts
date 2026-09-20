import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopAgentClient } from "./desktop-agent-client.js";
import { DesktopAgentDaemon } from "./desktop-agent-daemon.js";
import {
  DESKTOP_AGENT_PROTOCOL_VERSION,
  desktopAgentPaths,
} from "./desktop-agent-lifecycle.js";
import {
  decodeDesktopAgentResponse,
  encodeDesktopAgentRequest,
} from "./desktop-agent-protocol.js";

test("desktop agent serves authenticated status and capability requests", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-test-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const daemon = new DesktopAgentDaemon({ stateDir });
  t.after(() => daemon.close());
  const started = await daemon.start();
  assert.equal(started.state, "ready");

  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });
  const status = await client.status();
  assert.equal(status?.pid, process.pid);
  const capabilities = await client.capabilities();
  assert.equal(capabilities.length, 10);
  assert.ok(capabilities.every((capability) => capability.state === "not_implemented"));

  const unauthorized = await sendRaw(started.endpoint, encodeDesktopAgentRequest({
    requestId: "bad-auth",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "0".repeat(64),
    method: "hello",
    params: {},
  }));
  assert.equal(unauthorized.ok, false);
  if (!unauthorized.ok) assert.equal(unauthorized.error.code, "DESKTOP_AGENT_UNAUTHORIZED");
});

test("desktop agent client can auto-start and stop an isolated daemon", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-autostart-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const daemon = new DesktopAgentDaemon({ stateDir });
  t.after(() => daemon.close());
  let starts = 0;
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => {
      starts += 1;
      void daemon.start();
    },
  });

  const ready = await client.ensureReady();
  assert.equal(ready.state, "ready");
  assert.equal(starts, 1);
  const stopping = await client.stop();
  assert.equal(stopping?.state, "stopping");
  await waitFor(async () => (await client.status()) === undefined);
});

async function sendRaw(endpoint: string, line: string) {
  return new Promise<ReturnType<typeof decodeDesktopAgentResponse>>((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.once("connect", () => socket.write(line));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.end();
      try {
        resolve(decodeDesktopAgentResponse(JSON.parse(buffer.slice(0, newline))));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition did not become true before timeout");
}
