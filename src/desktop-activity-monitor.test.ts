import assert from "node:assert/strict";
import test from "node:test";
import { DesktopActivityMonitor } from "./desktop-activity-monitor.js";
import type {
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
