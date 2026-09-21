import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_AGENT_PROTOCOL_VERSION,
} from "./desktop-agent-lifecycle.js";
import {
  decodeDesktopAgentRequest,
  decodeDesktopAgentResponse,
  decodeDesktopActivityTimeline,
  decodeDesktopAgentStatus,
  decodeDesktopPermissionStatuses,
  decodeDesktopAudioGraph,
  decodeDesktopAudioRuntime,
  decodeDesktopDeviceList,
  decodeDesktopDisplayList,
  decodeDesktopNetworkSnapshot,
  decodeDesktopNotificationList,
  decodeDesktopNotificationControlResult,
  decodeDesktopFilesystemWatchInfo,
  decodeDesktopFilesystemWatchList,
  decodeDesktopVirtualDesktopSnapshot,
  decodeDesktopBrowserSessionSnapshot,
  decodeDesktopLogReadResult,
  decodeDesktopLogSources,
  decodeDesktopTraceCorrelation,
  decodeDesktopShiryuGenGenerationTrace,
  decodeDesktopProcessList,
  decodeDesktopScreenCapture,
  decodeDesktopClipboardReadResult,
  decodeDesktopClipboardWriteResult,
  decodeDesktopAccessibilityActionResult,
  decodeDesktopInputResult,
  decodeDesktopAccessibilitySnapshot,
  decodeDesktopWindowList,
  encodeDesktopAgentRequest,
  type DesktopAgentRequest,
} from "./desktop-agent-protocol.js";

test("desktop agent request protocol round-trips", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-1",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "desktop.capabilities",
    params: {},
  };
  const line = encodeDesktopAgentRequest(request).trim();
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(line)), request);
});

test("desktop agent accepts the read-only permission status method", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-permissions",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "desktop.permissions",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
  const permissions = decodeDesktopPermissionStatuses([
    { id: "windows", granted: true, defaultGranted: true },
    { id: "screen", granted: false, defaultGranted: false },
  ]);
  assert.equal(permissions[0]?.granted, true);
  assert.equal(permissions[1]?.defaultGranted, false);
});

test("desktop agent accepts the read-only windows list method", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-windows",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "windows.list",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
});

test("desktop agent accepts the read-only displays list method", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-displays",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "displays.list",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
});

test("desktop agent accepts the read-only processes list method", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-processes",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "processes.list",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
});

test("desktop agent accepts validated screen capture requests", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-screen",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "screen.capture",
    params: {
      target: "area",
      x: 10,
      y: 20,
      width: 320,
      height: 180,
      includeCursor: true,
      nativeResolution: false,
    },
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
  assert.throws(
    () => decodeDesktopAgentRequest({ ...request, params: { target: "window" } }),
    /requires windowId/,
  );
  assert.throws(
    () => decodeDesktopAgentRequest({ ...request, params: { target: "area", x: 0, y: 0, width: 0, height: 10 } }),
    /positive width\/height/,
  );
});

test("desktop agent accepts clipboard read and write requests", () => {
  const readRequest: DesktopAgentRequest = {
    requestId: "request-clipboard-read",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "clipboard.read",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(readRequest))), readRequest);

  const writeRequest: DesktopAgentRequest = {
    requestId: "request-clipboard-write",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "clipboard.write",
    params: { text: "hello clipboard" },
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(writeRequest))), writeRequest);
  assert.throws(
    () => decodeDesktopAgentRequest({ ...writeRequest, params: { text: 123 } }),
    /requires text/,
  );
  assert.throws(
    () => decodeDesktopAgentRequest({ ...writeRequest, params: { text: "hello", path: "/tmp/x" } }),
    /unknown parameters/,
  );
});

test("desktop agent accepts bounded accessibility snapshot requests", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-accessibility",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "accessibility.snapshot",
    params: { application: "Example", maxDepth: 3, maxNodes: 120 },
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
  assert.throws(
    () => decodeDesktopAgentRequest({ ...request, params: { maxDepth: 9 } }),
    /maxDepth must be between 0 and 8/,
  );
  assert.throws(
    () => decodeDesktopAgentRequest({ ...request, params: { maxNodes: 0 } }),
    /maxNodes must be between 1 and 500/,
  );
});

