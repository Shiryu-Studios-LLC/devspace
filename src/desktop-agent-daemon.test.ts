import assert from "node:assert/strict";
import { createConnection, createServer as createNetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopActivityMonitor } from "./desktop-activity-monitor.js";
import { DesktopAgentClient, DesktopAgentClientError } from "./desktop-agent-client.js";
import { DesktopAgentDaemon, defaultDesktopCapabilities } from "./desktop-agent-daemon.js";
import { defaultDesktopPermissionPolicy } from "./desktop-permissions.js";
import {
  DESKTOP_AGENT_PROTOCOL_VERSION,
  desktopAgentPaths,
  ensureDesktopAgentSecret,
  readDesktopAgentSecret,
} from "./desktop-agent-lifecycle.js";
import {
  decodeDesktopAgentResponse,
  encodeDesktopAgentRequest,
  encodeDesktopAgentResponse,
} from "./desktop-agent-protocol.js";

test("generic awareness is primary while application adapters remain optional secondary sources", () => {
  const capabilities = defaultDesktopCapabilities(defaultDesktopPermissionPolicy(), [], "http://127.0.0.1:9222");
  const shiryuGen = capabilities.find((capability) => capability.id === "apps-shiryugen-trace");
  assert.deepEqual(
    shiryuGen && {
      sourceKind: shiryuGen.sourceKind,
      sourcePriority: shiryuGen.sourcePriority,
      application: shiryuGen.application,
      optional: shiryuGen.optional,
    },
    {
      sourceKind: "application-adapter",
      sourcePriority: "secondary",
      application: "ShiryuGen",
      optional: true,
    },
  );
  const browser = capabilities.find((capability) => capability.id === "apps-browser-session");
  assert.deepEqual(
    browser && {
      state: browser.state,
      sourceKind: browser.sourceKind,
      sourcePriority: browser.sourcePriority,
      application: browser.application,
      optional: browser.optional,
    },
    {
      state: "ready",
      sourceKind: "application-adapter",
      sourcePriority: "secondary",
      application: "Browser",
      optional: true,
    },
  );
  for (const capability of capabilities.filter((entry) => !entry.id.startsWith("apps-"))) {
    assert.equal(capability.sourceKind, "generic", capability.id);
    assert.equal(capability.sourcePriority, "primary", capability.id);
  }
});

test("desktop agent serves authenticated status and capability requests", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-test-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [
      { id: "windows", state: "not_implemented" },
      { id: "displays", state: "not_implemented" },
      { id: "processes", state: "not_implemented" },
      { id: "screen", state: "not_implemented" },
      { id: "input", state: "not_implemented" },
      { id: "accessibility", state: "not_implemented" },
      { id: "clipboard", state: "not_implemented" },
      { id: "notifications", state: "not_implemented" },
      { id: "audio", state: "not_implemented" },
      { id: "devices", state: "not_implemented" },
      { id: "network", state: "not_implemented" },
      { id: "events", state: "not_implemented" },
    ],
  });
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
  assert.equal(capabilities.length, 12);
  assert.ok(capabilities.every((capability) => capability.state === "not_implemented"));
  const permissions = await client.permissions();
  assert.equal(permissions.length, 19);
  assert.equal(permissions.find((permission) => permission.id === "windows")?.granted, true);
  assert.equal(permissions.find((permission) => permission.id === "screen")?.granted, true);

  const authToken = readDesktopAgentSecret(desktopAgentPaths(stateDir));
  assert.ok(authToken);
  const compatibleV1 = await sendRaw(started.endpoint, encodeDesktopAgentRequest({
    requestId: "compatible-v1",
    protocolVersion: 1,
    authToken,
    method: "hello",
    params: {},
  }));
  assert.equal(compatibleV1.ok, true);
  assert.equal(compatibleV1.protocolVersion, 1);

  const incompatible = await sendRaw(started.endpoint, encodeDesktopAgentRequest({
    requestId: "incompatible",
    protocolVersion: 99,
    authToken,
    method: "hello",
    params: {},
  }));
  assert.equal(incompatible.ok, false);
  assert.equal(incompatible.protocolVersion, DESKTOP_AGENT_PROTOCOL_VERSION);
  if (!incompatible.ok) assert.equal(incompatible.error.code, "DESKTOP_AGENT_PROTOCOL_MISMATCH");

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

