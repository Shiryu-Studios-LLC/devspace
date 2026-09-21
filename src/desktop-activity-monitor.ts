import type { DesktopFilesystemChange } from "./desktop-filesystem-watch.js";
import type {
  DesktopActivityEvent,
  DesktopAudioGraph,
  DesktopAudioLink,
  DesktopAudioNode,
  DesktopDeviceInfo,
  DesktopDisplayInfo,
  DesktopNetworkSnapshot,
  DesktopNotificationInfo,
  DesktopVirtualDesktopSnapshot,
  DesktopProcessInfo,
  DesktopWindowInfo,
} from "./desktop-agent-protocol.js";

export interface DesktopActivityMonitorOptions {
  windows: () => Promise<DesktopWindowInfo[]>;
  displays: () => Promise<DesktopDisplayInfo[]>;
  processes: () => Promise<DesktopProcessInfo[]>;
  audio?: () => Promise<DesktopAudioGraph>;
  devices?: () => Promise<DesktopDeviceInfo[]>;
  network?: () => Promise<DesktopNetworkSnapshot>;
  notifications?: () => Promise<DesktopNotificationInfo[]>;
  virtualDesktops?: () => Promise<DesktopVirtualDesktopSnapshot>;
  pollIntervalMs?: number;
  maxEvents?: number;
  now?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_EVENTS = 1_000;

export class DesktopActivityMonitor {
  private readonly windowsProvider: () => Promise<DesktopWindowInfo[]>;
  private readonly displaysProvider: () => Promise<DesktopDisplayInfo[]>;
  private readonly processesProvider: () => Promise<DesktopProcessInfo[]>;
  private readonly audioProvider?: () => Promise<DesktopAudioGraph>;
  private readonly devicesProvider?: () => Promise<DesktopDeviceInfo[]>;
  private readonly networkProvider?: () => Promise<DesktopNetworkSnapshot>;
  private readonly notificationsProvider?: () => Promise<DesktopNotificationInfo[]>;
  private readonly virtualDesktopsProvider?: () => Promise<DesktopVirtualDesktopSnapshot>;
  private readonly pollIntervalMs: number;
  private readonly maxEvents: number;
  private readonly now: () => number;
  private readonly events: DesktopActivityEvent[] = [];
  private windows = new Map<string, DesktopWindowInfo>();
  private displays = new Map<string, DesktopDisplayInfo>();
  private processes = new Map<number, DesktopProcessInfo>();
  private audioNodes = new Map<number, DesktopAudioNode>();
  private audioStreams = new Map<number, DesktopAudioNode>();
  private audioLinks = new Map<number, DesktopAudioLink>();
  private devices = new Map<string, DesktopDeviceInfo>();
  private network?: DesktopNetworkSnapshot;
  private notifications = new Map<string, DesktopNotificationInfo>();
  private virtualDesktops?: DesktopVirtualDesktopSnapshot;
  private initialized = false;
  private lastFocusedWindowKey?: string;
  private polling = false;
  private sequence = 0;
  private timer?: NodeJS.Timeout;

