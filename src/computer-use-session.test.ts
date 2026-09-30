import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComputerUseSessionManager } from "./computer-use-session.js";
import { DesktopAgentClient } from "./desktop-agent-client.js";

test("routedClient keeps a persisted isolated session isolated before refresh", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-computer-use-route-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const hostClient = new DesktopAgentClient({
    stateDir: join(stateDir, "host-agent"),
    spawnDaemon: () => undefined,
  });
  const manager = new ComputerUseSessionManager(stateDir, hostClient);

  assert.equal(manager.routedClient(), hostClient);

  await writeFile(
    join(stateDir, "computer-use", "session.json"),
    JSON.stringify({
      sessionId: "persisted-session",
      mode: "isolated-window",
      hostPid: process.pid,
      startedAt: new Date().toISOString(),
      controlSocket: join(stateDir, "computer-use", "control.sock"),
    }) + "\n",
    { mode: 0o600 },
  );

  assert.equal(manager.routedClient(), manager.isolatedDesktopClient());
});

test("routedClient does not treat an explicit host-fallback record as isolated", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-computer-use-host-route-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const hostClient = new DesktopAgentClient({
    stateDir: join(stateDir, "host-agent"),
    spawnDaemon: () => undefined,
  });
  const manager = new ComputerUseSessionManager(stateDir, hostClient);

  await writeFile(
    join(stateDir, "computer-use", "session.json"),
    JSON.stringify({
      sessionId: "explicit-host-fallback",
      mode: "host-fallback",
      hostPid: process.pid,
      startedAt: new Date().toISOString(),
      controlSocket: join(stateDir, "computer-use", "control.sock"),
    }) + "\n",
    { mode: 0o600 },
  );

  assert.equal(manager.routedClient(), hostClient);
});
