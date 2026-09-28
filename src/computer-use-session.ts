import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DesktopAgentClient } from "./desktop-agent-client.js";
import type { DesktopActivityTimeline, DesktopInputRequest, DesktopInputResult } from "./desktop-agent-protocol.js";

const STARTUP_TIMEOUT_MS = 18_000;
const CONTROL_TIMEOUT_MS = 5_000;
const TAKEOVER_POLL_MS = 350;
const MAX_CONTROL_BYTES = 128 * 1024;
const DEFAULT_IDLE_CLEANUP_MS = 5 * 60 * 1000;
const execFileAsync = promisify(execFile);

export type ComputerUseControlOwner = "agent" | "user";
export type ComputerUseMode = "isolated-window" | "isolated-headless" | "host-fallback";
export type ComputerUseIndicatorState = "idle" | "active" | "controlling" | "waiting" | "user" | "error";

export interface ComputerUseStatus {
  state: "stopped" | "starting" | "ready" | "stopping" | "error";
  mode: ComputerUseMode;
  controlOwner: ComputerUseControlOwner;
  sessionId?: string;
  sessionPid?: number;
  compositorPid?: number;
  agentPid?: number;
  width?: number;
  height?: number;
  startedAt?: string;
  indicatorState: ComputerUseIndicatorState;
  viewerVisible: boolean;
  fallbackReason?: string;
}

export interface ComputerUseStartOptions {
  width?: number;
  height?: number;
  headless?: boolean;
  allowHostFallback?: boolean;
  indicator?: boolean;
  background?: boolean;
}

interface SessionMetadata {
  sessionId: string;
  mode?: ComputerUseMode;
  hostPid: number;
  kwinPid?: number;
  agentPid?: number;
  startedAt: string;
  controlSocket: string;
  waylandDisplay?: string;
  display?: string;
  dbusSessionBusAddress?: string;
  xdgRuntimeDir?: string;
}

interface ControlResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export class ComputerUseUserControlError extends Error {
  readonly code = "COMPUTER_USE_USER_CONTROL" as const;
  constructor() {
    super("The user currently has control of the DevSpace computer-use desktop. Wait for them to return control before sending mouse or keyboard input.");
    this.name = "ComputerUseUserControlError";
  }
}

export class ComputerUseSessionManager {
  readonly computerStateDir: string;
  readonly agentStateDir: string;
  readonly indicatorStatePath: string;
  private readonly sessionPath: string;
  private readonly hostClient: DesktopAgentClient;
  private readonly isolatedClient: DesktopAgentClient;
  private active = false;
  private state: ComputerUseStatus["state"] = "stopped";
  private mode: ComputerUseMode = "host-fallback";
  private owner: ComputerUseControlOwner = "agent";
  private indicatorState: ComputerUseIndicatorState = "idle";
  private viewerVisible = false;
  private sessionId: string | undefined;
  private sessionPid: number | undefined;
  private width: number | undefined;
  private height: number | undefined;
  private startedAt: string | undefined;
  private fallbackReason: string | undefined;
  private sessionProcess: ChildProcess | undefined;
  private indicatorProcess: ChildProcess | undefined;
  private takeoverTimer: NodeJS.Timeout | undefined;
  private idleCleanupTimer: NodeJS.Timeout | undefined;
  private activityCursor = 0;

  constructor(readonly stateDir: string, hostClient?: DesktopAgentClient) {
    this.computerStateDir = resolve(stateDir, "computer-use");
    this.agentStateDir = join(this.computerStateDir, "desktop-agent");
    this.sessionPath = join(this.computerStateDir, "session.json");
    this.indicatorStatePath = join(this.computerStateDir, "indicator.json");
    this.hostClient = hostClient ?? new DesktopAgentClient({ stateDir });
    this.isolatedClient = new DesktopAgentClient({
      stateDir: this.agentStateDir,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      spawnDaemon: () => undefined,
    });
    ensurePrivateDirectory(this.computerStateDir);
    ensurePrivateDirectory(this.agentStateDir);
    if (existsSync(this.indicatorStatePath)) this.restorePersistedControlState();
    else this.writeIndicator("idle");
  }

  routedClient(): DesktopAgentClient {
    return this.active ? this.isolatedClient : this.hostClient;
  }

  hostDesktopClient(): DesktopAgentClient {
    return this.hostClient;
  }

  isolatedDesktopClient(): DesktopAgentClient {
    return this.isolatedClient;
  }

