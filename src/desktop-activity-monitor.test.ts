import assert from "node:assert/strict";
import test from "node:test";
import { DesktopActivityMonitor } from "./desktop-activity-monitor.js";
import type {
  DesktopAudioGraph,
  DesktopDeviceInfo,
  DesktopDisplayInfo,
  DesktopNetworkSnapshot,
  DesktopNotificationInfo,
  DesktopVirtualDesktopSnapshot,
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

test("desktop activity monitor records network interface, route, DNS, listener, and tunnel changes", async () => {
  let network = networkSnapshot({
    listenerPort: 7676,
    dns: "1.1.1.1",
    routeGateway: "192.168.1.254",
    tunnelRunning: true,
    interfaceUp: true,
  });
  const monitor = new DesktopActivityMonitor({
    windows: async () => [],
    processes: async () => [],
    displays: async () => [],
    network: async () => network,
  });

  await monitor.sample();
  assert.equal(monitor.cursor(), 0, "initial network snapshot should establish a silent baseline");

  network = networkSnapshot({
    listenerPort: 7677,
    dns: "1.0.0.1",
    routeGateway: "192.168.1.1",
    tunnelRunning: false,
    interfaceUp: false,
  });
  await monitor.sample();

  assert.deepEqual(monitor.recent().map((event) => event.type), [
    "network.interface.changed",
    "network.route.changed",
    "network.dns.changed",
    "network.listener.opened",
    "network.listener.closed",
    "network.tunnel.stopped",
  ]);
  assert.equal(monitor.recent()[0]?.sourceModule, "network");
  assert.equal(monitor.recent()[3]?.correlationId, "pid:999");
  assert.equal(monitor.recent()[5]?.correlationId, "network:cloudflare-tunnel");
});

test("desktop activity monitor records notification creation and closure", async () => {
  let notifications: DesktopNotificationInfo[] = [];
  const monitor = new DesktopActivityMonitor({
    windows: async () => [],
    processes: async () => [],
    displays: async () => [],
    notifications: async () => notifications,
  });

  await monitor.sample();
  notifications = [{
    id: "dbus::1.1209:9",
    notificationId: 15,
    appName: "DevSpace Test",
    summary: "Awareness test",
    body: "Read-only observation.",
    pid: 9460,
    desktopEntry: "devspace",
    actions: [],
    expireTimeoutMs: -1,
    createdAt: "2026-09-20T06:20:00.000Z",
  }];
  await monitor.sample();
  assert.deepEqual(monitor.recent().map((event) => event.type), ["notification.created"]);
  assert.equal(monitor.recent()[0]?.correlationId, "pid:9460");
  assert.equal(monitor.recent()[0]?.sourceModule, "notifications");

  notifications = [{
    ...notifications[0]!,
    closedAt: "2026-09-20T06:20:01.000Z",
    closeReason: 2,
  }];
  await monitor.sample();
  assert.deepEqual(monitor.recent(2).map((event) => event.type), ["notification.created", "notification.closed"]);
});

test("desktop activity monitor records virtual desktop creation, removal, metadata, and current changes", async () => {
  let virtualDesktops: DesktopVirtualDesktopSnapshot = {
    generatedAt: "2026-09-20T06:50:00.000Z",
    currentId: "desktop-1",
    count: 1,
    rows: 1,
    navigationWrappingAround: false,
    desktops: [{ position: 0, id: "desktop-1", name: "Main", current: true }],
  };
  const monitor = new DesktopActivityMonitor({
    windows: async () => [],
    processes: async () => [],
    displays: async () => [],
    virtualDesktops: async () => virtualDesktops,
  });

  await monitor.sample();
  assert.equal(monitor.cursor(), 0);

  virtualDesktops = {
    generatedAt: "2026-09-20T06:50:01.000Z",
    currentId: "desktop-2",
    count: 2,
    rows: 1,
    navigationWrappingAround: false,
    desktops: [
      { position: 0, id: "desktop-1", name: "Work", current: false },
      { position: 1, id: "desktop-2", name: "VR", current: true },
    ],
  };
  await monitor.sample();
  assert.deepEqual(monitor.recent().map((event) => event.type), [
    "virtual-desktop.changed",
    "virtual-desktop.created",
    "virtual-desktop.current.changed",
  ]);
  assert.equal(monitor.recent().at(-1)?.correlationId, "virtual-desktop:desktop-2");

  virtualDesktops = {
    generatedAt: "2026-09-20T06:50:02.000Z",
    currentId: "desktop-2",
    count: 1,
    rows: 1,
    navigationWrappingAround: false,
    desktops: [{ position: 0, id: "desktop-2", name: "VR", current: true }],
  };
  await monitor.sample();
  assert.equal(monitor.recent().at(-1)?.type, "virtual-desktop.removed");
});

test("desktop activity monitor records device connection, disconnection, and metadata changes", async () => {
  let devices: DesktopDeviceInfo[] = [
    bluetoothDevice("bluetooth:xbox", false),
    usbDevice("usb:index", "Index HMD"),
    blockDevice("block:sda", []),
  ];
  const monitor = new DesktopActivityMonitor({
    windows: async () => [],
    processes: async () => [],
    displays: async () => [],
    devices: async () => devices,
  });

  await monitor.sample();
  assert.equal(monitor.cursor(), 0, "initial hardware inventory should establish a silent baseline");

  devices = [
    bluetoothDevice("bluetooth:xbox", true),
    blockDevice("block:sda", ["/mnt/Development"]),
    usbDevice("usb:kraken", "Razer Kraken V3"),
  ];
  await monitor.sample();

  assert.deepEqual(monitor.recent().map((event) => event.type), [
    "device.connected",
    "device.changed",
    "device.connected",
    "device.disconnected",
  ]);
  assert.equal(monitor.recent()[0]?.correlationId, "device:bluetooth:xbox");
  assert.match(monitor.recent()[1]?.summary ?? "", /mountpoints/);
  assert.equal(monitor.recent()[2]?.correlationId, "device:usb:kraken");
  assert.equal(monitor.recent()[3]?.correlationId, "device:usb:index");
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

function networkSnapshot(options: {
  listenerPort: number;
  dns: string;
  routeGateway: string;
  tunnelRunning: boolean;
  interfaceUp: boolean;
}): DesktopNetworkSnapshot {
  return {
    generatedAt: "2026-09-20T03:00:00.000Z",
    interfaces: [{
      index: 2,
      name: "enp6s0",
      kind: "ethernet",
      linkType: "ether",
      operState: options.interfaceUp ? "UP" : "DOWN",
      mtu: 1500,
      up: options.interfaceUp,
      lowerUp: options.interfaceUp,
      loopback: false,
      addresses: options.interfaceUp
        ? [{ family: "ipv4", address: "192.168.1.208", prefixLength: 24, scope: "global", dynamic: true }]
        : [],
    }],
    routes: [{
      family: "ipv4",
      destination: "default",
      gateway: options.routeGateway,
      interfaceName: "enp6s0",
      protocol: "dhcp",
      linkDown: !options.interfaceUp,
    }],
    dnsServers: [{ interfaceName: "enp6s0", address: options.dns }],
    listeners: [{ protocol: "tcp", address: "127.0.0.1", port: options.listenerPort, processName: "node", pid: 999 }],
    cloudflareTunnel: { running: options.tunnelRunning, pids: options.tunnelRunning ? [1877] : [] },
  };
}

function bluetoothDevice(id: string, connected: boolean): DesktopDeviceInfo {
  return {
    id,
    subsystem: "bluetooth",
    category: "bluetooth-device",
    name: "Xbox Wireless Controller",
    transport: "bluetooth",
    connected,
    hotplug: true,
    removable: true,
    paired: true,
    mountpoints: [],
  };
}

function usbDevice(id: string, name: string): DesktopDeviceInfo {
  return {
    id,
    subsystem: "usb",
    category: "usb-device",
    name,
    vendor: name === "Index HMD" ? "Valve" : "Razer",
    transport: "usb",
    connected: true,
    hotplug: true,
    removable: true,
    mountpoints: [],
  };
}

function blockDevice(id: string, mountpoints: string[]): DesktopDeviceInfo {
  return {
    id,
    subsystem: "block",
    category: "disk",
    name: "TEAM T2532TB",
    vendor: "ATA",
    model: "TEAM T2532TB",
    path: "/dev/sda",
    transport: "sata",
    connected: true,
    hotplug: false,
    removable: false,
    sizeBytes: 2048408248320,
    mountpoints,
  };
}