  constructor(options: DesktopActivityMonitorOptions) {
    this.windowsProvider = options.windows;
    this.displaysProvider = options.displays;
    this.processesProvider = options.processes;
    this.audioProvider = options.audio;
    this.devicesProvider = options.devices;
    this.networkProvider = options.network;
    this.notificationsProvider = options.notifications;
    this.virtualDesktopsProvider = options.virtualDesktops;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error("Desktop activity poll interval must be positive.");
    }
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 1) {
      throw new Error("Desktop activity max event count must be a positive integer.");
    }
  }

  start(): void {
    if (this.timer) return;
    void this.sample().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.sample().catch(() => undefined);
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  cursor(): number {
    return this.sequence;
  }

  recent(limit = 200): DesktopActivityEvent[] {
    const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, this.maxEvents)) : 200;
    return this.events.slice(-safeLimit);
  }

  recordFilesystemEvent(event: DesktopFilesystemChange): void {
    this.push({
      type: `filesystem.${event.type}` as "filesystem.created" | "filesystem.changed" | "filesystem.deleted",
      sourceModule: "filesystem",
      entityId: event.path,
      correlationId: `filesystem:${event.path}`,
      title: event.path,
      summary: `Filesystem ${event.type}: ${event.path}.`,
    });
  }

  recordWindowFocus(event: {
    processId: number;
    application: string;
    applicationId: string;
    windowRole: string;
    windowName: string;
    windowAccessibleId: string;
    controlRole: string;
  }): void {
    if (!Number.isSafeInteger(event.processId) || event.processId <= 0) return;
    const windowIdentity = event.windowAccessibleId || `${event.windowRole}:${event.windowName}`;
    const key = `${event.processId}:${windowIdentity}`;
    if (key === this.lastFocusedWindowKey) return;
    this.lastFocusedWindowKey = key;
    const title = event.windowName || event.application || event.applicationId || `pid ${event.processId}`;
    this.push({
      type: "window.focused",
      sourceModule: "accessibility",
      entityId: key,
      correlationId: `pid:${event.processId}`,
      applicationId: event.applicationId || event.application || undefined,
      pid: event.processId,
      title: event.windowName || undefined,
      summary: `Window focused: ${title}${event.controlRole ? `; focused control role ${event.controlRole}` : ""}.`,
    });
  }

  async sample(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      // KWin/KScreen/PipeWire providers may use short-lived helper processes
      // such as busctl, kscreen-doctor, or pw-dump. Finish those observations
      // before sampling /proc so the activity monitor does not report its own
      // probes as user process start/stop events.
      const [windowsResult, displaysResult, audioResult, devicesResult, networkResult, notificationsResult, virtualDesktopsResult] = await Promise.allSettled([
        this.windowsProvider(),
        this.displaysProvider(),
        this.audioProvider ? this.audioProvider() : Promise.resolve(undefined),
        this.devicesProvider ? this.devicesProvider() : Promise.resolve(undefined),
        this.networkProvider ? this.networkProvider() : Promise.resolve(undefined),
        this.notificationsProvider ? this.notificationsProvider() : Promise.resolve(undefined),
        this.virtualDesktopsProvider ? this.virtualDesktopsProvider() : Promise.resolve(undefined),
      ]);
      const processesResult = await Promise.resolve(this.processesProvider()).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );

      const nextWindows = windowsResult.status === "fulfilled"
        ? new Map(windowsResult.value.map((window) => [window.id, window]))
        : this.windows;
      const nextDisplays = displaysResult.status === "fulfilled"
        ? new Map(displaysResult.value.map((display) => [display.name, display]))
        : this.displays;
      const nextProcesses = processesResult.status === "fulfilled"
        ? new Map(processesResult.value.map((processInfo) => [processInfo.pid, processInfo]))
        : this.processes;
      const audioGraph = audioResult.status === "fulfilled" ? audioResult.value : undefined;
      const nextAudioNodes = audioGraph
        ? new Map(audioGraph.nodes.map((node) => [node.id, node]))
        : this.audioNodes;
      const nextAudioStreams = audioGraph
        ? new Map(audioGraph.nodes.filter((node) => node.isStream).map((node) => [node.id, node]))
        : this.audioStreams;
      const nextAudioLinks = audioGraph
        ? new Map(audioGraph.links.map((link) => [link.id, link]))
        : this.audioLinks;
      const deviceList = devicesResult.status === "fulfilled" ? devicesResult.value : undefined;
      const nextDevices = deviceList
        ? new Map(deviceList.map((device) => [device.id, device]))
        : this.devices;
      const nextNetwork = networkResult.status === "fulfilled" ? networkResult.value : undefined;
      const notificationList = notificationsResult.status === "fulfilled" ? notificationsResult.value : undefined;
      const nextNotifications = notificationList
        ? new Map(notificationList.map((notification) => [notification.id, notification]))
        : this.notifications;
      const nextVirtualDesktops = virtualDesktopsResult.status === "fulfilled" ? virtualDesktopsResult.value : undefined;

      if (!this.initialized) {
        this.windows = nextWindows;
        this.displays = nextDisplays;
        this.processes = nextProcesses;
        this.audioNodes = nextAudioNodes;
        this.audioStreams = nextAudioStreams;
        this.audioLinks = nextAudioLinks;
        this.devices = nextDevices;
        this.network = nextNetwork;
        this.notifications = nextNotifications;
        this.virtualDesktops = nextVirtualDesktops;
        this.initialized = true;
        return;
      }

      if (processesResult.status === "fulfilled") this.diffProcesses(this.processes, nextProcesses);
      if (windowsResult.status === "fulfilled") this.diffWindows(this.windows, nextWindows);
      if (displaysResult.status === "fulfilled") this.diffDisplays(this.displays, nextDisplays);
      if (audioGraph) {
        this.diffAudioStreams(this.audioStreams, nextAudioStreams);
        this.diffAudioLinks(this.audioLinks, nextAudioLinks, this.audioNodes, nextAudioNodes);
      }
      if (deviceList) this.diffDevices(this.devices, nextDevices);
      if (nextNetwork && this.network) this.diffNetwork(this.network, nextNetwork);
      if (notificationList) this.diffNotifications(this.notifications, nextNotifications);
      if (nextVirtualDesktops && this.virtualDesktops) this.diffVirtualDesktops(this.virtualDesktops, nextVirtualDesktops);

      this.windows = nextWindows;
      this.displays = nextDisplays;
      this.processes = nextProcesses;
      this.audioNodes = nextAudioNodes;
      this.audioStreams = nextAudioStreams;
      this.audioLinks = nextAudioLinks;
      this.devices = nextDevices;
      this.network = nextNetwork ?? this.network;
      this.notifications = nextNotifications;
      this.virtualDesktops = nextVirtualDesktops ?? this.virtualDesktops;
    } finally {
      this.polling = false;
    }
  }

  private diffProcesses(
    previous: Map<number, DesktopProcessInfo>,
    next: Map<number, DesktopProcessInfo>,
  ): void {
    for (const [pid, processInfo] of next) {
      if (previous.has(pid)) continue;
      this.push({
        type: "process.started",
        sourceModule: "processes",
        entityId: String(pid),
        correlationId: `pid:${pid}`,
        applicationId: processInfo.executable ?? processInfo.name,
        pid,
        summary: `Process started: ${processInfo.name} (pid ${pid}).`,
      });
    }
    for (const [pid, processInfo] of previous) {
      if (next.has(pid)) continue;
      this.push({
        type: "process.stopped",
        sourceModule: "processes",
        entityId: String(pid),
        correlationId: `pid:${pid}`,
        applicationId: processInfo.executable ?? processInfo.name,
        pid,
        summary: `Process stopped: ${processInfo.name} (pid ${pid}).`,
      });
    }
  }

  private diffWindows(
    previous: Map<string, DesktopWindowInfo>,
    next: Map<string, DesktopWindowInfo>,
  ): void {
    for (const [id, window] of next) {
      const old = previous.get(id);
      if (!old) {
        this.push({
          type: "window.created",
          sourceModule: "windows",
          entityId: id,
          correlationId: window.pid !== undefined ? `pid:${window.pid}` : `window:${id}`,
          applicationId: window.applicationId,
          pid: window.pid,
          title: window.title,
          summary: `Window opened: ${window.title || window.applicationId || id}.`,
        });
        continue;
      }
      const changed = changedWindowFields(old, window);
      if (changed.length === 0) continue;
      this.push({
        type: "window.changed",
        sourceModule: "windows",
        entityId: id,
        correlationId: window.pid !== undefined ? `pid:${window.pid}` : `window:${id}`,
        applicationId: window.applicationId,
        pid: window.pid,
        title: window.title,
        summary: `Window changed: ${window.title || window.applicationId || id}; ${changed.join(", ")}.`,
      });
    }
    for (const [id, window] of previous) {
      if (next.has(id)) continue;
      this.push({
        type: "window.closed",
        sourceModule: "windows",
        entityId: id,
        correlationId: window.pid !== undefined ? `pid:${window.pid}` : `window:${id}`,
        applicationId: window.applicationId,
        pid: window.pid,
        title: window.title,
        summary: `Window closed: ${window.title || window.applicationId || id}.`,
      });
    }
  }

  private diffDisplays(
    previous: Map<string, DesktopDisplayInfo>,
    next: Map<string, DesktopDisplayInfo>,
  ): void {
    for (const [name, display] of next) {
      const old = previous.get(name);
      if (!old) {
        this.push({
          type: "display.connected",
          sourceModule: "displays",
          entityId: name,
          correlationId: `display:${name}`,
          summary: `Display appeared: ${name}.`,
        });
        continue;
      }
      if (old.connected && !display.connected) {
        this.push({
          type: "display.disconnected",
          sourceModule: "displays",
          entityId: name,
          correlationId: `display:${name}`,
          summary: `Display disconnected: ${name}.`,
        });
        continue;
      }
      if (!old.connected && display.connected) {
        this.push({
          type: "display.connected",
          sourceModule: "displays",
          entityId: name,
          correlationId: `display:${name}`,
          summary: `Display connected: ${name}.`,
        });
        continue;
      }
      const changed = changedDisplayFields(old, display);
      if (changed.length === 0) continue;
      this.push({
        type: "display.changed",
        sourceModule: "displays",
        entityId: name,
        correlationId: `display:${name}`,
        summary: `Display changed: ${name}; ${changed.join(", ")}.`,
      });
    }
    for (const [name] of previous) {
      if (next.has(name)) continue;
      this.push({
        type: "display.disconnected",
        sourceModule: "displays",
        entityId: name,
        correlationId: `display:${name}`,
        summary: `Display disappeared: ${name}.`,
      });
    }
  }

  private diffAudioStreams(
    previous: Map<number, DesktopAudioNode>,
    next: Map<number, DesktopAudioNode>,
  ): void {
    for (const [id, stream] of next) {
      const old = previous.get(id);
      if (!old) {
        this.push({
          type: "audio.stream.started",
          sourceModule: "audio",
          entityId: String(id),
          correlationId: audioNodeCorrelationId(stream),
          applicationId: audioNodeApplicationId(stream),
          pid: stream.pid,
          summary: `Audio stream started: ${audioNodeLabel(stream)}.`,
        });
        continue;
      }
      const changed = changedAudioStreamFields(old, stream);
      if (changed.length === 0) continue;
      this.push({
        type: "audio.stream.changed",
        sourceModule: "audio",
        entityId: String(id),
        correlationId: audioNodeCorrelationId(stream),
        applicationId: audioNodeApplicationId(stream),
        pid: stream.pid,
        summary: `Audio stream changed: ${audioNodeLabel(stream)}; ${changed.join(", ")}.`,
      });
    }
    for (const [id, stream] of previous) {
      if (next.has(id)) continue;
      this.push({
        type: "audio.stream.stopped",
        sourceModule: "audio",
        entityId: String(id),
        correlationId: audioNodeCorrelationId(stream),
        applicationId: audioNodeApplicationId(stream),
        pid: stream.pid,
        summary: `Audio stream stopped: ${audioNodeLabel(stream)}.`,
      });
    }
  }

  private diffAudioLinks(
    previous: Map<number, DesktopAudioLink>,
    next: Map<number, DesktopAudioLink>,
    previousNodes: Map<number, DesktopAudioNode>,
    nextNodes: Map<number, DesktopAudioNode>,
  ): void {
    for (const [id, link] of next) {
      const old = previous.get(id);
      if (!old) {
        this.push(audioRouteEvent("audio.route.created", link, nextNodes, `Audio route created: ${audioRouteLabel(link)}.`));
        continue;
      }
      const changed = changedAudioLinkFields(old, link);
      if (changed.length === 0) continue;
      this.push(audioRouteEvent(
        "audio.route.changed",
        link,
        nextNodes,
        `Audio route changed: ${audioRouteLabel(link)}; ${changed.join(", ")}.`,
      ));
    }
    for (const [id, link] of previous) {
      if (next.has(id)) continue;
      this.push(audioRouteEvent("audio.route.removed", link, previousNodes, `Audio route removed: ${audioRouteLabel(link)}.`));
    }
  }

  private diffDevices(
    previous: Map<string, DesktopDeviceInfo>,
    next: Map<string, DesktopDeviceInfo>,
  ): void {
    for (const [id, device] of next) {
      const old = previous.get(id);
      if (!old) {
        this.push(deviceEvent("device.connected", device, `Device appeared: ${deviceLabel(device)}.`));
        continue;
      }
      if (!old.connected && device.connected) {
        this.push(deviceEvent("device.connected", device, `Device connected: ${deviceLabel(device)}.`));
        continue;
      }
      if (old.connected && !device.connected) {
        this.push(deviceEvent("device.disconnected", device, `Device disconnected: ${deviceLabel(device)}.`));
        continue;
      }
      const changed = changedDeviceFields(old, device);
      if (changed.length === 0) continue;
      this.push(deviceEvent(
        "device.changed",
        device,
        `Device changed: ${deviceLabel(device)}; ${changed.join(", ")}.`,
      ));
    }
    for (const [id, device] of previous) {
      if (next.has(id)) continue;
      this.push(deviceEvent("device.disconnected", device, `Device disappeared: ${deviceLabel(device)}.`));
    }
  }

  private diffNetwork(previous: DesktopNetworkSnapshot, next: DesktopNetworkSnapshot): void {
    const previousInterfaces = new Map(previous.interfaces.map((item) => [item.name, item]));
    const nextInterfaces = new Map(next.interfaces.map((item) => [item.name, item]));
    const interfaceNames = new Set([...previousInterfaces.keys(), ...nextInterfaces.keys()]);
    for (const name of interfaceNames) {
      const old = previousInterfaces.get(name);
      const current = nextInterfaces.get(name);
      if (old && current && networkInterfaceFingerprint(old) === networkInterfaceFingerprint(current)) continue;
      this.push({
        type: "network.interface.changed",
        sourceModule: "network",
        entityId: name,
        correlationId: `network-interface:${name}`,
        applicationId: name,
        summary: `Network interface changed: ${name}.`,
      });
    }

    if (networkSetFingerprint(previous.routes.map(routeFingerprint)) !== networkSetFingerprint(next.routes.map(routeFingerprint))) {
      this.push({
        type: "network.route.changed",
        sourceModule: "network",
        entityId: "routes",
        correlationId: "network:routes",
        summary: "Network routes changed.",
      });
    }
    if (networkSetFingerprint(previous.dnsServers.map((server) => `${server.interfaceName ?? "global"}|${server.address}`)) !== networkSetFingerprint(next.dnsServers.map((server) => `${server.interfaceName ?? "global"}|${server.address}`))) {
      this.push({
        type: "network.dns.changed",
        sourceModule: "network",
        entityId: "dns",
        correlationId: "network:dns",
        summary: "DNS server configuration changed.",
      });
    }

    const previousListeners = new Map(previous.listeners.map((listener) => [listenerFingerprint(listener), listener]));
    const nextListeners = new Map(next.listeners.map((listener) => [listenerFingerprint(listener), listener]));
    for (const [id, listener] of nextListeners) {
      if (previousListeners.has(id)) continue;
      this.push({
        type: "network.listener.opened",
        sourceModule: "network",
        entityId: id,
        correlationId: listener.pid !== undefined ? `pid:${listener.pid}` : `network-listener:${id}`,
        applicationId: listener.processName,
        pid: listener.pid,
        summary: `Network listener opened: ${listener.protocol.toUpperCase()} ${listener.address}:${listener.port}${listener.processName ? ` (${listener.processName})` : ""}.`,
      });
    }
    for (const [id, listener] of previousListeners) {
      if (nextListeners.has(id)) continue;
      this.push({
        type: "network.listener.closed",
        sourceModule: "network",
        entityId: id,
        correlationId: listener.pid !== undefined ? `pid:${listener.pid}` : `network-listener:${id}`,
        applicationId: listener.processName,
        pid: listener.pid,
        summary: `Network listener closed: ${listener.protocol.toUpperCase()} ${listener.address}:${listener.port}${listener.processName ? ` (${listener.processName})` : ""}.`,
      });
    }

    if (previous.cloudflareTunnel.running !== next.cloudflareTunnel.running) {
      const running = next.cloudflareTunnel.running;
      this.push({
        type: running ? "network.tunnel.started" : "network.tunnel.stopped",
        sourceModule: "network",
        entityId: "cloudflare-tunnel",
        correlationId: "network:cloudflare-tunnel",
        applicationId: "cloudflared",
        pid: next.cloudflareTunnel.pids[0] ?? previous.cloudflareTunnel.pids[0],
        summary: `Cloudflare Tunnel ${running ? "started" : "stopped"}.`,
      });
    }
  }

  private diffNotifications(
    previous: Map<string, DesktopNotificationInfo>,
    next: Map<string, DesktopNotificationInfo>,
  ): void {
    for (const [id, notification] of next) {
      const old = previous.get(id);
      if (!old) {
        this.push({
          type: "notification.created",
          sourceModule: "notifications",
          entityId: id,
          correlationId: notification.pid !== undefined ? `pid:${notification.pid}` : `notification:${id}`,
          applicationId: notification.desktopEntry ?? notification.appName,
          pid: notification.pid,
          title: notification.summary,
          summary: `Notification received from ${notification.appName}: ${notification.summary || "(no title)"}.`,
        });
        if (notification.closedAt) {
          this.push({
            type: "notification.closed",
            sourceModule: "notifications",
            entityId: id,
            correlationId: notification.pid !== undefined ? `pid:${notification.pid}` : `notification:${id}`,
            applicationId: notification.desktopEntry ?? notification.appName,
            pid: notification.pid,
            title: notification.summary,
            summary: `Notification closed from ${notification.appName}: ${notification.summary || "(no title)"}.`,
          });
        }
        continue;
      }
      if (!old.closedAt && notification.closedAt) {
        this.push({
          type: "notification.closed",
          sourceModule: "notifications",
          entityId: id,
          correlationId: notification.pid !== undefined ? `pid:${notification.pid}` : `notification:${id}`,
          applicationId: notification.desktopEntry ?? notification.appName,
          pid: notification.pid,
          title: notification.summary,
          summary: `Notification closed from ${notification.appName}: ${notification.summary || "(no title)"}.`,
        });
      }
    }
  }

  private diffVirtualDesktops(
    previous: DesktopVirtualDesktopSnapshot,
    next: DesktopVirtualDesktopSnapshot,
  ): void {
    const previousMap = new Map(previous.desktops.map((desktop) => [desktop.id, desktop]));
    const nextMap = new Map(next.desktops.map((desktop) => [desktop.id, desktop]));

    for (const [id, desktop] of nextMap) {
      const old = previousMap.get(id);
      if (!old) {
        this.push({
          type: "virtual-desktop.created",
          sourceModule: "virtual-desktops",
          entityId: id,
          correlationId: `virtual-desktop:${id}`,
          title: desktop.name,
          summary: `Virtual desktop created: ${desktop.name}.`,
        });
        continue;
      }
      if (old.name !== desktop.name || old.position !== desktop.position) {
        this.push({
          type: "virtual-desktop.changed",
          sourceModule: "virtual-desktops",
          entityId: id,
          correlationId: `virtual-desktop:${id}`,
          title: desktop.name,
          summary: `Virtual desktop changed: ${desktop.name}.`,
        });
      }
    }

    for (const [id, desktop] of previousMap) {
      if (nextMap.has(id)) continue;
      this.push({
        type: "virtual-desktop.removed",
        sourceModule: "virtual-desktops",
        entityId: id,
        correlationId: `virtual-desktop:${id}`,
        title: desktop.name,
        summary: `Virtual desktop removed: ${desktop.name}.`,
      });
    }

    if (previous.currentId !== next.currentId) {
      const current = nextMap.get(next.currentId);
      this.push({
        type: "virtual-desktop.current.changed",
        sourceModule: "virtual-desktops",
        entityId: next.currentId,
        correlationId: `virtual-desktop:${next.currentId}`,
        title: current?.name,
        summary: `Current virtual desktop changed${current ? ` to ${current.name}` : ""}.`,
      });
    }
  }

  private push(event: Omit<DesktopActivityEvent, "sequence" | "timestamp">): void {
    this.sequence += 1;
    this.events.push({
      ...event,
      sequence: this.sequence,
      timestamp: new Date(this.now()).toISOString(),
    });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }
}