  async interactionClient(): Promise<DesktopAgentClient> {
    await this.ensureIsolatedForInteraction();
    if (this.owner !== "agent") throw new ComputerUseUserControlError();
    this.touchInteraction();
    return this.isolatedClient;
  }

  async start(options: ComputerUseStartOptions = {}): Promise<ComputerUseStatus> {
    const existing = await this.refresh();
    if (existing.state === "ready" && existing.mode !== "host-fallback") {
      if (options.indicator !== false) this.ensureIndicator();
      this.touchInteraction();
      return existing;
    }

    this.state = "starting";
    this.owner = "agent";
    this.fallbackReason = undefined;
    this.width = clampDimension(options.width ?? 1440, 640, 3840);
    this.height = clampDimension(options.height ?? 900, 480, 2160);
    this.mode = options.headless ? "isolated-headless" : "isolated-window";
    this.sessionId = randomUUID();
    this.startedAt = new Date().toISOString();
    this.writeIndicator("active");
    if (options.indicator !== false) this.ensureIndicator();

    try {
      const launch = this.sessionLaunchCommand(this.mode);
      rmSync(this.sessionPath, { force: true });
      const child = spawn(launch.file, launch.args, {
        detached: true,
        stdio: "ignore",
        env: launch.env,
      });
      this.sessionProcess = child;
      this.sessionPid = child.pid;
      child.unref();

      await this.isolatedClient.ensureReady();
      const metadata = await waitForSessionMetadata(this.sessionPath, this.sessionId, STARTUP_TIMEOUT_MS);
      this.active = true;
      this.state = "ready";
      this.sessionPid = this.sessionPid ?? metadata.hostPid;
      this.startedAt = metadata.startedAt || this.startedAt;
      this.viewerVisible = this.mode === "isolated-window";
      if (options.background === true && this.mode === "isolated-window") {
        await this.setViewerVisible(false, metadata);
      }
      this.writeIndicator("active");
      this.startTakeoverMonitor();
      this.touchInteraction();
      return this.snapshot(metadata);
    } catch (error) {
      await this.forceStopIsolated().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      if (options.allowHostFallback === true) {
        this.active = false;
        this.state = "ready";
        this.mode = "host-fallback";
        this.fallbackReason = message;
        this.writeIndicator("waiting");
        return this.snapshot();
      }
      this.state = "error";
      this.fallbackReason = message;
      this.writeIndicator("error");
      throw error;
    }
  }

  async refresh(): Promise<ComputerUseStatus> {
    this.restorePersistedControlState();
    const metadata = this.readSessionMetadata();
    if (metadata) {
      const status = await this.isolatedClient.status().catch(() => undefined);
      if (status?.state === "ready") {
        this.active = true;
        this.state = "ready";
        this.mode = metadata.mode === "isolated-headless" || metadata.mode === "isolated-window"
          ? metadata.mode
          : this.mode === "host-fallback"
            ? "isolated-window"
            : this.mode;
        this.sessionId = metadata.sessionId;
        this.startedAt = metadata.startedAt;
        if (this.mode === "isolated-window" && metadata.kwinPid) {
          const windows = await this.hostClient.windows().catch(() => []);
          const viewer = windows.find((window) => window.pid === metadata.kwinPid);
          if (viewer) this.viewerVisible = !viewer.minimized;
        } else {
          this.viewerVisible = false;
        }
        this.startTakeoverMonitor();
        return this.snapshot(metadata);
      }
    }
    if (this.mode === "host-fallback" && this.state === "ready") return this.snapshot();
    this.active = false;
    if (this.state !== "starting" && this.state !== "error") this.state = "stopped";
    if (this.state === "stopped") this.writeIndicator("idle");
    return this.snapshot();
  }

  async stop(): Promise<ComputerUseStatus> {
    this.state = "stopping";
    this.stopIdleCleanup();
    this.stopTakeoverMonitor();
    const metadata = this.readSessionMetadata();
    if (metadata) {
      await requestControl(metadata.controlSocket, { type: "stop" }).catch(() => undefined);
      await waitForSessionTeardown(this.sessionPath, 1_500);
    }
    await this.forceStopIsolated().catch(() => undefined);
    this.active = false;
    this.state = "stopped";
    this.mode = "host-fallback";
    this.owner = "agent";
    this.viewerVisible = false;
    this.sessionId = undefined;
    this.sessionPid = undefined;
    this.startedAt = undefined;
    this.fallbackReason = undefined;
    this.writeIndicator("idle");
    this.stopIndicator();
    return this.snapshot();
  }

