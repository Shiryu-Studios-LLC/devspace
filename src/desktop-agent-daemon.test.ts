import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopActivityMonitor } from "./desktop-activity-monitor.js";
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
  const daemon = new DesktopAgentDaemon({
    stateDir,
    capabilities: () => [{ id: "audio", state: "ready" }],
    audioGraph: async () => expectedGraph,
  });
  t.after(() => daemon.close());
  await daemon.start();
  const client = new DesktopAgentClient({
    stateDir,
    spawnDaemon: () => assert.fail("existing daemon should not be respawned"),
  });

  assert.deepEqual(await client.audioGraph(), expectedGraph);
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