test("desktop agent accepts guarded accessibility action requests", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-accessibility-action",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "accessibility.action",
    params: {
      nodeId: "pid-1234.0.2",
      actionIndex: 1,
      expectedRole: "push button",
      expectedName: "OK",
      expectedAccessibleId: "ok-button",
    },
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
  assert.throws(
    () => decodeDesktopAgentRequest({ ...request, params: { ...request.params, nodeId: "app-0.1" } }),
    /pid-based node ID/,
  );
  assert.throws(
    () => decodeDesktopAgentRequest({ ...request, params: { ...request.params, actionIndex: 64 } }),
    /between 0 and 63/,
  );
  assert.throws(
    () => decodeDesktopAgentRequest({ ...request, params: { ...request.params, expectedName: 7 } }),
    /expectedName must be a string/,
  );
});

test("desktop agent accepts bounded high-level input requests", () => {
  const chord: DesktopAgentRequest = {
    requestId: "request-input-chord",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "input.perform",
    params: { type: "key-chord", key: "l", modifiers: ["ctrl"], keyDelayMs: 10 },
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(chord))), chord);
  const move: DesktopAgentRequest = {
    requestId: "request-input-move",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "input.perform",
    params: { type: "mouse-move", mode: "relative", x: 5, y: -2 },
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(move))), move);
  assert.throws(
    () => decodeDesktopAgentRequest({ ...move, params: { type: "mouse-move", mode: "absolute", x: -1, y: 0 } }),
    /outside the absolute bounds/,
  );
  assert.throws(
    () => decodeDesktopAgentRequest({ ...chord, params: { type: "key-chord", key: "power" } }),
    /Unsupported input key/,
  );
  assert.throws(
    () => decodeDesktopAgentRequest({ ...chord, params: { type: "type-text", text: "x".repeat(16_385) } }),
    /at most 16384/,
  );
});

test("desktop agent accepts bounded filesystem watch requests", () => {
  const start: DesktopAgentRequest = {
    requestId: "request-fswatch-start",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "filesystem.watch.start",
    params: { path: "/tmp/project", recursive: true },
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(start))), start);
  const stop: DesktopAgentRequest = {
    ...start,
    requestId: "request-fswatch-stop",
    method: "filesystem.watch.stop",
    params: { id: "fswatch:123" },
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(stop))), stop);
  const list: DesktopAgentRequest = {
    ...start,
    requestId: "request-fswatch-list",
    method: "filesystem.watch.list",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(list))), list);
  assert.throws(
    () => decodeDesktopAgentRequest({ ...start, params: { path: "/tmp/project", recursive: "yes" } }),
    /filesystem.recursive/,
  );
});

test("desktop agent accepts the recent activity method", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-events",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "events.recent",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
});

test("desktop agent accepts the read-only device list method", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-devices",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "devices.list",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
});

test("desktop agent accepts the read-only network snapshot method", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-network",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "network.snapshot",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
});

test("desktop agent accepts the read-only virtual desktop snapshot method", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-virtual-desktops",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "virtual-desktops.snapshot",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
});

test("desktop agent accepts the read-only browser session method", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-browser-session",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "browser.session",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
});

test("desktop agent accepts log source listing and bounded log reads", () => {
  const sourcesRequest: DesktopAgentRequest = {
    requestId: "request-log-sources",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "logs.sources",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(sourcesRequest))), sourcesRequest);

  const readRequest: DesktopAgentRequest = {
    requestId: "request-log-read",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "logs.read",
    params: { sourceId: "journal:_COMM:bm9kZQ", lines: 25, query: "tool_call" },
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(readRequest))), readRequest);
  assert.throws(() => decodeDesktopAgentRequest({ ...readRequest, params: { ...readRequest.params, path: "/tmp/x" } }), /unknown parameters/);
});

test("desktop agent accepts correlation requests", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-trace",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "trace.correlate",
    params: { correlationId: "pid:9460", lines: 50, query: "http_request" },
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
});

test("desktop agent accepts bounded ShiryuGen generation trace requests", () => {
  const latest: DesktopAgentRequest = {
    requestId: "request-shiryugen-latest",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "apps.shiryugen.trace",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(latest))), latest);
  const exact: DesktopAgentRequest = {
    ...latest,
    requestId: "request-shiryugen-exact",
    params: { traceId: "shiryugen-generate-abc-123" },
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(exact))), exact);
  assert.throws(() => decodeDesktopAgentRequest({ ...exact, params: { traceId: "/tmp/server.trace.ndjson" } }), /valid ShiryuGen generation trace identifier/);
  assert.throws(() => decodeDesktopAgentRequest({ ...exact, params: { traceId: "shiryugen-generate-ok", path: "/tmp/x" } }), /unknown parameters/);
});