  async launch(file: string, args: string[] = [], cwd?: string): Promise<{ pid: number; file: string }> {
    await this.ensureIsolatedForInteraction();
    if (!resolve(file).startsWith("/") || !existsSync(file)) throw new Error("Application path must be an existing absolute path.");
    if (args.length > 256 || args.some((arg) => typeof arg !== "string" || arg.length > 16_384)) {
      throw new Error("Application arguments are invalid or too large.");
    }
    const metadata = this.requireSessionMetadata();
    const response = await requestControl(metadata.controlSocket, {
      type: "launch",
      file,
      args,
      ...(cwd ? { cwd: resolve(cwd) } : {}),
    });
    const pid = typeof response.pid === "number" ? response.pid : undefined;
    if (!pid) throw new Error("Computer-use session did not return an application PID.");
    this.writeIndicator(this.owner === "agent" ? "active" : "user");
    this.touchInteraction();
    return { pid, file };
  }

  async showViewer(): Promise<ComputerUseStatus> {
    const status = await this.refresh();
    if (!this.active || status.state !== "ready" || status.mode === "host-fallback") {
      await this.start({ headless: false, background: false, allowHostFallback: false, indicator: true });
    }
    if (this.mode === "isolated-headless") {
      throw new Error("This Computer Use session was explicitly started as true headless mode and cannot be attached without restarting it. Start without headless mode to use the detachable Agent Desktop viewer.");
    }
    const metadata = this.requireSessionMetadata();
    await this.setViewerVisible(true, metadata);
    this.viewerVisible = true;
    this.touchInteraction();
    return this.snapshot(metadata);
  }

  async hideViewer(): Promise<ComputerUseStatus> {
    const status = await this.refresh();
    if (!this.active || status.state !== "ready" || this.mode !== "isolated-window") return status;
    const metadata = this.requireSessionMetadata();
    await this.setViewerVisible(false, metadata);
    this.viewerVisible = false;
    if (this.owner === "user") this.returnAgentControl();
    else this.touchInteraction();
    return this.snapshot(metadata);
  }

  async agentInput(request: DesktopInputRequest): Promise<DesktopInputResult> {
    await this.ensureIsolatedForInteraction();
    if (this.owner !== "agent") throw new ComputerUseUserControlError();
    this.writeIndicator("controlling");
    try {
      return await this.isolatedClient.input(request);
    } finally {
      if (this.active && this.owner === "agent") {
        this.writeIndicator("active");
        this.touchInteraction();
      }
    }
  }

  takeUserControl(): ComputerUseStatus {
    this.stopIdleCleanup();
    this.owner = "user";
    this.writeIndicator("user");
    return this.snapshot(this.readSessionMetadata());
  }

  returnAgentControl(): ComputerUseStatus {
    this.owner = "agent";
    this.writeIndicator(this.active ? "active" : "idle");
    this.touchInteraction();
    return this.snapshot(this.readSessionMetadata());
  }

  markWaiting(): void {
    this.writeIndicator("waiting");
  }

  markError(): void {
    this.writeIndicator("error");
  }

  private async ensureIsolatedForInteraction(): Promise<void> {
    const status = await this.refresh();
    if (this.active && status.state === "ready" && status.mode !== "host-fallback") {
      this.touchInteraction();
      return;
    }
    await this.start({
      headless: false,
      background: true,
      allowHostFallback: false,
      indicator: true,
    });
    if (!this.active) {
      throw new Error("DevSpace refused to use the physical desktop because an isolated computer-use session could not be started.");
    }
    this.touchInteraction();
  }

  private touchInteraction(): void {
    if (!this.active || this.owner !== "agent") return;
    this.stopIdleCleanup();
    const timeoutMs = computerUseIdleCleanupMs();
    if (timeoutMs <= 0) return;
    this.idleCleanupTimer = setTimeout(() => {
      this.idleCleanupTimer = undefined;
      if (!this.active || this.owner !== "agent") return;
      void this.stop().catch(() => {
        this.state = "error";
        this.writeIndicator("error");
      });
    }, timeoutMs);
    this.idleCleanupTimer.unref();
  }

  private stopIdleCleanup(): void {
    if (this.idleCleanupTimer) clearTimeout(this.idleCleanupTimer);
    this.idleCleanupTimer = undefined;
  }

