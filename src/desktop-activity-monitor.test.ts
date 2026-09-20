import assert from "node:assert/strict";
import test from "node:test";
import { DesktopActivityMonitor } from "./desktop-activity-monitor.js";
import type {
  DesktopAudioGraph,
  DesktopDisplayInfo,
  DesktopProcessInfo,
  DesktopWindowInfo,
} from "./desktop-agent-protocol.js";

test("desktop activity monitor establishes a silent baseline and records bounded diffs", async () => {
  let now = Date.parse("2026-09-20T01:00:00.000Z");
  let windows: DesktopWindowInfo[] = [windowInfo("window-1", 101, "ChatGPT", 0)];
  let processes: DesktopProcessInfo[] = [processInfo(101, "ChatGPT")];
  let displays: DesktopDisplayInfo[] = [displayInfo("HDMI-A-1", 100, 0.8)];

  const monitor = new DesktopActivityMonitor({
    windows: async () => windows,
    processes: async () => processes,
    displays: async () => displays,
    maxEvents: 4,
    now: () => now,
  });

  await monitor.sample();
  assert.equal(monitor.cursor(), 0);
  assert.deepEqual(monitor.recent(), []);

  now += 1_000;
  windows = [
    windowInfo("window-1", 101, "ChatGPT", 25),
    windowInfo("window-2", 202, "Discord", 100),
  ];
  processes = [processInfo(202, "Discord")];
  displays = [displayInfo("HDMI-A-1", 120, 0.7)];
  await monitor.sample();

  assert.equal(monitor.cursor(), 5);
  const events = monitor.recent();
  assert.equal(events.length, 4, "oldest event should be evicted by the bounded buffer");
  assert.deepEqual(events.map((event) => event.type), [
    "process.stopped",
    "window.changed",
    "window.created",
    "display.changed",
  ]);
  assert.equal(events[1]?.correlationId, "pid:101");
  assert.equal(events[2]?.correlationId, "pid:202");
  assert.equal(events[3]?.correlationId, "display:HDMI-A-1");
  assert.equal(events[3]?.timestamp, "2026-09-20T01:00:01.000Z");
});

test("desktop activity monitor records PipeWire stream and route changes", async () => {
  let audio = audioGraph(
    [
      audioStream(200, "WEBRTC VoiceEngine", 1800836, "running", "shiryu.input.1.clean"),
    ],
    [audioLink(88, 91, 200, "Shiryu Microphone 1", "WEBRTC VoiceEngine")],
  );
  const monitor = new DesktopActivityMonitor({
    windows: async () => [],
    processes: async () => [],
    displays: async () => [],
    audio: async () => audio,
  });

  await monitor.sample();
  assert.equal(monitor.cursor(), 0, "initial PipeWire graph should establish a silent baseline");

  audio = audioGraph(
    [
      audioStream(200, "WEBRTC VoiceEngine", 1800836, "idle", "shiryu.input.2.clean"),
      audioStream(300, "Spotify", 333, "running", "shiryu.cable.1.input"),
    ],
    [audioLink(99, 300, 81, "Spotify", "Spotify / Music Input")],
  );
  await monitor.sample();

  assert.deepEqual(monitor.recent().map((event) => event.type), [
    "audio.stream.changed",
    "audio.stream.started",
    "audio.route.created",
    "audio.route.removed",
  ]);
  assert.equal(monitor.recent()[0]?.correlationId, "pid:1800836");
  assert.equal(monitor.recent()[1]?.correlationId, "pid:333");
  assert.equal(monitor.recent()[2]?.correlationId, "pid:333");
  assert.equal(monitor.recent()[3]?.correlationId, "pid:1800836");

  audio = audioGraph([], []);
  await monitor.sample();
  assert.deepEqual(monitor.recent(3).map((event) => event.type), [
    "audio.stream.stopped",
    "audio.stream.stopped",
    "audio.route.removed",
  ]);
});

function windowInfo(id: string, pid: number, title: string, x: number): DesktopWindowInfo {
  return {
    id,
    uuid: id,
    title,
    pid,
    processName: title,
    applicationId: title.toLowerCase(),
    x,
    y: 0,
    width: 800,
    height: 600,
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
    activities: [],
  };
}

function processInfo(pid: number, name: string): DesktopProcessInfo {
  return {
    pid,
    ppid: 1,
    uid: 1000,
    sameUser: true,
    name,
    state: "S (sleeping)",
    windowIds: [],
    windowCount: 0,
    hasWindow: false,
  };
}

function displayInfo(name: string, refreshRate: number, brightness: number): DesktopDisplayInfo {
  return {
    id: 1,
    name,
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
    brightness,
    currentModeId: String(refreshRate),
    currentMode: {
      id: String(refreshRate),
      name: `1920x1080@${refreshRate}`,
      width: 1920,
      height: 1080,
      refreshRate,
    },
    preferredModeIds: ["60"],
    modes: [],
    clones: [],
  };
}

function audioGraph(nodes: DesktopAudioGraph["nodes"], links: DesktopAudioGraph["links"]): DesktopAudioGraph {
  return {
    generatedAt: "2026-09-20T02:00:00.000Z",
    nodes: [
      {
        id: 91,
        name: "shiryu.input.1.clean",
        mediaClass: "Audio/Source",
        state: "running",
        description: "Shiryu Microphone 1",
        applicationName: "Shiryu Audio",
        isStream: false,
        isSink: false,
        isSource: true,
      },
      {
        id: 81,
        name: "shiryu.cable.1.input",
        mediaClass: "Audio/Sink",
        state: "running",
        description: "Spotify / Music Input",
        applicationName: "Shiryu Audio",
        isStream: false,
        isSink: true,
        isSource: false,
      },
      ...nodes,
    ],
    ports: [],
    links,
  };
}

function audioStream(
  id: number,
  applicationName: string,
  pid: number,
  state: string,
  targetObject: string,
): DesktopAudioGraph["nodes"][number] {
  return {
    id,
    name: applicationName,
    mediaClass: "Stream/Input/Audio",
    state,
    applicationName,
    applicationBinary: applicationName === "WEBRTC VoiceEngine" ? "Discord" : applicationName,
    pid,
    targetObject,
    sampleRate: 48000,
    isStream: true,
    isSink: false,
    isSource: false,
  };
}

function audioLink(
  id: number,
  outputNodeId: number,
  inputNodeId: number,
  outputNodeName: string,
  inputNodeName: string,
): DesktopAudioGraph["links"][number] {
  return {
    id,
    state: "active",
    outputNodeId,
    outputPortId: id * 2,
    inputNodeId,
    inputPortId: id * 2 + 1,
    outputNodeName,
    inputNodeName,
    outputPortName: "out_FL",
    inputPortName: "in_FL",
  };
}