function changedWindowFields(previous: DesktopWindowInfo, next: DesktopWindowInfo): string[] {
  const changed: string[] = [];
  if (previous.title !== next.title) changed.push("title");
  if (previous.x !== next.x || previous.y !== next.y) changed.push("position");
  if (previous.width !== next.width || previous.height !== next.height) changed.push("size");
  if (previous.minimized !== next.minimized) changed.push(next.minimized ? "minimized" : "restored");
  if (previous.fullscreen !== next.fullscreen) changed.push(next.fullscreen ? "fullscreen" : "left fullscreen");
  if (previous.maximizedHorizontal !== next.maximizedHorizontal || previous.maximizedVertical !== next.maximizedVertical) {
    changed.push("maximized state");
  }
  if (previous.applicationId !== next.applicationId) changed.push("application identity");
  if (previous.desktops.join("\0") !== next.desktops.join("\0")) changed.push("desktop membership");
  return changed;
}

function changedDisplayFields(previous: DesktopDisplayInfo, next: DesktopDisplayInfo): string[] {
  const changed: string[] = [];
  if (previous.enabled !== next.enabled) changed.push(next.enabled ? "enabled" : "disabled");
  if (previous.active !== next.active) changed.push(next.active ? "active" : "inactive");
  if (previous.primary !== next.primary) changed.push(next.primary ? "primary" : "not primary");
  if (previous.x !== next.x || previous.y !== next.y) changed.push("position");
  if (previous.width !== next.width || previous.height !== next.height) changed.push("size");
  if (previous.scale !== next.scale) changed.push("scale");
  if (previous.rotation !== next.rotation) changed.push("rotation");
  if (previous.currentModeId !== next.currentModeId) changed.push("mode");
  if (previous.brightness !== next.brightness) changed.push("brightness");
  return changed;
}