test("desktop agent client negotiates down to a compatible v1-only agent", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-v1-negotiation-"));
  const paths = desktopAgentPaths(stateDir);
  const authToken = ensureDesktopAgentSecret(paths);
  const seenVersions: number[] = [];
  const server = createNetServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        requestId: string;
        protocolVersion: number;
        authToken: string;
      };
      seenVersions.push(request.protocolVersion);
      assert.equal(request.authToken, authToken);
      if (request.protocolVersion !== 1) {
        socket.end(encodeDesktopAgentResponse({
          requestId: request.requestId,
          protocolVersion: 1,
          ok: false,
          error: {
            code: "DESKTOP_AGENT_PROTOCOL_MISMATCH",
            message: "Expected protocol 1.",
          },
        }));
        return;
      }
      socket.end(encodeDesktopAgentResponse({
        requestId: request.requestId,
        protocolVersion: 1,
        ok: true,
        result: {
          state: "ready",
          protocolVersion: 1,
          pid: 1234,
          endpoint: paths.endpoint,
          startedAt: new Date(0).toISOString(),
          platform: process.platform,
          sessionType: "test",
          clientConnections: 1,
          capabilities: [],
        },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.endpoint, resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  });

  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("v1 test agent should not be respawned"),
  });
  const status = await client.status();
  assert.equal(status?.protocolVersion, 1);
  assert.deepEqual(seenVersions, [DESKTOP_AGENT_PROTOCOL_VERSION, 1]);
});

test("desktop agent hot-applies permission changes without restarting", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-hot-permissions-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let processCalls = 0;
  const permissions = defaultDesktopPermissionPolicy();
  permissions.processes = false;
  const daemon = new DesktopAgentDaemon({
    stateDir,
    permissions,
    processes: async () => {
      processCalls += 1;
      return [];
    },
  });
  t.after(() => daemon.close());
  const started = await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  await assert.rejects(() => client.processes(), (error: unknown) => (
    error instanceof DesktopAgentClientError && error.code === "DESKTOP_PERMISSION_DENIED"
  ));
  assert.equal(processCalls, 0);

  daemon.updatePermissions(defaultDesktopPermissionPolicy());
  assert.deepEqual(await client.processes(), []);
  assert.equal(processCalls, 1);
  assert.equal((await client.status())?.pid, started.pid);

  const deniedAgain = defaultDesktopPermissionPolicy();
  deniedAgain.processes = false;
  daemon.updatePermissions(deniedAgain);
  await assert.rejects(() => client.processes(), (error: unknown) => (
    error instanceof DesktopAgentClientError && error.code === "DESKTOP_PERMISSION_DENIED"
  ));
  assert.equal((await client.status())?.pid, started.pid);
});

test("desktop agent starts and stops AT-SPI focus monitoring with permissions", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-focus-monitor-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let starts = 0;
  let stops = 0;
  const activityMonitor = new DesktopActivityMonitor({
    windows: async () => [],
    processes: async () => [],
    displays: async () => [],
    pollIntervalMs: 60_000,
  });
  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [
      { id: "events", state: "ready" },
      { id: "accessibility", state: "ready" },
    ],
    activityMonitor,
    focusMonitor: {
      start: () => { starts += 1; },
      stop: () => { stops += 1; },
    },
  });
  await daemon.start();
  assert.equal(starts, 1);

  const denied = defaultDesktopPermissionPolicy();
  denied.accessibility = false;
  daemon.updatePermissions(denied);
  assert.equal(stops, 1);

  daemon.updatePermissions(defaultDesktopPermissionPolicy());
  assert.equal(starts, 2);
  await daemon.close();
  assert.equal(stops, 2);
});

test("desktop agent serves structured screen captures through the screen permission", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-screen-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let receivedTarget = "";
  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [{ id: "screen", state: "ready" }],
    screenCapture: async (request) => {
      receivedTarget = request.target;
      return {
        path: join(stateDir, "desktop-agent", "captures", "fixture.png"),
        mimeType: "image/png",
        target: request.target,
        width: 640,
        height: 360,
        scale: 1,
        capturedAt: "2026-09-20T12:00:00.000Z",
      };
    },
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  const capture = await client.captureScreen({ target: "active-window", includeCursor: true });
  assert.equal(receivedTarget, "active-window");
  assert.equal(capture.target, "active-window");
  assert.equal(capture.width, 640);
  assert.equal(capture.mimeType, "image/png");
});