test("desktop agent accepts the recent notifications method", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-notifications",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "notifications.recent",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
});

test("desktop agent accepts guarded notification control requests", () => {
  const dismiss: DesktopAgentRequest = {
    requestId: "request-notification-dismiss",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "notifications.perform",
    params: { type: "dismiss", id: "dbus::1.5:9" },
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(dismiss))), dismiss);
  const invoke: DesktopAgentRequest = {
    ...dismiss,
    requestId: "request-notification-action",
    params: { type: "invoke-action", id: "dbus::1.5:9", actionId: "default" },
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(invoke))), invoke);
  assert.throws(
    () => decodeDesktopAgentRequest({ ...invoke, params: { type: "invoke-action", id: "x" } }),
    /actionId/,
  );
});

test("desktop agent accepts the read-only audio graph/runtime methods", () => {
  const graph: DesktopAgentRequest = {
    requestId: "request-audio",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "audio.graph",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(graph))), graph);
  const runtime: DesktopAgentRequest = {
    ...graph,
    requestId: "request-audio-runtime",
    method: "audio.runtime",
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(runtime))), runtime);
});

test("desktop agent protocol rejects unknown methods", () => {
  assert.throws(
    () => decodeDesktopAgentRequest({
      requestId: "request-1",
      protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
      authToken: "a".repeat(64),
      method: "desktop.click",
      params: {},
    }),
    /Unknown desktop agent method/,
  );
});

test("desktop agent decodes a structured screen capture", () => {
  const capture = decodeDesktopScreenCapture({
    path: "/private/captures/example.png",
    mimeType: "image/png",
    target: "window",
    width: 1200,
    height: 800,
    scale: 1.25,
    capturedAt: "2026-09-20T12:00:00.000Z",
    windowId: "{11111111-2222-3333-4444-555555555555}",
  });
  assert.equal(capture.target, "window");
  assert.equal(capture.width, 1200);
  assert.equal(capture.windowId, "{11111111-2222-3333-4444-555555555555}");
});

test("desktop agent decodes structured clipboard results", () => {
  const read = decodeDesktopClipboardReadResult({
    available: true,
    text: "hello clipboard",
    mimeType: "text/plain;charset=utf-8",
    bytes: 15,
    readAt: "2026-09-20T12:00:00.000Z",
  });
  assert.equal(read.text, "hello clipboard");
  assert.equal(read.bytes, 15);

  const empty = decodeDesktopClipboardReadResult({
    available: false,
    readAt: "2026-09-20T12:00:01.000Z",
  });
  assert.equal(empty.available, false);

  const write = decodeDesktopClipboardWriteResult({
    bytes: 15,
    mimeType: "text/plain;charset=utf-8",
    writtenAt: "2026-09-20T12:00:02.000Z",
  });
  assert.equal(write.bytes, 15);
  assert.equal(write.mimeType, "text/plain;charset=utf-8");
});

