import type {
  DesktopActivityEvent,
  DesktopDisplayInfo,
  DesktopProcessInfo,
  DesktopWindowInfo,
} from "./desktop-agent-protocol.js";

export interface DesktopActivityMonitorOptions {
  windows: () => Promise<DesktopWindowInfo[]>;
  displays: () => Promise<DesktopDisplayInfo[]>;
  processes: () => Promise<DesktopProcessInfo[]>;
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
  private readonly pollIntervalMs: number;
  private readonly maxEvents: number;
  private readonly now: () => number;
  private readonly events: DesktopActivityEvent[] = [];
  private windows = new Map<string, DesktopWindowInfo>();
  private displays = new Map<string, DesktopDisplayInfo>();
  private processes = new Map<number, DesktopProcessInfo>();
  private initialized = false;
  private polling = false;
  private sequence = 0;
  private timer?: NodeJS.Timeout;

  constructor(options: DesktopActivityMonitorOptions) {
    this.windowsProvider = options.windows;
    this.displaysProvider = options.displays;
    this.processesProvider = options.processes;
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

  async sample(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      // KWin/KScreen providers may use short-lived helper processes such as
      // busctl or kscreen-doctor. Finish those observations before sampling
      // /proc so the activity monitor does not report its own probes as user
      // process start/stop events.
      const [windowsResult, displaysResult] = await Promise.allSettled([
        this.windowsProvider(),
        this.displaysProvider(),
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

      if (!this.initialized) {
        this.windows = nextWindows;
        this.displays = nextDisplays;
        this.processes = nextProcesses;
        this.initialized = true;
        return;
      }

      if (processesResult.status === "fulfilled") this.diffProcesses(this.processes, nextProcesses);
      if (windowsResult.status === "fulfilled") this.diffWindows(this.windows, nextWindows);
      if (displaysResult.status === "fulfilled") this.diffDisplays(this.displays, nextDisplays);

      this.windows = nextWindows;
      this.displays = nextDisplays;
      this.processes = nextProcesses;
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