test("desktop agent serves clipboard text and enforces read/write permissions independently", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-clipboard-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const permissions = defaultDesktopPermissionPolicy();
  permissions["clipboard-write"] = false;
  let readCalls = 0;
  let writeCalls = 0;
  const daemon = new DesktopAgentDaemon({
    stateDir,
    permissions,
    capabilities: () => [
      { id: "clipboard-read", state: "ready" },
      { id: "clipboard-write", state: "ready" },
    ],
    clipboardRead: async () => {
      readCalls += 1;
      return {
        available: true,
        text: "seed clipboard",
        mimeType: "text/plain;charset=utf-8",
        bytes: 14,
        readAt: "2026-09-20T12:00:00.000Z",
      };
    },
    clipboardWrite: async (text) => {
      writeCalls += 1;
      return {
        bytes: Buffer.byteLength(text, "utf8"),
        mimeType: "text/plain;charset=utf-8",
        writtenAt: "2026-09-20T12:00:01.000Z",
      };
    },
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  const read = await client.readClipboard();
  assert.equal(read.text, "seed clipboard");
  assert.equal(readCalls, 1);
  await assert.rejects(() => client.writeClipboard("blocked"), (error: unknown) => (
    error instanceof DesktopAgentClientError && error.code === "DESKTOP_PERMISSION_DENIED"
  ));
  assert.equal(writeCalls, 0, "denied clipboard writes must not reach the provider");

  daemon.updatePermissions(defaultDesktopPermissionPolicy());
  const written = await client.writeClipboard("allowed");
  assert.equal(written.bytes, 7);
  assert.equal(writeCalls, 1);
});

test("desktop agent serves bounded accessibility snapshots/actions and enforces accessibility permission", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-accessibility-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const permissions = defaultDesktopPermissionPolicy();
  permissions.accessibility = false;
  let snapshotCalls = 0;
  let actionCalls = 0;
  const daemon = new DesktopAgentDaemon({
    stateDir,
    permissions,
    capabilities: () => [{ id: "accessibility", state: "ready" }],
    accessibilitySnapshot: async (options) => {
      snapshotCalls += 1;
      return {
        generatedAt: "2026-09-20T12:00:00.000Z",
        applicationCount: 1,
        nodeCount: 1,
        truncated: false,
        maxDepth: options?.maxDepth ?? 4,
        maxNodes: options?.maxNodes ?? 200,
        nodes: [{
          id: "pid-123",
          depth: 0,
          application: "Example",
          accessibleId: "org.example.App",
          processId: 123,
          name: "Example",
          description: "",
          role: "application",
          localizedRole: "application",
          childCount: 0,
          states: ["enabled", "visible"],
          interfaces: ["Accessible", "Application"],
          actions: [{ index: 0, name: "activate", description: "", keyBinding: "" }],
          bounds: { x: 0, y: 0, width: 800, height: 600 },
        }],
      };
    },
    accessibilityAction: async (request) => {
      actionCalls += 1;
      return {
        performed: true,
        nodeId: request.nodeId,
        actionIndex: request.actionIndex,
        actionName: "activate",
        performedAt: "2026-09-20T12:00:00.000Z",
      };
    },
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  await assert.rejects(() => client.accessibilitySnapshot(), (error: unknown) => (
    error instanceof DesktopAgentClientError && error.code === "DESKTOP_PERMISSION_DENIED"
  ));
  await assert.rejects(() => client.accessibilityAction({
    nodeId: "pid-123",
    actionIndex: 0,
    expectedRole: "application",
    expectedName: "Example",
    expectedAccessibleId: "org.example.App",
  }), (error: unknown) => (
    error instanceof DesktopAgentClientError && error.code === "DESKTOP_PERMISSION_DENIED"
  ));
  assert.equal(snapshotCalls, 0);
  assert.equal(actionCalls, 0);

  daemon.updatePermissions(defaultDesktopPermissionPolicy());
  const snapshot = await client.accessibilitySnapshot({ application: "Example", maxDepth: 2, maxNodes: 50 });
  assert.equal(snapshot.nodeCount, 1);
  assert.equal(snapshot.nodes[0]?.role, "application");
  assert.equal(snapshotCalls, 1);
  const action = await client.accessibilityAction({
    nodeId: "pid-123",
    actionIndex: 0,
    expectedRole: "application",
    expectedName: "Example",
    expectedAccessibleId: "org.example.App",
  });
  assert.equal(action.performed, true);
  assert.equal(actionCalls, 1);
});

test("desktop agent serves validated input and enforces input permission", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-input-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const permissions = defaultDesktopPermissionPolicy();
  permissions.input = false;
  let inputCalls = 0;
  const daemon = new DesktopAgentDaemon({
    stateDir,
    permissions,
    capabilities: () => [{ id: "input", state: "ready" }],
    input: async (request) => {
      inputCalls += 1;
      return {
        type: request.type,
        completed: true,
        completedAt: "2026-09-20T12:00:00.000Z",
      };
    },
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  await assert.rejects(() => client.input({ type: "key-chord", key: "enter" }), (error: unknown) => (
    error instanceof DesktopAgentClientError && error.code === "DESKTOP_PERMISSION_DENIED"
  ));
  assert.equal(inputCalls, 0, "denied input must not reach the provider");

  daemon.updatePermissions(defaultDesktopPermissionPolicy());
  const result = await client.input({ type: "key-chord", key: "enter" });
  assert.equal(result.completed, true);
  assert.equal(inputCalls, 1);
});

test("desktop agent enforces denied permissions before providers run", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-permissions-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const permissions = defaultDesktopPermissionPolicy();
  permissions.windows = false;
  let windowsCalls = 0;
  const daemon = new DesktopAgentDaemon({
    stateDir,
    permissions,
    capabilities: () => [{ id: "windows", state: "ready" }],
    windows: async () => {
      windowsCalls += 1;
      return [];
    },
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  await assert.rejects(
    () => client.windows(),
    (error: unknown) => Boolean(
      error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === "DESKTOP_PERMISSION_DENIED"
    ),
  );
  assert.equal(windowsCalls, 0, "denied providers must not run");
  assert.equal((await client.permissions()).find((permission) => permission.id === "windows")?.granted, false);
});

test("desktop agent serves a structured read-only window inventory", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-windows-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const expectedWindow = {
    id: "{11111111-2222-3333-4444-555555555555}",
    uuid: "{11111111-2222-3333-4444-555555555555}",
    title: "Shiryu Audio Mixer",
    pid: 2516,
    processName: "shiryu-audio",
    executable: "/opt/ShiryuAudio/shiryu-audio",
    applicationId: "shiryu-audio",
    desktopFile: "shiryu-audio",
    resourceClass: "Shiryu Audio",
    resourceName: "shiryu audio",
    role: "browser-window",
    clientMachine: "localhost",
    x: 360,
    y: 299,
    width: 869,
    height: 594,
    minimized: false,
    fullscreen: false,
    maximizedHorizontal: false,
    maximizedVertical: false,
    keepAbove: false,
    keepBelow: false,
    skipTaskbar: false,
    skipPager: false,
    skipSwitcher: false,
    noBorder: false,
    excludeFromCapture: false,
    desktops: ["desktop-1"],
    activities: ["activity-1"],
  };
  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [{ id: "windows", state: "ready" }],
    windows: async () => [expectedWindow],
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  assert.deepEqual(await client.windows(), [expectedWindow]);
});

test("desktop agent serves a structured read-only display inventory", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-displays-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const expectedDisplay = {
    id: 1,
    name: "HDMI-A-1",
    connected: true,
    enabled: true,
    active: true,
    primary: true,
    priority: 1,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    scale: 1,
    rotation: 1,
    brightness: 0.8,
    ddcCiAllowed: true,
    physicalWidthMm: 521,
    physicalHeightMm: 295,
    currentModeId: "2",
    currentMode: {
      id: "2",
      name: "1920x1080@100",
      width: 1920,
      height: 1080,
      refreshRate: 100,
    },
    preferredModeIds: ["1"],
    modes: [{
      id: "2",
      name: "1920x1080@100",
      width: 1920,
      height: 1080,
      refreshRate: 100,
    }],
    clones: [],
    replicationSource: 0,
    connectorType: 6,
  };
  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [{ id: "displays", state: "ready" }],
    displays: async () => [expectedDisplay],
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  assert.deepEqual(await client.displays(), [expectedDisplay]);
});

test("desktop agent serves a structured process inventory without command lines", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-processes-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const expectedProcess = {
    pid: 2501,
    ppid: 1,
    uid: 1000,
    sameUser: true,
    name: "ChatGPT",
    state: "S (sleeping)",
    executable: "/opt/ChatGPT/chatgpt",
    threads: 24,
    residentMemoryBytes: 128 * 1024 * 1024,
    virtualMemoryBytes: 1024 * 1024 * 1024,
    windowIds: ["{11111111-2222-3333-4444-555555555555}"],
    windowCount: 1,
    hasWindow: true,
  };
  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [{ id: "processes", state: "ready" }],
    processes: async () => [expectedProcess],
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  assert.deepEqual(await client.processes(), [expectedProcess]);
});

test("desktop agent serves the bounded recent activity timeline", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-events-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let processes = [{
    pid: 100,
    ppid: 1,
    uid: 1000,
    sameUser: true,
    name: "before",
    state: "S (sleeping)",
    windowIds: [],
    windowCount: 0,
    hasWindow: false,
  }];
  const monitor = new DesktopActivityMonitor({
    windows: async () => [],
    displays: async () => [],
    processes: async () => processes,
    pollIntervalMs: 60_000,
  });
  await monitor.sample();
  processes = [{
    pid: 200,
    ppid: 1,
    uid: 1000,
    sameUser: true,
    name: "after",
    state: "S (sleeping)",
    windowIds: [],
    windowCount: 0,
    hasWindow: false,
  }];
  await monitor.sample();

  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [{ id: "events", state: "ready" }],
    activityMonitor: monitor,
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  const activity = await client.recentActivity();
  assert.equal(activity.cursor, 2);
  assert.deepEqual(activity.events.map((event) => event.type), ["process.started", "process.stopped"]);
  assert.equal(activity.events[0]?.correlationId, "pid:200");
});