test("desktop agent decodes a structured accessibility snapshot", () => {
  const snapshot = decodeDesktopAccessibilitySnapshot({
    generatedAt: "2026-09-20T12:00:00.000Z",
    applicationCount: 1,
    nodeCount: 1,
    truncated: false,
    maxDepth: 4,
    maxNodes: 200,
    nodes: [{
      id: "app-0",
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
  });
  assert.equal(snapshot.nodes[0]?.role, "application");
  assert.equal(snapshot.nodes[0]?.processId, 123);
  assert.equal(snapshot.nodes[0]?.actions[0]?.name, "activate");
});

test("desktop agent decodes a structured accessibility action result", () => {
  const action = decodeDesktopAccessibilityActionResult({
    performed: true,
    nodeId: "pid-1234.0.2",
    actionIndex: 0,
    actionName: "click",
    performedAt: "2026-09-20T12:00:00.000Z",
  });
  assert.equal(action.performed, true);
  assert.equal(action.nodeId, "pid-1234.0.2");
  assert.equal(action.actionName, "click");
});

test("desktop agent decodes a structured input result", () => {
  const input = decodeDesktopInputResult({
    type: "key-chord",
    completed: true,
    completedAt: "2026-09-20T12:00:00.000Z",
  });
  assert.equal(input.type, "key-chord");
  assert.equal(input.completed, true);
});

test("desktop agent decodes a structured window list", () => {
  const windows = decodeDesktopWindowList([{
    id: "{11111111-2222-3333-4444-555555555555}",
    uuid: "{11111111-2222-3333-4444-555555555555}",
    title: "ChatGPT",
    pid: 123,
    processName: "chrome",
    applicationId: "chatgpt",
    x: 10,
    y: 20,
    width: 1200,
    height: 800,
    minimized: false,
    fullscreen: false,
    maximizedHorizontal: true,
    maximizedVertical: true,
    keepAbove: false,
    keepBelow: false,
    skipTaskbar: false,
    skipPager: false,
    skipSwitcher: false,
    noBorder: false,
    excludeFromCapture: false,
    desktops: ["desktop-1"],
    activities: [],
  }]);
  assert.equal(windows[0]?.title, "ChatGPT");
  assert.equal(windows[0]?.pid, 123);
  assert.equal(windows[0]?.maximizedHorizontal, true);
});

test("desktop agent decodes a structured display list", () => {
  const displays = decodeDesktopDisplayList([{
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
    modes: [],
    clones: [],
    replicationSource: 0,
    connectorType: 6,
  }]);
  assert.equal(displays[0]?.name, "HDMI-A-1");
  assert.equal(displays[0]?.currentMode?.refreshRate, 100);
  assert.equal(displays[0]?.active, true);
});

test("desktop agent decodes a structured process list", () => {
  const processes = decodeDesktopProcessList([{
    pid: 2501,
    ppid: 1,
    uid: 1000,
    sameUser: true,
    name: "ChatGPT",
    state: "S (sleeping)",
    executable: "/opt/ChatGPT/chatgpt",
    threads: 24,
    residentMemoryBytes: 134217728,
    virtualMemoryBytes: 1073741824,
    windowIds: ["{11111111-2222-3333-4444-555555555555}"],
    windowCount: 1,
    hasWindow: true,
  }]);
  assert.equal(processes[0]?.name, "ChatGPT");
  assert.equal(processes[0]?.sameUser, true);
  assert.equal(processes[0]?.windowCount, 1);
});

test("desktop agent decodes a recent activity timeline", () => {
  const timeline = decodeDesktopActivityTimeline({
    cursor: 15,
    events: [{
      sequence: 12,
      timestamp: "2026-09-20T01:00:00.000Z",
      type: "window.created",
      sourceModule: "windows",
      entityId: "window-1",
      correlationId: "pid:2501",
      applicationId: "chatgpt",
      pid: 2501,
      title: "ChatGPT",
      summary: "Window opened: ChatGPT.",
    }, {
      sequence: 13,
      timestamp: "2026-09-20T01:00:01.000Z",
      type: "audio.route.created",
      sourceModule: "audio",
      entityId: "88",
      correlationId: "pid:1800836",
      applicationId: "Discord",
      pid: 1800836,
      summary: "Audio route created: Shiryu Microphone 1 → WEBRTC VoiceEngine.",
    }, {
      sequence: 14,
      timestamp: "2026-09-20T01:00:02.000Z",
      type: "device.connected",
      sourceModule: "devices",
      entityId: "usb:3-2.3.1",
      correlationId: "device:usb:3-2.3.1",
      applicationId: "usb:usb-device",
      summary: "Device connected: Index HMD [usb].",
    }, {
      sequence: 15,
      timestamp: "2026-09-20T01:00:03.000Z",
      type: "window.focused",
      sourceModule: "accessibility",
      entityId: "2501:main-window",
      correlationId: "pid:2501",
      applicationId: "chatgpt",
      pid: 2501,
      title: "ChatGPT",
      summary: "Window focused: ChatGPT; focused control role button.",
    }],
  });
  assert.equal(timeline.cursor, 15);
  assert.equal(timeline.events[0]?.type, "window.created");
  assert.equal(timeline.events[0]?.correlationId, "pid:2501");
  assert.equal(timeline.events[1]?.type, "audio.route.created");
  assert.equal(timeline.events[1]?.sourceModule, "audio");
  assert.equal(timeline.events[2]?.type, "device.connected");
  assert.equal(timeline.events[2]?.sourceModule, "devices");
  assert.equal(timeline.events[3]?.type, "window.focused");
  assert.equal(timeline.events[3]?.sourceModule, "accessibility");
});

test("desktop agent decodes a structured PipeWire audio graph", () => {
  const graph = decodeDesktopAudioGraph({
    generatedAt: "2026-09-20T02:00:00.000Z",
    nodes: [{
      id: 91,
      name: "shiryu.input.1.clean",
      mediaClass: "Audio/Source",
      state: "running",
      description: "Shiryu Microphone 1",
      applicationName: "Shiryu Audio",
      sampleRate: 48000,
      isStream: false,
      isSink: false,
      isSource: true,
    }, {
      id: 200,
      name: "WEBRTC VoiceEngine",
      mediaClass: "Stream/Input/Audio",
      state: "running",
      applicationName: "WEBRTC VoiceEngine",
      applicationBinary: "Discord",
      pid: 1800836,
      targetObject: "shiryu.input.1.clean",
      sampleRate: 48000,
      latency: "256/48000",
      volume: 0.75,
      mute: false,
      channelVolumes: [0.7, 0.8],
      channelMap: ["FL", "FR"],
      softMute: false,
      softVolumes: [1, 1],
      monitorMute: false,
      monitorVolumes: [1, 1],
      audioFormat: "F32LE",
      channels: 2,
      streamLive: true,
      corked: false,
      processLatencyQuantum: 64,
      processLatencyRate: 48000,
      processLatencyNs: 1333333,
      isStream: true,
      isSink: false,
      isSource: false,
    }],
    ports: [{ id: 210, nodeId: 91, name: "capture_FL", direction: "out", channel: "FL" }],
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
  });
  assert.equal(graph.nodes[1]?.applicationBinary, "Discord");
  assert.equal(graph.nodes[1]?.volume, 0.75);
  assert.deepEqual(graph.nodes[1]?.channelVolumes, [0.7, 0.8]);
  assert.deepEqual(graph.nodes[1]?.channelMap, ["FL", "FR"]);
  assert.equal(graph.nodes[1]?.audioFormat, "F32LE");
  assert.equal(graph.nodes[1]?.channels, 2);
  assert.equal(graph.nodes[1]?.processLatencyNs, 1333333);
  assert.equal(graph.links[0]?.outputNodeName, "Shiryu Microphone 1");
  assert.equal(graph.links[0]?.inputNodeName, "WEBRTC VoiceEngine");
});

test("desktop agent decodes a structured PipeWire runtime snapshot", () => {
  const runtime = decodeDesktopAudioRuntime({
    generatedAt: "2026-09-20T02:00:01.000Z",
    samplingIterations: 2,
    nodes: [{
      id: 196,
      stateCode: "R",
      running: true,
      quantum: 300,
      rate: 48000,
      waitUsec: 19.5,
      busyUsec: 8.3,
      waitRatio: 0.01,
      busyRatio: 0,
      errors: 24,
      audioFormat: "F32LE",
      channels: 2,
      formatRate: 48000,
      name: "plasmashell",
    }],
  });
  assert.equal(runtime.samplingIterations, 2);
  assert.equal(runtime.nodes[0]?.running, true);
  assert.equal(runtime.nodes[0]?.errors, 24);
  assert.equal(runtime.nodes[0]?.audioFormat, "F32LE");
  assert.equal(runtime.nodes[0]?.waitUsec, 19.5);
});

test("desktop agent decodes a structured device list without raw serial or Bluetooth address fields", () => {
  const devices = decodeDesktopDeviceList([{
    id: "usb:3-2.3.1",
    subsystem: "usb",
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
    mountpoints: [],
  }, {
    id: "bluetooth:1837773865b35b47",
    subsystem: "bluetooth",
    category: "bluetooth-device",
    name: "Xbox Wireless Controller",
    transport: "bluetooth",
    connected: false,
    hotplug: true,
    removable: true,
    paired: true,
    mountpoints: [],
  }]);
  assert.equal(devices[0]?.name, "Index HMD");
  assert.equal(devices[1]?.subsystem, "bluetooth");
  assert.equal(devices[1]?.paired, true);
  assert.equal(Object.hasOwn(devices[1] ?? {}, "serial"), false);
  assert.equal(Object.hasOwn(devices[1] ?? {}, "address"), false);
});

test("desktop agent decodes a structured network snapshot", () => {
  const network = decodeDesktopNetworkSnapshot({
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
      addresses: [{ family: "ipv4", address: "192.168.1.10", prefixLength: 24, scope: "global", dynamic: true }],
    }],
    routes: [{ family: "ipv4", destination: "default", gateway: "192.168.1.1", interfaceName: "enp5s0", table: "main", protocol: "dhcp", linkDown: false }],
    dnsServers: [{ interfaceName: "enp5s0", address: "192.168.1.1" }],
    listeners: [{ protocol: "tcp", address: "127.0.0.1", port: 7676, processName: "node", pid: 1234 }],
    cloudflareTunnel: { running: true, pids: [4321] },
  });
  assert.equal(network.interfaces[0]?.name, "enp5s0");
  assert.equal(network.listeners[0]?.port, 7676);
  assert.equal(network.cloudflareTunnel.running, true);
});