  private snapshot(metadata = this.readSessionMetadata()): ComputerUseStatus {
    return {
      state: this.state,
      mode: this.mode,
      controlOwner: this.owner,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.sessionPid ? { sessionPid: this.sessionPid } : {}),
      ...(metadata?.kwinPid ? { compositorPid: metadata.kwinPid } : {}),
      ...(metadata?.agentPid ? { agentPid: metadata.agentPid } : {}),
      ...(this.width ? { width: this.width } : {}),
      ...(this.height ? { height: this.height } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      indicatorState: this.indicatorState,
      viewerVisible: this.viewerVisible,
      ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
    };
  }

  private sessionLaunchCommand(mode: ComputerUseMode): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
    if (process.platform !== "linux") throw new Error("Isolated computer-use sessions are currently implemented for Linux/KDE Wayland.");
    const dbusRun = "/usr/bin/dbus-run-session";
    const kwin = "/usr/bin/kwin_wayland";
    if (!existsSync(dbusRun) || !existsSync(kwin)) {
      throw new Error("dbus-run-session and kwin_wayland are required for isolated computer use.");
    }
    const hostExecutable = computerUseSessionHostPath();
    if (!hostExecutable || !existsSync(hostExecutable)) throw new Error("DevSpace computer-use session host is not installed. Rebuild DevSpace first.");
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Unable to resolve the current Linux user ID.");
    const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
    const outerWayland = process.env.WAYLAND_DISPLAY || discoverWaylandDisplay(runtimeDir);
    if (mode === "isolated-window" && !outerWayland) {
      throw new Error("No host Wayland display is available for the isolated computer desktop window.");
    }
    const socketName = `devspace-computer-${createHash("sha256").update(this.computerStateDir).digest("hex").slice(0, 10)}`;
    const kwinArgs = [
      kwin,
      ...(mode === "isolated-headless" ? ["--virtual"] : ["--wayland-display", outerWayland!]),
      "--width", String(this.width),
      "--height", String(this.height),
      "--scale", "1",
      "--socket", socketName,
      "--xwayland",
      "--no-lockscreen",
      "--no-global-shortcuts",
      "--desktopfile", "org.shiryustudios.DevSpace.ComputerUse",
      "--exit-with-session", hostExecutable,
    ];
    return {
      file: dbusRun,
      args: ["--", ...kwinArgs],
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: runtimeDir,
        ...(outerWayland ? { WAYLAND_DISPLAY: outerWayland } : {}),
        DEVSPACE_COMPUTER_USE_STATE_DIR: this.computerStateDir,
        DEVSPACE_COMPUTER_USE_AGENT_STATE_DIR: this.agentStateDir,
        DEVSPACE_COMPUTER_USE_SESSION_ID: this.sessionId,
        DEVSPACE_COMPUTER_USE_MODE: mode,
        DEVSPACE_COMPUTER_USE_WIDTH: String(this.width),
        DEVSPACE_COMPUTER_USE_HEIGHT: String(this.height),
      },
    };
  }

  private async setViewerVisible(visible: boolean, metadata = this.requireSessionMetadata()): Promise<void> {
    if (this.mode !== "isolated-window" || !metadata.kwinPid) {
      if (visible) throw new Error("The current Computer Use session does not have an attachable Agent Desktop viewer.");
      this.viewerVisible = false;
      return;
    }
    const qdbus = "/usr/bin/qdbus6";
    if (!existsSync(qdbus)) throw new Error("qdbus6 is required to show or hide the Agent Desktop viewer on KDE Wayland.");
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Unable to resolve the current Linux user ID for Agent Desktop viewer control.");
    const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
    const dbusEnv = {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus`,
    };
    const scriptPath = join(this.computerStateDir, `viewer-${randomUUID()}.js`);
    const pluginName = `devspace-computer-use-viewer-${randomUUID()}`;
    const script = [
      `const targetPid = ${metadata.kwinPid};`,
      `const makeVisible = ${visible ? "true" : "false"};`,
      "for (const window of workspace.windowList()) {",
      "    if (Number(window.pid) !== targetPid) continue;",
      "    window.minimized = !makeVisible;",
      "}",
    ].join("\n") + "\n";
    writeFileSync(scriptPath, script, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(scriptPath, 0o600);
    try {
      await execFileAsync(qdbus, [
        "org.kde.KWin",
        "/Scripting",
        "org.kde.kwin.Scripting.unloadScript",
        pluginName,
      ], { env: dbusEnv }).catch(() => undefined);
      await execFileAsync(qdbus, [
        "org.kde.KWin",
        "/Scripting",
        "org.kde.kwin.Scripting.loadScript",
        scriptPath,
        pluginName,
      ], { env: dbusEnv });
      await execFileAsync(qdbus, [
        "org.kde.KWin",
        "/Scripting",
        "org.kde.kwin.Scripting.start",
      ], { env: dbusEnv });
      await delay(120);
      const windows = await this.hostClient.windows().catch(() => []);
      const viewer = windows.find((window) => window.pid === metadata.kwinPid);
      if (!viewer || viewer.minimized === visible) {
        throw new Error(`KWin did not ${visible ? "show" : "hide"} the Agent Desktop viewer.`);
      }
      this.viewerVisible = visible;
    } finally {
      await execFileAsync(qdbus, [
        "org.kde.KWin",
        "/Scripting",
        "org.kde.kwin.Scripting.unloadScript",
        pluginName,
      ], { env: dbusEnv }).catch(() => undefined);
      rmSync(scriptPath, { force: true });
    }
  }

  private async forceStopIsolated(): Promise<void> {
    this.stopIdleCleanup();
    this.stopTakeoverMonitor();
    const metadata = this.readSessionMetadata();
    for (const pid of [metadata?.hostPid, metadata?.kwinPid, this.sessionPid]) {
      if (!pid || pid === process.pid) continue;
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    if (this.sessionProcess && this.sessionProcess.exitCode === null) {
      try { this.sessionProcess.kill("SIGTERM"); } catch { /* already gone */ }
    }
    this.sessionProcess = undefined;
    this.viewerVisible = false;
    await this.isolatedClient.stop().catch(() => undefined);
    rmSync(join(this.computerStateDir, "control.sock"), { force: true });
    rmSync(this.sessionPath, { force: true });
  }

  private requireSessionMetadata(): SessionMetadata {
    const metadata = this.readSessionMetadata();
    if (!metadata) throw new Error("Computer-use session metadata is unavailable.");
    return metadata;
  }

  private readSessionMetadata(): SessionMetadata | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.sessionPath, "utf8")) as Partial<SessionMetadata>;
      if (!parsed || parsed.sessionId !== this.sessionId && this.sessionId !== undefined) return undefined;
      if (typeof parsed.sessionId !== "string" || typeof parsed.hostPid !== "number" || typeof parsed.controlSocket !== "string") return undefined;
      return parsed as SessionMetadata;
    } catch {
      return undefined;
    }
  }

  private writeIndicator(state: ComputerUseIndicatorState): void {
    this.indicatorState = state;
    ensurePrivateDirectory(this.computerStateDir);
    const payload = {
      state,
      controlOwner: this.owner,
      sessionState: this.state,
      mode: this.mode,
      viewerVisible: this.viewerVisible,
      controllerPid: process.pid,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(this.indicatorStatePath, JSON.stringify(payload) + "\n", { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(this.indicatorStatePath, 0o600);
  }

  private ensureIndicator(): void {
    if (process.platform !== "linux") return;
    if (this.indicatorProcess && this.indicatorProcess.exitCode === null) return;
    const helper = computerUseIndicatorPath();
    if (!helper || !existsSync(helper)) return;
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
    const wayland = process.env.WAYLAND_DISPLAY || discoverWaylandDisplay(runtimeDir);
    if (!wayland) return;
    const child = spawn(helper, [this.indicatorStatePath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: runtimeDir,
        WAYLAND_DISPLAY: wayland,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus`,
      },
    });
    this.indicatorProcess = child;
    child.unref();
  }

  private stopIndicator(): void {
    if (!this.indicatorProcess) return;
    try { this.indicatorProcess.kill("SIGTERM"); } catch { /* already gone */ }
    this.indicatorProcess = undefined;
  }

  private startTakeoverMonitor(): void {
    if (this.takeoverTimer || !this.active) return;
    const poll = async () => {
      try {
        const metadata = this.readSessionMetadata();
        if (!metadata?.kwinPid) return;
        const [timeline, windows] = await Promise.all([
          this.hostClient.recentActivity(),
          this.hostClient.windows(),
        ]);
        this.consumeTakeoverEvents(timeline, metadata.kwinPid);
        const viewer = windows.find((window) => window.pid === metadata.kwinPid);
        if (this.mode === "isolated-window" && this.owner === "user" && (!viewer || viewer.minimized)) {
          // A user-owned viewer being closed/minimized is an explicit end-of-use signal.
          // User-owned sessions do not use idle cleanup, so leaving them alive here would
          // strand the physical-desktop edge indicator indefinitely.
          void this.stop().catch(() => {
            this.state = "error";
            this.writeIndicator("error");
          });
          return;
        }
        if (this.owner === "agent" && viewer && /\bungrab pointer\b/i.test(viewer.title)) {
          this.takeUserControl();
        }
      } catch {
        // Host focus/window telemetry is best effort; isolated input remains safe even without it.
      }
    };
    this.takeoverTimer = setInterval(() => { void poll(); }, TAKEOVER_POLL_MS);
    this.takeoverTimer.unref();
    void poll();
  }

  private stopTakeoverMonitor(): void {
    if (this.takeoverTimer) clearInterval(this.takeoverTimer);
    this.takeoverTimer = undefined;
  }

  private restorePersistedControlState(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.indicatorStatePath, "utf8")) as Record<string, unknown>;
      if (parsed.controlOwner === "agent" || parsed.controlOwner === "user") this.owner = parsed.controlOwner;
      if (typeof parsed.viewerVisible === "boolean") this.viewerVisible = parsed.viewerVisible;
      if (
        parsed.state === "idle" || parsed.state === "active" || parsed.state === "controlling"
        || parsed.state === "waiting" || parsed.state === "user" || parsed.state === "error"
      ) this.indicatorState = parsed.state;
    } catch {
      // Missing or partially-written state is harmless; the next state transition rewrites it.
    }
  }

  private consumeTakeoverEvents(timeline: DesktopActivityTimeline, compositorPid: number): void {
    const events = timeline.events.filter((event) => event.sequence > this.activityCursor);
    if (timeline.cursor > this.activityCursor) this.activityCursor = timeline.cursor;
    if (this.owner !== "agent") return;
    for (const event of events) {
      if (event.pid !== compositorPid) continue;
      if (event.type === "window.focused") {
        this.takeUserControl();
        return;
      }
      if (event.type === "window.changed" && /grab pointer|release pointer|ungrab pointer/i.test(event.title ?? event.summary)) {
        this.takeUserControl();
        return;
      }
    }
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function computerUseIdleCleanupMs(): number {
  const raw = process.env.DEVSPACE_COMPUTER_USE_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_IDLE_CLEANUP_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_IDLE_CLEANUP_MS;
  if (parsed <= 0) return 0;
  return Math.max(30_000, Math.min(60 * 60 * 1000, Math.round(parsed)));
}

function clampDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function discoverWaylandDisplay(runtimeDir: string): string | undefined {
  try {
    return readdirSync(runtimeDir)
      .filter((name) => /^wayland-\d+$/.test(name))
      .sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]))[0];
  } catch {
    return undefined;
  }
}