test("desktop agent serves a structured read-only PipeWire audio graph", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-audio-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const expectedGraph = {
    generatedAt: "2026-09-20T02:00:00.000Z",
    nodes: [{
      id: 91,
      name: "shiryu.input.1.clean",
      mediaClass: "Audio/Source",
      state: "running",
      nick: undefined,
      description: "Shiryu Microphone 1",
      applicationName: "Shiryu Audio",
      applicationBinary: undefined,
      pid: undefined,
      clientId: undefined,
      deviceId: undefined,
      mediaName: undefined,
      targetObject: undefined,
      sampleRate: 48000,
      latency: undefined,
      isStream: false,
      isSink: false,
      isSource: true,
    }, {
      id: 200,
      name: "WEBRTC VoiceEngine",
      mediaClass: "Stream/Input/Audio",
      state: "running",
      nick: undefined,
      description: undefined,
      applicationName: "WEBRTC VoiceEngine",
      applicationBinary: "Discord",
      pid: 1800836,
      clientId: undefined,
      deviceId: undefined,
      mediaName: undefined,
      targetObject: "shiryu.input.1.clean",
      sampleRate: 48000,
      latency: undefined,
      isStream: true,
      isSink: false,
      isSource: false,
    }],
    ports: [{
      id: 210,
      nodeId: 91,
      name: "capture_FL",
      direction: "out" as const,
      alias: undefined,
      channel: "FL",
    }],
    links: [{
      id: 88,
      state: "active",
      outputNodeId: 91,
      outputPortId: 210,
      inputNodeId: 200,
      inputPortId: 174,
      outputNodeName: "Shiryu Microphone 1",
      inputNodeName: "WEBRTC VoiceEngine",
      outputPortName: "capture_FL",
      inputPortName: "input_FL",
    }],
  };
  const expectedRuntime = {
    generatedAt: "2026-09-20T02:00:01.000Z",
    samplingIterations: 2,
    nodes: [{
      id: 200,
      stateCode: "R",
      running: true,
      quantum: 256,
      rate: 48000,
      waitUsec: 22.5,
      busyUsec: 8.25,
      waitRatio: 0.01,
      busyRatio: 0,
      errors: 3,
      audioFormat: "F32LE",
      channels: 2,
      formatRate: 48000,
      name: "WEBRTC VoiceEngine",
    }],
  };
  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [
      { id: "audio", state: "ready" },
      { id: "audio-runtime", state: "ready" },
    ],
    audioGraph: async () => expectedGraph,
    audioRuntime: async () => expectedRuntime,
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  const graph = await client.audioGraph();
  assert.equal(graph.generatedAt, expectedGraph.generatedAt);
  assert.equal(graph.nodes[1]?.applicationBinary, "Discord");
  assert.equal(graph.links[0]?.id, 88);
  assert.deepEqual(await client.audioRuntime(), expectedRuntime);
});