test("desktop agent decodes a structured virtual desktop snapshot", () => {
  const snapshot = decodeDesktopVirtualDesktopSnapshot({
    generatedAt: "2026-09-20T06:50:00.000Z",
    currentId: "desktop-2",
    count: 2,
    rows: 1,
    navigationWrappingAround: false,
    desktops: [
      { position: 0, id: "desktop-1", name: "Main", current: false },
      { position: 1, id: "desktop-2", name: "VR", current: true },
    ],
  });
  assert.equal(snapshot.currentId, "desktop-2");
  assert.equal(snapshot.desktops[1]?.name, "VR");
  assert.equal(snapshot.desktops[1]?.current, true);
});

test("desktop agent decodes a structured browser session snapshot", () => {
  const snapshot = decodeDesktopBrowserSessionSnapshot({
    browser: "Opera/123.0",
    capturedAt: "2026-09-21T03:40:00.000Z",
    tabs: [
      { id: "page-1", type: "page", title: "Inbox", url: "https://example.com/mail" },
    ],
  });
  assert.equal(snapshot.browser, "Opera/123.0");
  assert.equal(snapshot.tabs.length, 1);
  assert.equal(snapshot.tabs[0]?.url, "https://example.com/mail");
  assert.throws(
    () => decodeDesktopBrowserSessionSnapshot({ ...snapshot, tabs: [{ id: "page-1" }] }),
    /browserTab.type/,
  );
});