function changedAudioStreamFields(previous: DesktopAudioNode, next: DesktopAudioNode): string[] {
  const changed: string[] = [];
  if (previous.state !== next.state) changed.push(`state ${previous.state ?? "unknown"} → ${next.state ?? "unknown"}`);
  if (previous.targetObject !== next.targetObject) changed.push("target route");
  if (previous.sampleRate !== next.sampleRate) changed.push("sample rate");
  if (previous.latency !== next.latency) changed.push("latency");
  if (previous.mediaClass !== next.mediaClass) changed.push("media class");
  if (audioNodeApplicationId(previous) !== audioNodeApplicationId(next)) changed.push("application identity");
  return changed;
}

function changedAudioLinkFields(previous: DesktopAudioLink, next: DesktopAudioLink): string[] {
  const changed: string[] = [];
  // PipeWire commonly toggles link transport state between active and paused
  // while keeping the same routing topology. Stream state events already carry
  // that activity signal, so route events stay focused on topology changes.
  if (
    previous.outputNodeId !== next.outputNodeId
    || previous.outputPortId !== next.outputPortId
    || previous.inputNodeId !== next.inputNodeId
    || previous.inputPortId !== next.inputPortId
  ) {
    changed.push("endpoints");
  }
  if (
    previous.outputNodeName !== next.outputNodeName
    || previous.inputNodeName !== next.inputNodeName
    || previous.outputPortName !== next.outputPortName
    || previous.inputPortName !== next.inputPortName
  ) {
    changed.push("route identity");
  }
  return changed;
}