test("desktop agent blocks PipeWire runtime telemetry when audio permission is denied", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-audio-runtime-denied-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const permissions = defaultDesktopPermissionPolicy();
  permissions.audio = false;
  let calls = 0;
  const daemon = new DesktopAgentDaemon({
    stateDir,
    permissions,
    capabilities: () => [{ id: "audio-runtime", state: "ready" }],
    audioRuntime: async () => {
      calls += 1;
      return { generatedAt: "2026-09-20T02:00:01.000Z", samplingIterations: 2, nodes: [] };
    },
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  await assert.rejects(() => client.audioRuntime(), (error: unknown) => (
    error instanceof DesktopAgentClientError && error.code === "DESKTOP_PERMISSION_DENIED"
  ));
  assert.equal(calls, 0, "denied audio runtime requests must not reach pw-top provider");
});

test("desktop agent serves a structured read-only device inventory", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-devices-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const expectedDevices = [{
    id: "usb:3-2.3.1",
    subsystem: "usb" as const,
    category: "usb-device",
    name: "Index HMD",
    vendor: "Valve",
    model: "Index HMD",
    vendorId: "28de",
    productId: "2300",
    classCode: "00",
    driver: "usb",
    path: "3-2.3.1",
    transport: "usb",
    speed: "12 Mb/s",
    connected: true,
    hotplug: true,
    removable: true,
    paired: undefined,
    sizeBytes: undefined,
    parentId: undefined,
    mountpoints: [],
  }, {
    id: "bluetooth:1837773865b35b47",
    subsystem: "bluetooth" as const,
    category: "bluetooth-device",
    name: "Xbox Wireless Controller",
    vendor: undefined,
    model: undefined,
    vendorId: undefined,
    productId: undefined,
    classCode: undefined,
    driver: undefined,
    path: undefined,
    transport: "bluetooth",
    speed: undefined,
    connected: false,
    hotplug: true,
    removable: true,
    paired: true,
    sizeBytes: undefined,
    parentId: undefined,
    mountpoints: [],
  }];
  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [{ id: "devices", state: "ready" }],
    devices: async () => expectedDevices,
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  assert.deepEqual(await client.devices(), expectedDevices);
  assert.equal(JSON.stringify(await client.devices()).includes("serial"), false);
});

