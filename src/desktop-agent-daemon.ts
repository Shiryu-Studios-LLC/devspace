import { timingSafeEqual } from "node:crypto";
import { DesktopActivityMonitor } from "./desktop-activity-monitor.js";
import {
  getPipeWireAudioGraph,
  pipeWireAudioAwarenessAvailable,
} from "./desktop-audio-pipewire.js";
import {
  linuxDeviceAwarenessAvailable,
  listLinuxDevices,
} from "./desktop-devices-linux.js";
import {
  getLinuxNetworkSnapshot,
  linuxNetworkAwarenessAvailable,
} from "./desktop-network-linux.js";
import {
  getKdeVirtualDesktopSnapshot,
  kdeVirtualDesktopAwarenessAvailable,
} from "./desktop-virtual-desktops-kde.js";
import {
  linuxLogAwarenessAvailable,
  listLinuxLogSources,
  readLinuxLogs,
  readLinuxLogsForPid,
} from "./desktop-logs-linux.js";
import {
  LinuxNotificationMonitor,
  linuxNotificationAwarenessAvailable,
  type DesktopNotificationMonitor,
} from "./desktop-notifications-linux.js";
import { appendFileSync, chmodSync, rmSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import {
  DESKTOP_AGENT_PROTOCOL_VERSION,
  DesktopAgentAlreadyRunningError,
  DesktopAgentLock,
  desktopAgentPaths,
  ensureDesktopAgentSecret,
  ensureDesktopAgentStateDir,
  removeDesktopAgentRuntimeFiles,
  type DesktopAgentPaths,
} from "./desktop-agent-lifecycle.js";
import {
  decodeDesktopAgentRequest,
  encodeDesktopAgentResponse,
  DesktopAgentProtocolError,
  type DesktopAgentRequest,
  type DesktopAgentStatus,
  type DesktopAudioGraph,
  type DesktopCapabilityStatus,
  type DesktopDeviceInfo,
  type DesktopDisplayInfo,
  type DesktopNetworkSnapshot,
  type DesktopVirtualDesktopSnapshot,
  type DesktopNotificationInfo,
  type DesktopLogReadResult,
  type DesktopLogSource,
  type DesktopTraceCorrelation,
  type DesktopProcessInfo,
  type DesktopWindowInfo,
} from "./desktop-agent-protocol.js";
import {
  kdeWindowAwarenessAvailable,
  listKdeWindows,
} from "./desktop-windows-kde.js";
import {
  kdeDisplayAwarenessAvailable,
  listKdeDisplays,
} from "./desktop-displays-kde.js";
import {
  linuxProcessAwarenessAvailable,
  listLinuxProcesses,
} from "./desktop-processes-linux.js";

const MAX_REQUEST_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface DesktopAgentDaemonOptions {
  stateDir: string;
  paths?: DesktopAgentPaths;
  capabilities?: () => DesktopCapabilityStatus[];
  windows?: () => Promise<DesktopWindowInfo[]>;
  displays?: () => Promise<DesktopDisplayInfo[]>;
  processes?: () => Promise<DesktopProcessInfo[]>;
  audioGraph?: () => Promise<DesktopAudioGraph>;
  devices?: () => Promise<DesktopDeviceInfo[]>;
  networkSnapshot?: () => Promise<DesktopNetworkSnapshot>;
  virtualDesktops?: () => Promise<DesktopVirtualDesktopSnapshot>;
  logSources?: () => Promise<DesktopLogSource[]>;
  readLogs?: (sourceId: string, options?: { lines?: number; query?: string }) => Promise<DesktopLogReadResult>;
  readLogsForPid?: (pid: number, options?: { lines?: number; query?: string }) => Promise<DesktopLogReadResult>;
  notificationMonitor?: DesktopNotificationMonitor;
  notifications?: () => Promise<DesktopNotificationInfo[]>;
  activityMonitor?: DesktopActivityMonitor;
  now?: () => number;
  onClosed?: () => void;
}

export class DesktopAgentDaemon {
  readonly paths: DesktopAgentPaths;
  private readonly lock: DesktopAgentLock;
  private readonly capabilitiesProvider: () => DesktopCapabilityStatus[];
  private readonly windowsProvider: () => Promise<DesktopWindowInfo[]>;
  private readonly displaysProvider: () => Promise<DesktopDisplayInfo[]>;
  private readonly processesProvider: () => Promise<DesktopProcessInfo[]>;
  private readonly audioGraphProvider: () => Promise<DesktopAudioGraph>;
  private readonly devicesProvider: () => Promise<DesktopDeviceInfo[]>;
  private readonly networkSnapshotProvider: () => Promise<DesktopNetworkSnapshot>;
  private readonly virtualDesktopsProvider: () => Promise<DesktopVirtualDesktopSnapshot>;
  private readonly logSourcesProvider: () => Promise<DesktopLogSource[]>;
  private readonly readLogsProvider: (sourceId: string, options?: { lines?: number; query?: string }) => Promise<DesktopLogReadResult>;
  private readonly readLogsForPidProvider: (pid: number, options?: { lines?: number; query?: string }) => Promise<DesktopLogReadResult>;
  private readonly notificationMonitor?: DesktopNotificationMonitor;
  private readonly notificationsProvider: () => Promise<DesktopNotificationInfo[]>;
  private readonly activityMonitor: DesktopActivityMonitor;
  private readonly now: () => number;
  private readonly onClosed?: () => void;
  private readonly sockets = new Set<Socket>();
  private server?: NetServer;
  private authToken?: string;
  private startedAt?: string;
  private stopping = false;
  private ownsLock = false;
  private closePromise?: Promise<void>;

  constructor(options: DesktopAgentDaemonOptions) {
    this.paths = options.paths ?? desktopAgentPaths(options.stateDir);
    this.lock = new DesktopAgentLock(this.paths);
    this.capabilitiesProvider = options.capabilities ?? defaultDesktopCapabilities;
    this.windowsProvider = options.windows ?? listKdeWindows;
    this.displaysProvider = options.displays ?? listKdeDisplays;
    this.processesProvider = options.processes ?? defaultProcessInventory;
    this.audioGraphProvider = options.audioGraph ?? getPipeWireAudioGraph;
    this.devicesProvider = options.devices ?? listLinuxDevices;
    this.networkSnapshotProvider = options.networkSnapshot ?? getLinuxNetworkSnapshot;
    this.virtualDesktopsProvider = options.virtualDesktops ?? getKdeVirtualDesktopSnapshot;
    this.logSourcesProvider = options.logSources ?? listLinuxLogSources;
    this.readLogsProvider = options.readLogs ?? readLinuxLogs;
    this.readLogsForPidProvider = options.readLogsForPid ?? readLinuxLogsForPid;
    this.notificationMonitor = options.notificationMonitor ?? (options.notifications ? undefined : new LinuxNotificationMonitor({ now: options.now }));
    this.notificationsProvider = options.notifications ?? (() => Promise.resolve(this.notificationMonitor?.recent() ?? []));
    this.activityMonitor = options.activityMonitor ?? new DesktopActivityMonitor({
      windows: this.windowsProvider,
      displays: this.displaysProvider,
      processes: options.processes ?? (() => listLinuxProcesses([])),
      audio: options.audioGraph ?? (pipeWireAudioAwarenessAvailable() ? this.audioGraphProvider : undefined),
      devices: options.devices ?? (linuxDeviceAwarenessAvailable() ? this.devicesProvider : undefined),
      network: options.networkSnapshot ?? (linuxNetworkAwarenessAvailable() ? this.networkSnapshotProvider : undefined),
      notifications: options.notifications ?? (linuxNotificationAwarenessAvailable() ? this.notificationsProvider : undefined),
      virtualDesktops: options.virtualDesktops ?? (kdeVirtualDesktopAwarenessAvailable() ? this.virtualDesktopsProvider : undefined),
      now: options.now,
    });
    this.now = options.now ?? Date.now;
    this.onClosed = options.onClosed;
  }

  async start(): Promise<DesktopAgentStatus> {
    if (this.server) return this.status();
    ensureDesktopAgentStateDir(this.paths.stateDir);
    let lockAcquired = false;
    try {
      this.lock.acquire();
      lockAcquired = true;
      this.ownsLock = true;
      this.authToken = ensureDesktopAgentSecret(this.paths);
      if (process.platform !== "win32") rmSync(this.paths.socketPath, { force: true });
      const server = createServer((socket) => this.handleConnection(socket));
      this.server = server;
      await listen(server, this.paths.endpoint);
      if (process.platform !== "win32") chmodSync(this.paths.socketPath, 0o600);
      this.startedAt = new Date(this.now()).toISOString();
      this.stopping = false;
      if (this.capabilitiesProvider().find((capability) => capability.id === "notifications")?.state === "ready") {
        this.notificationMonitor?.start();
      }
      if (this.capabilitiesProvider().find((capability) => capability.id === "events")?.state === "ready") {
        this.activityMonitor.start();
      }
      writeDesktopAgentLog(this.paths, "info", "desktop_agent_started", {
        pid: process.pid,
        platform: process.platform,
        sessionType: desktopSessionType(),
      });
      return this.status();
    } catch (error) {
      this.server = undefined;
      this.authToken = undefined;
      if (lockAcquired) {
        removeDesktopAgentRuntimeFiles(this.paths);
        this.lock.release();
        this.ownsLock = false;
      }
      if (error instanceof DesktopAgentAlreadyRunningError) throw error;
      throw error;
    }
  }

  status(): DesktopAgentStatus {
    if (!this.startedAt) throw new Error("Desktop agent is not started.");
    return {
      state: this.stopping ? "stopping" : "ready",
      protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
      pid: process.pid,
      endpoint: this.paths.endpoint,
      startedAt: this.startedAt,
      platform: process.platform,
      sessionType: desktopSessionType(),
      clientConnections: this.sockets.size,
      capabilities: this.capabilitiesProvider(),
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (!this.server && !this.ownsLock) return;
    this.stopping = true;
    this.activityMonitor.stop();
    this.notificationMonitor?.stop();
    this.closePromise = (async () => {
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      await closeServer(this.server).catch((error) => {
        writeDesktopAgentLog(this.paths, "warn", "desktop_agent_socket_close_failed", {
          error: errorMessage(error),
        });
      });
      removeDesktopAgentRuntimeFiles(this.paths);
      this.lock.release();
      this.ownsLock = false;
      this.server = undefined;
      this.authToken = undefined;
      writeDesktopAgentLog(this.paths, "info", "desktop_agent_stopped", {});
      this.onClosed?.();
    })();
    return this.closePromise;
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    const timer = setTimeout(() => {
      if (handled) return;
      handled = true;
      this.writeError(socket, "", "DESKTOP_AGENT_TIMEOUT", "Timed out waiting for a complete request.", true);
      socket.destroy();
    }, REQUEST_TIMEOUT_MS);
    timer.unref();

    socket.on("data", (chunk: string | Buffer) => {
      if (handled) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        handled = true;
        clearTimeout(timer);
        this.writeError(socket, "", "DESKTOP_AGENT_INVALID_REQUEST", "Desktop agent request is too large.");
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      clearTimeout(timer);
      void this.handleLine(socket, buffer.slice(0, newline));
    });
    socket.on("error", () => clearTimeout(timer));
    socket.on("close", () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let requestId = "";
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new DesktopAgentProtocolError("INVALID_REQUEST", "Desktop agent request is not valid JSON.");
      }
      requestId = typeof (parsed as { requestId?: unknown })?.requestId === "string"
        ? String((parsed as { requestId: string }).requestId)
        : "";
      const request = decodeDesktopAgentRequest(parsed);
      const result = await this.dispatch(request);
      socket.end(encodeDesktopAgentResponse({
        requestId: request.requestId,
        protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
        ok: true,
        result,
      }));
      if (request.method === "desktop.stop") setImmediate(() => { void this.close(); });
    } catch (error) {
      const protocolError = error instanceof DesktopAgentProtocolError ? error : undefined;
      this.writeError(
        socket,
        requestId,
        protocolError?.code ?? "DESKTOP_AGENT_INTERNAL_ERROR",
        protocolError?.message ?? errorMessage(error),
        false,
      );
    }
  }

  private async dispatch(request: DesktopAgentRequest): Promise<unknown> {
    if (request.protocolVersion !== DESKTOP_AGENT_PROTOCOL_VERSION) {
      throw new DesktopAgentProtocolError(
        "DESKTOP_AGENT_PROTOCOL_MISMATCH",
        `Unsupported desktop agent protocol ${request.protocolVersion}; expected ${DESKTOP_AGENT_PROTOCOL_VERSION}.`,
      );
    }
    this.assertAuthenticated(request.authToken);
    if (this.stopping && request.method !== "hello" && request.method !== "desktop.status") {
      throw new DesktopAgentProtocolError("DESKTOP_AGENT_STOPPING", "Desktop agent is stopping.");
    }

    switch (request.method) {
      case "hello":
      case "desktop.status":
        return this.status();
      case "desktop.capabilities":
        return this.capabilitiesProvider();
      case "windows.list": {
        const windowsCapability = this.capabilitiesProvider().find((capability) => capability.id === "windows");
        if (windowsCapability?.state !== "ready") {
          throw new DesktopAgentProtocolError(
            "DESKTOP_WINDOWS_UNAVAILABLE",
            windowsCapability?.detail ?? "Window awareness is unavailable.",
          );
        }
        return this.windowsProvider();
      }
      case "displays.list": {
        const displaysCapability = this.capabilitiesProvider().find((capability) => capability.id === "displays");
        if (displaysCapability?.state !== "ready") {
          throw new DesktopAgentProtocolError(
            "DESKTOP_DISPLAYS_UNAVAILABLE",
            displaysCapability?.detail ?? "Display awareness is unavailable.",
          );
        }
        return this.displaysProvider();
      }
      case "processes.list": {
        const processesCapability = this.capabilitiesProvider().find((capability) => capability.id === "processes");
        if (processesCapability?.state !== "ready") {
          throw new DesktopAgentProtocolError(
            "DESKTOP_PROCESSES_UNAVAILABLE",
            processesCapability?.detail ?? "Process awareness is unavailable.",
          );
        }
        return this.processesProvider();
      }
      case "events.recent": {
        const eventsCapability = this.capabilitiesProvider().find((capability) => capability.id === "events");
        if (eventsCapability?.state !== "ready") {
          throw new DesktopAgentProtocolError(
            "DESKTOP_EVENTS_UNAVAILABLE",
            eventsCapability?.detail ?? "Activity timeline is unavailable.",
          );
        }
        return {
          cursor: this.activityMonitor.cursor(),
          events: this.activityMonitor.recent(),
        };
      }
      case "audio.graph": {
        const audioCapability = this.capabilitiesProvider().find((capability) => capability.id === "audio");
        if (audioCapability?.state !== "ready") {
          throw new DesktopAgentProtocolError(
            "DESKTOP_AUDIO_UNAVAILABLE",
            audioCapability?.detail ?? "Audio awareness is unavailable.",
          );
        }
        return this.audioGraphProvider();
      }
      case "devices.list": {
        const devicesCapability = this.capabilitiesProvider().find((capability) => capability.id === "devices");
        if (devicesCapability?.state !== "ready") {
          throw new DesktopAgentProtocolError(
            "DESKTOP_DEVICES_UNAVAILABLE",
            devicesCapability?.detail ?? "Device awareness is unavailable.",
          );
        }
        return this.devicesProvider();
      }
      case "network.snapshot": {
        const networkCapability = this.capabilitiesProvider().find((capability) => capability.id === "network");
        if (networkCapability?.state !== "ready") {
          throw new DesktopAgentProtocolError(
            "DESKTOP_NETWORK_UNAVAILABLE",
            networkCapability?.detail ?? "Network awareness is unavailable.",
          );
        }
        return this.networkSnapshotProvider();
      }
      case "virtual-desktops.snapshot": {
        const capability = this.capabilitiesProvider().find((item) => item.id === "virtual-desktops");
        if (capability?.state !== "ready") {
          throw new DesktopAgentProtocolError(
            "DESKTOP_VIRTUAL_DESKTOPS_UNAVAILABLE",
            capability?.detail ?? "Virtual desktop awareness is unavailable.",
          );
        }
        return this.virtualDesktopsProvider();
      }
      case "logs.sources": {
        const logsCapability = this.capabilitiesProvider().find((capability) => capability.id === "logs");
        if (logsCapability?.state !== "ready") {
          throw new DesktopAgentProtocolError(
            "DESKTOP_LOGS_UNAVAILABLE",
            logsCapability?.detail ?? "Log awareness is unavailable.",
          );
        }
        return this.logSourcesProvider();
      }
      case "logs.read": {
        const logsCapability = this.capabilitiesProvider().find((capability) => capability.id === "logs");
        if (logsCapability?.state !== "ready") {
          throw new DesktopAgentProtocolError(
            "DESKTOP_LOGS_UNAVAILABLE",
            logsCapability?.detail ?? "Log awareness is unavailable.",
          );
        }
        return this.readLogsProvider(request.params.sourceId, {
          lines: request.params.lines,
          query: request.params.query,
        });
      }
      case "notifications.recent": {
        const notificationsCapability = this.capabilitiesProvider().find((capability) => capability.id === "notifications");
        if (notificationsCapability?.state !== "ready") {
          throw new DesktopAgentProtocolError(
            "DESKTOP_NOTIFICATIONS_UNAVAILABLE",
            notificationsCapability?.detail ?? "Notification awareness is unavailable.",
          );
        }
        return this.notificationsProvider();
      }
      case "trace.correlate": {
        const tracingCapability = this.capabilitiesProvider().find((capability) => capability.id === "tracing");
        if (tracingCapability?.state !== "ready") {
          throw new DesktopAgentProtocolError(
            "DESKTOP_TRACING_UNAVAILABLE",
            tracingCapability?.detail ?? "Tracing correlation is unavailable.",
          );
        }
        const correlationId = request.params.correlationId;
        const events = this.activityMonitor.recent(1_000).filter((event) => event.correlationId === correlationId);
        const pidMatch = /^pid:(\d+)$/.exec(correlationId);
        let logs: DesktopLogReadResult | undefined;
        if (pidMatch) {
          const pid = Number(pidMatch[1]);
          logs = await this.readLogsForPidProvider(pid, { lines: request.params.lines, query: request.params.query });
        }
        const result: DesktopTraceCorrelation = {
          correlationId,
          generatedAt: new Date(this.now()).toISOString(),
          events,
          logs,
        };
        return result;
      }
      case "desktop.stop":
        this.stopping = true;
        return this.status();
    }
  }

  private assertAuthenticated(token: string): void {
    if (!this.authToken) {
      throw new DesktopAgentProtocolError("DESKTOP_AGENT_UNAVAILABLE", "Desktop agent authentication is unavailable.");
    }
    const expected = Buffer.from(this.authToken, "utf8");
    const actual = Buffer.from(token, "utf8");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new DesktopAgentProtocolError("DESKTOP_AGENT_UNAUTHORIZED", "Desktop agent authentication failed.");
    }
  }

  private writeError(
    socket: Socket,
    requestId: string,
    code: string,
    message: string,
    retryable = false,
  ): void {
    socket.end(encodeDesktopAgentResponse({
      requestId,
      protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
      ok: false,
      error: { code, message, retryable },
    }));
  }
}