function changedDeviceFields(previous: DesktopDeviceInfo, next: DesktopDeviceInfo): string[] {
  const changed: string[] = [];
  if (previous.driver !== next.driver) changed.push("driver");
  if (previous.transport !== next.transport) changed.push("transport");
  if (previous.speed !== next.speed) changed.push("speed");
  if (previous.paired !== next.paired) changed.push(next.paired ? "paired" : "unpaired");
  if (previous.removable !== next.removable) changed.push("removable state");
  if (previous.hotplug !== next.hotplug) changed.push("hotplug state");
  if (previous.sizeBytes !== next.sizeBytes) changed.push("size");
  if (previous.mountpoints.join("\0") !== next.mountpoints.join("\0")) changed.push("mountpoints");
  if (previous.name !== next.name || previous.vendor !== next.vendor || previous.model !== next.model) changed.push("identity metadata");
  return changed;
}

function networkInterfaceFingerprint(networkInterface: DesktopNetworkSnapshot["interfaces"][number]): string {
  return JSON.stringify({
    kind: networkInterface.kind,
    linkType: networkInterface.linkType,
    operState: networkInterface.operState,
    mtu: networkInterface.mtu,
    up: networkInterface.up,
    lowerUp: networkInterface.lowerUp,
    loopback: networkInterface.loopback,
    addresses: networkInterface.addresses
      .map((address) => `${address.family}|${address.address}|${address.prefixLength}|${address.scope ?? ""}|${address.dynamic ?? false}`)
      .sort(),
  });
}