test("desktop agent serves a structured read-only network snapshot", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-network-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const expectedNetwork = {
    generatedAt: "2026-09-20T03:00:00.000Z",
    interfaces: [{
      index: 2,
      name: "enp5s0",
      kind: "ethernet",
      linkType: "ether",
      operState: "UP",
      mtu: 1500,
      up: true,
      lowerUp: true,
      loopback: false,
      addresses: [{ family: "ipv4" as const, address: "192.168.1.10", prefixLength: 24, scope: "global", dynamic: true }],
    }],
    routes: [{ family: "ipv4" as const, destination: "default", gateway: "192.168.1.1", interfaceName: "enp5s0", table: "main", protocol: "dhcp", scope: undefined, preferredSource: undefined, metric: undefined, type: undefined, linkDown: false }],
    dnsServers: [{ interfaceName: "enp5s0", address: "192.168.1.1" }],
    listeners: [{ protocol: "tcp" as const, address: "127.0.0.1", port: 7676, interfaceName: undefined, processName: "node", pid: 1234 }],
    cloudflareTunnel: { running: true, pids: [4321] },
  };
  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [{ id: "network", state: "ready" }],
    networkSnapshot: async () => expectedNetwork,
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  assert.deepEqual(await client.networkSnapshot(), expectedNetwork);
});

test("desktop agent serves a structured read-only virtual desktop snapshot", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-virtual-desktops-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const expectedVirtualDesktops = {
    generatedAt: "2026-09-20T06:50:00.000Z",
    currentId: "desktop-2",
    count: 2,
    rows: 1,
    navigationWrappingAround: false,
    desktops: [
      { position: 0, id: "desktop-1", name: "Main", current: false },
      { position: 1, id: "desktop-2", name: "VR", current: true },
    ],
  };
  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [{ id: "virtual-desktops", state: "ready" }],
    virtualDesktops: async () => expectedVirtualDesktops,
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  assert.deepEqual(await client.virtualDesktops(), expectedVirtualDesktops);
});