test("desktop agent decodes structured filesystem watch results", () => {
  const watch = decodeDesktopFilesystemWatchInfo({
    id: "fswatch:123",
    path: "/tmp/project",
    recursive: true,
    startedAt: "2026-09-20T12:00:00.000Z",
    eventCount: 2,
    lastEventAt: "2026-09-20T12:00:01.000Z",
    state: "ready",
  });
  assert.equal(watch.eventCount, 2);
  assert.equal(decodeDesktopFilesystemWatchList([watch]).length, 1);
});

test("desktop agent decodes a structured notification control result", () => {
  const result = decodeDesktopNotificationControlResult({
    type: "invoke-action",
    id: "dbus::1.5:9",
    notificationId: 15,
    actionId: "default",
    completed: true,
    completedAt: "2026-09-20T06:21:00.000Z",
  });
  assert.equal(result.completed, true);
  assert.equal(result.actionId, "default");
});

test("desktop agent decodes a structured notification list", () => {
  const notifications = decodeDesktopNotificationList([{
    id: "dbus::1.1209:9",
    notificationId: 15,
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
    closedAt: "2026-09-20T06:20:01.000Z",
    closeReason: 2,
  }]);
  assert.equal(notifications[0]?.notificationId, 15);
  assert.equal(notifications[0]?.pid, 9460);
  assert.equal(notifications[0]?.actions[0]?.label, "Open");
  assert.equal(notifications[0]?.closeReason, 2);
});

test("desktop agent decodes log sources and explicit bounded log reads", () => {
  const sources = decodeDesktopLogSources([{
    id: "journal:_SYSTEMD_USER_UNIT:cGxhc21hLXBsYXNtYXNoZWxsLnNlcnZpY2U",
    kind: "journal",
    label: "plasma-plasmashell.service",
    selector: "_SYSTEMD_USER_UNIT=plasma-plasmashell.service",
    lastSeen: "2026-09-20T03:00:00.000Z",
    sampledEntries: 42,
  }]);
  assert.equal(sources[0]?.label, "plasma-plasmashell.service");

  const logs = decodeDesktopLogReadResult({
    sourceId: sources[0]?.id,
    generatedAt: "2026-09-20T03:01:00.000Z",
    query: "render",
    entries: [{
      timestamp: "2026-09-20T03:00:59.000Z",
      priority: 6,
      unit: "plasma-plasmashell.service",
      identifier: "plasmashell",
      processName: "plasmashell",
      pid: 2237,
      message: "render completed",
    }],
  });
  assert.equal(logs.entries[0]?.pid, 2237);
  assert.equal(logs.entries[0]?.message, "render completed");
});