function routeFingerprint(route: DesktopNetworkSnapshot["routes"][number]): string {
  return [
    route.family,
    route.destination,
    route.gateway ?? "",
    route.interfaceName ?? "",
    route.table ?? "",
    route.protocol ?? "",
    route.scope ?? "",
    route.preferredSource ?? "",
    route.metric ?? "",
    route.type ?? "",
    route.linkDown ? "down" : "up",
  ].join("|");
}

function listenerFingerprint(listener: DesktopNetworkSnapshot["listeners"][number]): string {
  return [
    listener.protocol,
    listener.address,
    listener.port,
    listener.interfaceName ?? "",
    listener.processName ?? "",
    listener.pid ?? "",
  ].join("|");
}

function networkSetFingerprint(values: string[]): string {
  return values.slice().sort().join("\n");
}

function deviceEvent(
  type: "device.connected" | "device.disconnected" | "device.changed",
  device: DesktopDeviceInfo,
  summary: string,
): Omit<DesktopActivityEvent, "sequence" | "timestamp"> {
  return {
    type,
    sourceModule: "devices",
    entityId: device.id,
    correlationId: `device:${device.id}`,
    applicationId: `${device.subsystem}:${device.category}`,
    summary,
  };
}

function deviceLabel(device: DesktopDeviceInfo): string {
  return `${device.name} [${device.subsystem}]`;
}