test("desktop agent serves read-only browser session metadata and enforces browser permission", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-browser-session-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const expectedBrowserSession = {
    browser: "Opera/123.0",
    capturedAt: "2026-09-20T22:45:00.000Z",
    tabs: [
      { id: "page-1", type: "page", title: "DevSpace", url: "https://example.com/" },
      { id: "worker-1", type: "service_worker", title: "", url: "https://example.com/sw.js" },
    ],
  };
  let providerCalls = 0;
  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [{ id: "apps-browser-session", state: "ready" }],
    browserSession: async () => {
      providerCalls += 1;
      return expectedBrowserSession;
    },
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  assert.deepEqual(await client.browserSession(), expectedBrowserSession);
  assert.equal(providerCalls, 1);

  const denied = defaultDesktopPermissionPolicy();
  denied.browser = false;
  daemon.updatePermissions(denied);
  await assert.rejects(
    () => client.browserSession(),
    (error: unknown) => error instanceof DesktopAgentClientError && error.code === "DESKTOP_PERMISSION_DENIED",
  );
  assert.equal(providerCalls, 1, "denied browser permission must not reach the browser provider");
});

test("desktop agent serves bounded recent desktop notifications without actions", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-notifications-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const expectedNotifications = [{
    id: "dbus::1.1209:9",
    notificationId: 15,
    replacesId: undefined,
    appName: "DevSpace Test",
    summary: "Awareness test",
    body: "Read-only observation.",
    pid: 9460,
    desktopEntry: "devspace",
    category: "device",
    urgency: 1,
    actions: [{ id: "default", label: "Open" }],
    expireTimeoutMs: -1,
    createdAt: "2026-09-20T06:20:00.000Z",
    closedAt: undefined,
    closeReason: undefined,
  }];
  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [{ id: "notifications", state: "ready" }],
    notifications: async () => expectedNotifications,
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  assert.deepEqual(await client.notifications(), expectedNotifications);
});