test("desktop agent decodes correlated activity and journal entries", () => {
  const trace = decodeDesktopTraceCorrelation({
    correlationId: "pid:9460",
    generatedAt: "2026-09-20T03:05:00.000Z",
    events: [{
      sequence: 10,
      timestamp: "2026-09-20T03:04:59.000Z",
      type: "network.listener.opened",
      sourceModule: "network",
      entityId: "tcp|127.0.0.1|7676|||node|9460",
      correlationId: "pid:9460",
      applicationId: "node",
      pid: 9460,
      summary: "Network listener opened.",
    }],
    logs: {
      sourceId: "pid:9460",
      generatedAt: "2026-09-20T03:05:00.000Z",
      entries: [{ timestamp: "2026-09-20T03:04:59.500Z", pid: 9460, processName: "node", message: "http_request" }],
    },
  });
  assert.equal(trace.events[0]?.correlationId, "pid:9460");
  assert.equal(trace.logs?.entries[0]?.pid, 9460);
});

test("desktop agent decodes a bounded ShiryuGen generation trace", () => {
  const trace = decodeDesktopShiryuGenGenerationTrace({
    traceId: "shiryugen-generate-abc-123",
    found: true,
    action: "generate",
    state: "completed",
    startedAt: "2026-09-20T12:00:00.000Z",
    endedAt: "2026-09-20T12:00:05.000Z",
    durationMs: 5000,
    promptId: "prompt-abc",
    outputPath: "/tmp/generated.png",
    durablePath: "/tmp/attachments/generated.png",
    attachmentId: "generated-image-1",
    relatedPaths: ["/tmp/generated.png", "/tmp/attachments/generated.png"],
    stages: [{
      stage: "comfyui.queued",
      spanName: "shiryugen.generation.comfyui.queued",
      action: "generate",
      startedAt: "2026-09-20T12:00:01.000Z",
      endedAt: "2026-09-20T12:00:01.005Z",
      durationMs: 5,
      outcome: "ok",
      details: { promptId: "prompt-abc", pollAttempt: 1, formatterFallback: false },
      sourceFile: "/home/okashi/.t3/userdata/logs/server.trace.ndjson",
    }],
    filesystemEvents: [],
    sourceFiles: ["/home/okashi/.t3/userdata/logs/server.trace.ndjson"],
    recordsScanned: 42,
    bytesScanned: 4096,
  });
  assert.equal(trace.promptId, "prompt-abc");
  assert.equal(trace.stages[0]?.details.pollAttempt, 1);
  assert.equal(trace.stages[0]?.details.formatterFallback, false);
  assert.throws(() => decodeDesktopShiryuGenGenerationTrace({ ...trace, state: "mystery" }), /Invalid ShiryuGen trace state/);
});

test("desktop agent response and status decode capability states", () => {
  const response = decodeDesktopAgentResponse({
    requestId: "request-1",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    ok: true,
    result: {
      state: "ready",
      protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
      pid: 123,
      endpoint: "/tmp/desktop.sock",
      startedAt: "2026-09-20T00:00:00.000Z",
      platform: "linux",
      sessionType: "x11",
      clientConnections: 1,
      capabilities: [
        { id: "windows", state: "not_implemented" },
        {
          id: "apps-shiryugen-trace",
          state: "ready",
          sourceKind: "application-adapter",
          sourcePriority: "secondary",
          application: "ShiryuGen",
          optional: true,
        },
      ],
    },
  });
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const status = decodeDesktopAgentStatus(response.result);
  assert.equal(status.platform, "linux");
  assert.deepEqual(status.capabilities, [
    {
      id: "windows",
      state: "not_implemented",
      detail: undefined,
      sourceKind: undefined,
      sourcePriority: undefined,
      application: undefined,
      optional: undefined,
    },
    {
      id: "apps-shiryugen-trace",
      state: "ready",
      detail: undefined,
      sourceKind: "application-adapter",
      sourcePriority: "secondary",
      application: "ShiryuGen",
      optional: true,
    },
  ]);
});