function audioNodeApplicationId(node: DesktopAudioNode): string {
  return node.applicationBinary
    ?? node.applicationName
    ?? node.mediaName
    ?? node.description
    ?? node.name;
}

function audioNodeCorrelationId(node: DesktopAudioNode): string {
  return node.pid !== undefined ? `pid:${node.pid}` : `audio-node:${node.id}`;
}

function audioNodeLabel(node: DesktopAudioNode): string {
  const label = node.applicationName ?? node.mediaName ?? node.description ?? node.name;
  return node.state ? `${label} (${node.state})` : label;
}

function audioRouteEvent(
  type: "audio.route.created" | "audio.route.removed" | "audio.route.changed",
  link: DesktopAudioLink,
  nodes: Map<number, DesktopAudioNode>,
  summary: string,
): Omit<DesktopActivityEvent, "sequence" | "timestamp"> {
  const inputNode = nodes.get(link.inputNodeId);
  const outputNode = nodes.get(link.outputNodeId);
  const stream = [inputNode, outputNode].find((node) => node?.isStream) ?? inputNode ?? outputNode;
  return {
    type,
    sourceModule: "audio",
    entityId: String(link.id),
    correlationId: stream ? audioNodeCorrelationId(stream) : `audio-route:${link.id}`,
    applicationId: stream ? audioNodeApplicationId(stream) : undefined,
    pid: stream?.pid,
    summary,
  };
}

function audioRouteLabel(link: DesktopAudioLink): string {
  const output = link.outputPortName ? `${link.outputNodeName}:${link.outputPortName}` : link.outputNodeName;
  const input = link.inputPortName ? `${link.inputNodeName}:${link.inputPortName}` : link.inputNodeName;
  return `${output} → ${input}`;
}