export function defaultDesktopCapabilities(): DesktopCapabilityStatus[] {
  const windowsReady = kdeWindowAwarenessAvailable();
  const displaysReady = kdeDisplayAwarenessAvailable();
  const processesReady = linuxProcessAwarenessAvailable();
  const audioReady = pipeWireAudioAwarenessAvailable();
  const devicesReady = linuxDeviceAwarenessAvailable();
  const networkReady = linuxNetworkAwarenessAvailable();
  const logsReady = linuxLogAwarenessAvailable();
  const notificationsReady = linuxNotificationAwarenessAvailable();
  const virtualDesktopsReady = kdeVirtualDesktopAwarenessAvailable();
  const eventsReady = windowsReady || displaysReady || processesReady || audioReady || devicesReady || networkReady || notificationsReady || virtualDesktopsReady;
  const tracingReady = logsReady && eventsReady;
  return [
    windowsReady
      ? { id: "windows", state: "ready", detail: "KDE/KWin D-Bus window inventory" }
      : { id: "windows", state: "unavailable", detail: "KDE/KWin graphical session is unavailable" },
    displaysReady
      ? { id: "displays", state: "ready", detail: "KDE KScreen display inventory" }
      : { id: "displays", state: "unavailable", detail: "KDE KScreen graphical session is unavailable" },
    processesReady
      ? { id: "processes", state: "ready", detail: "Linux /proc process inventory without command-line arguments or environment data" }
      : { id: "processes", state: "unavailable", detail: "Linux /proc is unavailable" },
    { id: "screen", state: "not_implemented" },
    { id: "input", state: "not_implemented" },
    { id: "accessibility", state: "not_implemented" },
    { id: "clipboard", state: "not_implemented" },
    notificationsReady
      ? { id: "notifications", state: "ready", detail: "Read-only bounded in-memory observation of freedesktop notifications delivered through Plasma" }
      : { id: "notifications", state: "unavailable", detail: "Plasma notification D-Bus service is unavailable" },
    audioReady
      ? { id: "audio", state: "ready", detail: "Read-only PipeWire audio nodes, ports, and routing links" }
      : { id: "audio", state: "unavailable", detail: "PipeWire user-session graph is unavailable" },
    devicesReady
      ? { id: "devices", state: "ready", detail: "Read-only Linux USB, PCI, block-storage, and Bluetooth inventory without serial numbers or Bluetooth addresses" }
      : { id: "devices", state: "unavailable", detail: "Linux hardware inventory sources are unavailable" },
    networkReady
      ? { id: "network", state: "ready", detail: "Read-only Linux interfaces, routes, DNS servers, listening sockets, and Cloudflare Tunnel process state" }
      : { id: "network", state: "unavailable", detail: "Linux iproute2 network inventory is unavailable" },
    virtualDesktopsReady
      ? { id: "virtual-desktops", state: "ready", detail: "Read-only KDE virtual desktop list and current desktop state" }
      : { id: "virtual-desktops", state: "unavailable", detail: "KDE virtual desktop manager is unavailable" },
    logsReady
      ? { id: "logs", state: "ready", detail: "Explicit-source bounded reads from the Linux user journal; no arbitrary filesystem paths" }
      : { id: "logs", state: "unavailable", detail: "Linux user journal is unavailable" },
    tracingReady
      ? { id: "tracing", state: "ready", detail: "Correlates bounded activity timeline entries with recent user-journal messages for pid:<pid> correlation IDs" }
      : { id: "tracing", state: "unavailable", detail: "Tracing requires both activity events and Linux user-journal access" },
    eventsReady
      ? { id: "events", state: "ready", detail: "Bounded in-memory process/window/display/audio/device/network/notification/virtual-desktop activity timeline" }
      : { id: "events", state: "unavailable", detail: "No activity sources are available" },
  ];
}

async function defaultProcessInventory(): Promise<DesktopProcessInfo[]> {
  let windows: DesktopWindowInfo[] = [];
  if (kdeWindowAwarenessAvailable()) {
    try {
      windows = await listKdeWindows();
    } catch {
      // Process awareness remains useful even if the compositor cannot provide
      // the current window inventory for correlation.
    }
  }
  return listLinuxProcesses(windows);
}

export function writeDesktopAgentLog(
  paths: DesktopAgentPaths,
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  ensureDesktopAgentStateDir(paths.stateDir);
  appendFileSync(paths.logPath, `${JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  })}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(paths.logPath, 0o600);
}

function desktopSessionType(): string {
  return process.env.XDG_SESSION_TYPE?.trim()
    || (process.env.WAYLAND_DISPLAY ? "wayland" : undefined)
    || (process.env.DISPLAY ? "x11" : undefined)
    || "unknown";
}

function listen(server: NetServer, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

function closeServer(server: NetServer | undefined): Promise<void> {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