test("desktop agent serves guarded notification controls and enforces notification-actions permission", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-notification-actions-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const permissions = defaultDesktopPermissionPolicy();
  permissions["notification-actions"] = false;
  let calls = 0;
  const daemon = new DesktopAgentDaemon({
    stateDir,
    permissions,
    capabilities: () => [{ id: "notification-actions", state: "ready" }],
    notificationControl: async (request) => {
      calls += 1;
      return {
        type: request.type,
        id: request.id,
        notificationId: 15,
        ...(request.type === "invoke-action" ? { actionId: request.actionId } : {}),
        completed: true,
        completedAt: "2026-09-20T06:21:00.000Z",
      };
    },
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  await assert.rejects(
    () => client.notificationControl({ type: "dismiss", id: "dbus::1.5:9" }),
    (error: unknown) => error instanceof DesktopAgentClientError && error.code === "DESKTOP_PERMISSION_DENIED",
  );
  assert.equal(calls, 0);

  daemon.updatePermissions(defaultDesktopPermissionPolicy());
  const result = await client.notificationControl({ type: "invoke-action", id: "dbus::1.5:9", actionId: "default" });
  assert.equal(result.completed, true);
  assert.equal(result.actionId, "default");
  assert.equal(calls, 1);
});

test("desktop agent serves allowed-root filesystem watches and enforces filesystem-watch permission", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-filesystem-watch-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const permissions = defaultDesktopPermissionPolicy();
  permissions["filesystem-watch"] = false;
  let starts = 0;
  let stops = 0;
  let closes = 0;
  const watch = {
    id: "fswatch:123",
    path: stateDir,
    recursive: true,
    startedAt: "2026-09-20T12:00:00.000Z",
    eventCount: 0,
    state: "ready" as const,
  };
  const daemon = new DesktopAgentDaemon({
    stateDir,
    permissions,
    allowedRoots: [stateDir],
    capabilities: () => [{ id: "filesystem-watch", state: "ready" }],
    filesystemWatchManager: {
      start: (path, recursive) => {
        starts += 1;
        return { ...watch, path, recursive: Boolean(recursive) };
      },
      stop: () => {
        stops += 1;
        return watch;
      },
      list: () => [watch],
      close: () => { closes += 1; },
    },
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  await assert.rejects(
    () => client.startFilesystemWatch(stateDir, true),
    (error: unknown) => error instanceof DesktopAgentClientError && error.code === "DESKTOP_PERMISSION_DENIED",
  );
  assert.equal(starts, 0);

  daemon.updatePermissions(defaultDesktopPermissionPolicy());
  const started = await client.startFilesystemWatch(stateDir, true);
  assert.equal(started.recursive, true);
  assert.equal(starts, 1);
  assert.equal((await client.filesystemWatches()).length, 1);
  await client.stopFilesystemWatch(watch.id);
  assert.equal(stops, 1);

  const deniedAgain = defaultDesktopPermissionPolicy();
  deniedAgain["filesystem-watch"] = false;
  daemon.updatePermissions(deniedAgain);
  assert.equal(closes, 1, "disabling filesystem-watch should close active watchers");
});

test("desktop agent serves explicit bounded log sources and reads", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-logs-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const expectedSources = [{
    id: "journal:_COMM:bm9kZQ",
    kind: "journal" as const,
    label: "node",
    selector: "_COMM=node",
    lastSeen: "2026-09-20T03:00:00.000Z",
    sampledEntries: 12,
  }];
  const expectedLogs = {
    sourceId: expectedSources[0]!.id,
    generatedAt: "2026-09-20T03:01:00.000Z",
    query: "tool_call",
    entries: [{
      timestamp: "2026-09-20T03:00:59.000Z",
      priority: 6,
      unit: undefined,
      identifier: undefined,
      processName: "node",
      pid: 9460,
      message: "tool_call desktop_network_snapshot",
    }],
  };
  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [{ id: "logs", state: "ready" }],
    logSources: async () => expectedSources,
    readLogs: async (sourceId, options) => ({ ...expectedLogs, sourceId, query: options?.query }),
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  assert.deepEqual(await client.logSources(), expectedSources);
  assert.deepEqual(await client.readLogs(expectedSources[0]!.id, { lines: 25, query: "tool_call" }), expectedLogs);
});

test("desktop agent serves ShiryuGen generation traces and correlates observed output files", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-shiryugen-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const outputPath = "/tmp/generated_images/kashiro.png";
  const eventTime = Date.parse("2026-09-20T12:00:05.100Z");
  const monitor = new DesktopActivityMonitor({
    windows: async () => [],
    processes: async () => [],
    displays: async () => [],
    now: () => eventTime,
  });
  monitor.recordFilesystemEvent({
    watchId: "fswatch:test",
    type: "created",
    path: outputPath,
    occurredAt: "2026-09-20T12:00:05.100Z",
  });
  let providerCalls = 0;
  const daemon = new DesktopAgentDaemon({
    stateDir,
    activityMonitor: monitor,
    capabilities: () => [{ id: "apps-shiryugen-trace", state: "ready" }],
    shiryuGenTrace: async (traceId) => {
      providerCalls += 1;
      return {
        traceId: traceId ?? "shiryugen-generate-latest",
        found: true,
        action: "generate",
        state: "completed",
        startedAt: "2026-09-20T12:00:00.000Z",
        endedAt: "2026-09-20T12:00:05.200Z",
        durationMs: 5200,
        promptId: "prompt-abc",
        outputPath,
        relatedPaths: [outputPath],
        stages: [],
        filesystemEvents: [],
        sourceFiles: ["/home/okashi/.t3/userdata/logs/server.trace.ndjson"],
        recordsScanned: 12,
        bytesScanned: 4096,
      };
    },
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  const latest = await client.shiryuGenTrace();
  assert.equal(latest.traceId, "shiryugen-generate-latest");
  assert.equal(latest.filesystemEvents.length, 1);
  assert.equal(latest.filesystemEvents[0]?.title, outputPath);
  assert.equal(providerCalls, 1);

  const denied = defaultDesktopPermissionPolicy();
  denied.tracing = false;
  daemon.updatePermissions(denied);
  await assert.rejects(
    () => client.shiryuGenTrace("shiryugen-generate-exact"),
    (error: unknown) => error instanceof DesktopAgentClientError && error.code === "DESKTOP_PERMISSION_DENIED",
  );
  assert.equal(providerCalls, 1, "denied tracing must not reach the ShiryuGen provider");
});

test("desktop agent client reconnects after mid-request agent loss", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-desktop-agent-reconnect-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let first!: DesktopAgentDaemon;
  let replacement: DesktopAgentDaemon | undefined;
  first = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [{ id: "windows", state: "ready" }],
    windows: async () => {
      await first.close();
      return [];
    },
  });
  t.after(async () => {
    await first.close();
    await replacement?.close();
  });
  await first.start();

  let restarts = 0;
  const client = new DesktopAgentClient({
    stateDir,
    startupTimeoutMs: 2_000,
    spawnDaemon: () => {
      restarts += 1;
      replacement = new DesktopAgentDaemon({
        stateDir,
        capabilities: () => [{ id: "windows", state: "ready" }],
        windows: async () => [],
      });
      void replacement.start();
    },
  });

  assert.deepEqual(await client.windows(), []);
  assert.equal(restarts, 1, "one bounded reconnect should replace the lost desktop agent");
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