function computerUseSessionHostPath(): string | undefined {
  const installed = fileURLToPath(new URL("./bin/devspace-computer-use-session-host", import.meta.url));
  if (existsSync(installed)) return installed;
  const developmentBuild = fileURLToPath(new URL("../dist/bin/devspace-computer-use-session-host", import.meta.url));
  return existsSync(developmentBuild) ? developmentBuild : undefined;
}

function computerUseIndicatorPath(): string | undefined {
  const built = fileURLToPath(new URL("./bin/devspace-computer-use-indicator", import.meta.url));
  return existsSync(built) ? built : undefined;
}

async function waitForSessionMetadata(path: string, sessionId: string, timeoutMs: number): Promise<SessionMetadata> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as SessionMetadata;
      if (parsed.sessionId === sessionId && parsed.controlSocket) return parsed;
    } catch {
      // Session host has not published its state yet.
    }
    await delay(80);
  }
  throw new Error("The isolated computer-use session did not publish its runtime metadata before the startup timeout.");
}

async function waitForSessionTeardown(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return;
    await delay(50);
  }
}

async function requestControl(socketPath: string, payload: Record<string, unknown>): Promise<ControlResponse> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finishError = (error: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() => finishError(new Error("Computer-use control request timed out.")), CONTROL_TIMEOUT_MS);
    timer.unref();
    socket.once("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", (chunk: string | Buffer) => {
      if (settled) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer, "utf8") > MAX_CONTROL_BYTES) {
        finishError(new Error("Computer-use control response is too large."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as ControlResponse;
        if (!response.ok) throw new Error(response.error || "Computer-use control request failed.");
        resolvePromise(response);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      finishError(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (!settled) finishError(new Error("Computer-use control socket closed before a response was received."));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
