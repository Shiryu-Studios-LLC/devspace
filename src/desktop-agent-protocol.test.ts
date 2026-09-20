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
  decodeDesktopAudioGraph,
  decodeDesktopDisplayList,
  decodeDesktopProcessList,
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

test("desktop agent accepts the read-only audio graph method", () => {
  const request: DesktopAgentRequest = {
    requestId: "request-audio",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken: "a".repeat(64),
    method: "audio.graph",
    params: {},
  };
  assert.deepEqual(decodeDesktopAgentRequest(JSON.parse(encodeDesktopAgentRequest(request))), request);
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
    cursor: 13,
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
    }],
  });
  assert.equal(timeline.cursor, 13);
  assert.equal(timeline.events[0]?.type, "window.created");
  assert.equal(timeline.events[0]?.correlationId, "pid:2501");
  assert.equal(timeline.events[1]?.type, "audio.route.created");
  assert.equal(timeline.events[1]?.sourceModule, "audio");
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
  assert.equal(graph.links[0]?.outputNodeName, "Shiryu Microphone 1");
  assert.equal(graph.links[0]?.inputNodeName, "WEBRTC VoiceEngine");
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
      capabilities: [{ id: "windows", state: "not_implemented" }],
    },
  });
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const status = decodeDesktopAgentStatus(response.result);
  assert.equal(status.platform, "linux");
  assert.deepEqual(status.capabilities, [{ id: "windows", state: "not_implemented", detail: undefined }]);
});
