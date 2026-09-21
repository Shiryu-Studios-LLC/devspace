import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_AGENT_PROTOCOL_VERSION,
  desktopAgentProtocolSupported,
  desktopAgentPaths,
  readDesktopAgentSecret,
  type DesktopAgentPaths,
} from "./desktop-agent-lifecycle.js";
import {
  decodeDesktopActivityTimeline,
  decodeDesktopAgentResponse,
  decodeDesktopAudioGraph,
  decodeDesktopAudioRuntime,
  decodeDesktopAgentStatus,
  decodeDesktopPermissionStatuses,
  decodeDesktopDeviceList,
  decodeDesktopDisplayList,
  decodeDesktopNetworkSnapshot,
  decodeDesktopVirtualDesktopSnapshot,
  decodeDesktopBrowserSessionSnapshot,
  decodeDesktopNotificationList,
  decodeDesktopNotificationControlResult,
  decodeDesktopFilesystemWatchInfo,
  decodeDesktopFilesystemWatchList,
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
  type DesktopActivityTimeline,
  type DesktopAgentMethod,
  type DesktopAudioGraph,
  type DesktopAudioRuntimeSnapshot,
  type DesktopAgentRequest,
  type DesktopAgentResponse,
  type DesktopAgentStatus,
  type DesktopCapabilityStatus,
  type DesktopPermissionStatus,
  type DesktopDeviceInfo,
  type DesktopDisplayInfo,
  type DesktopNetworkSnapshot,
  type DesktopVirtualDesktopSnapshot,
  type DesktopBrowserSessionSnapshot,
  type DesktopNotificationInfo,
  type DesktopNotificationControlRequest,
  type DesktopNotificationControlResult,
  type DesktopFilesystemWatchInfo,
  type DesktopLogReadResult,
  type DesktopLogSource,
  type DesktopTraceCorrelation,
  type DesktopShiryuGenGenerationTrace,
  type DesktopProcessInfo,
  type DesktopScreenCapture,
  type DesktopScreenCaptureRequest,
  type DesktopClipboardReadResult,
  type DesktopClipboardWriteResult,
  type DesktopAccessibilityActionRequest,
  type DesktopAccessibilityActionResult,
  type DesktopInputRequest,
  type DesktopInputResult,
  type DesktopAccessibilitySnapshot,
  type DesktopWindowInfo,
} from "./desktop-agent-protocol.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 50;
const RECONNECT_BACKOFF_MS = [50, 150] as const;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class DesktopAgentClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DesktopAgentClientError";
  }
}

export interface DesktopAgentClientOptions {
  stateDir: string;
  endpoint?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  spawnDaemon?: () => void;
}

export class DesktopAgentClient {
  readonly paths: DesktopAgentPaths;
  private readonly endpoint: string;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly spawnDaemon: () => void;
  private startupPromise?: Promise<DesktopAgentStatus>;
  private negotiatedProtocolVersion = DESKTOP_AGENT_PROTOCOL_VERSION;

  constructor(options: DesktopAgentClientOptions) {
    this.paths = desktopAgentPaths(options.stateDir);
    this.endpoint = options.endpoint ?? this.paths.endpoint;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.spawnDaemon = options.spawnDaemon ?? (() => spawnDesktopAgent(options.stateDir));
  }

  async status(): Promise<DesktopAgentStatus | undefined> {
    return this.tryHello();
  }

  async ensureReady(): Promise<DesktopAgentStatus> {
    if (this.startupPromise) return this.startupPromise;
    this.startupPromise = this.ensureReadyInternal().finally(() => {
      this.startupPromise = undefined;
    });
    return this.startupPromise;
  }

  async capabilities(): Promise<DesktopCapabilityStatus[]> {
    const result = await this.requestReady("desktop.capabilities");
    if (!Array.isArray(result)) {
      throw new DesktopAgentClientError("DESKTOP_AGENT_INVALID_RESPONSE", "Desktop agent returned invalid capabilities.");
    }
    return result.map((item) => decodeCapability(item));
  }

  async permissions(): Promise<DesktopPermissionStatus[]> {
    return decodeDesktopPermissionStatuses(await this.requestReady("desktop.permissions"));
  }

  async windows(): Promise<DesktopWindowInfo[]> {
    return decodeDesktopWindowList(await this.requestReady("windows.list"));
  }

  async displays(): Promise<DesktopDisplayInfo[]> {
    return decodeDesktopDisplayList(await this.requestReady("displays.list"));
  }

  async processes(): Promise<DesktopProcessInfo[]> {
    return decodeDesktopProcessList(await this.requestReady("processes.list"));
  }

  async captureScreen(request: DesktopScreenCaptureRequest): Promise<DesktopScreenCapture> {
    return decodeDesktopScreenCapture(await this.requestReady("screen.capture", { ...request }));
  }

  async readClipboard(): Promise<DesktopClipboardReadResult> {
    return decodeDesktopClipboardReadResult(await this.requestReady("clipboard.read"));
  }

  async writeClipboard(text: string): Promise<DesktopClipboardWriteResult> {
    return decodeDesktopClipboardWriteResult(await this.requestReady("clipboard.write", { text }));
  }

  async accessibilitySnapshot(options: { application?: string; maxDepth?: number; maxNodes?: number } = {}): Promise<DesktopAccessibilitySnapshot> {
    return decodeDesktopAccessibilitySnapshot(await this.requestReady("accessibility.snapshot", { ...options }));
  }

  async accessibilityAction(request: DesktopAccessibilityActionRequest): Promise<DesktopAccessibilityActionResult> {
    return decodeDesktopAccessibilityActionResult(await this.requestReady("accessibility.action", { ...request }));
  }

  async input(request: DesktopInputRequest): Promise<DesktopInputResult> {
    return decodeDesktopInputResult(await this.requestReady("input.perform", { ...request }));
  }

  async recentActivity(): Promise<DesktopActivityTimeline> {
    return decodeDesktopActivityTimeline(await this.requestReady("events.recent"));
  }

  async audioGraph(): Promise<DesktopAudioGraph> {
    return decodeDesktopAudioGraph(await this.requestReady("audio.graph"));
  }

  async audioRuntime(): Promise<DesktopAudioRuntimeSnapshot> {
    return decodeDesktopAudioRuntime(await this.requestReady("audio.runtime"));
  }

  async devices(): Promise<DesktopDeviceInfo[]> {
    return decodeDesktopDeviceList(await this.requestReady("devices.list"));
  }

  async networkSnapshot(): Promise<DesktopNetworkSnapshot> {
    return decodeDesktopNetworkSnapshot(await this.requestReady("network.snapshot"));
  }

  async virtualDesktops(): Promise<DesktopVirtualDesktopSnapshot> {
    return decodeDesktopVirtualDesktopSnapshot(await this.requestReady("virtual-desktops.snapshot"));
  }

  async browserSession(): Promise<DesktopBrowserSessionSnapshot> {
    return decodeDesktopBrowserSessionSnapshot(await this.requestReady("browser.session"));
  }

  async logSources(): Promise<DesktopLogSource[]> {
    return decodeDesktopLogSources(await this.requestReady("logs.sources"));
  }

  async readLogs(sourceId: string, options: { lines?: number; query?: string } = {}): Promise<DesktopLogReadResult> {
    return decodeDesktopLogReadResult(await this.requestReady("logs.read", {
      sourceId,
      ...(options.lines === undefined ? {} : { lines: options.lines }),
      ...(options.query === undefined ? {} : { query: options.query }),
    }));
  }

  async traceCorrelation(correlationId: string, options: { lines?: number; query?: string } = {}): Promise<DesktopTraceCorrelation> {
    return decodeDesktopTraceCorrelation(await this.requestReady("trace.correlate", {
      correlationId,
      ...(options.lines === undefined ? {} : { lines: options.lines }),
      ...(options.query === undefined ? {} : { query: options.query }),
    }));
  }

  async shiryuGenTrace(traceId?: string): Promise<DesktopShiryuGenGenerationTrace> {
    return decodeDesktopShiryuGenGenerationTrace(await this.requestReady("apps.shiryugen.trace", {
      ...(traceId === undefined ? {} : { traceId }),
    }));
  }

  async notifications(): Promise<DesktopNotificationInfo[]> {
    return decodeDesktopNotificationList(await this.requestReady("notifications.recent"));
  }

  async notificationControl(request: DesktopNotificationControlRequest): Promise<DesktopNotificationControlResult> {
    return decodeDesktopNotificationControlResult(await this.requestReady("notifications.perform", { ...request }));
  }

  async filesystemWatches(): Promise<DesktopFilesystemWatchInfo[]> {
    return decodeDesktopFilesystemWatchList(await this.requestReady("filesystem.watch.list"));
  }

  async startFilesystemWatch(path: string, recursive = false): Promise<DesktopFilesystemWatchInfo> {
    return decodeDesktopFilesystemWatchInfo(await this.requestReady("filesystem.watch.start", { path, recursive }));
  }

  async stopFilesystemWatch(id: string): Promise<DesktopFilesystemWatchInfo> {
    return decodeDesktopFilesystemWatchInfo(await this.requestReady("filesystem.watch.stop", { id }));
  }

  async stop(): Promise<DesktopAgentStatus | undefined> {
    const existing = await this.tryHello();
    if (!existing) return undefined;
    const result = await this.requestExisting("desktop.stop");
    return decodeStatus(result);
  }

  private async ensureReadyInternal(): Promise<DesktopAgentStatus> {
    const existing = await this.tryHello();
    if (existing?.state === "ready") return existing;

    try {
      this.spawnDaemon();
    } catch (cause) {
      throw new DesktopAgentClientError(
        "DESKTOP_AGENT_STARTUP_FAILURE",
        `Unable to start desktop agent in ${this.paths.stateDir}.`,
        true,
        { cause },
      );
    }

    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      await delay(RETRY_DELAY_MS);
      try {
        const ready = await this.tryHello();
        if (ready?.state === "ready") return ready;
      } catch (error) {
        lastError = error;
        if (error instanceof DesktopAgentClientError && error.code === "DESKTOP_AGENT_PROTOCOL_MISMATCH") {
          throw error;
        }
      }
    }
    throw new DesktopAgentClientError(
      "DESKTOP_AGENT_STARTUP_FAILURE",
      "Desktop agent did not become ready before the startup timeout.",
      true,
      { cause: lastError },
    );
  }

  private async tryHello(): Promise<DesktopAgentStatus | undefined> {
    const token = readDesktopAgentSecret(this.paths);
    if (!token) return undefined;
    try {
      const response = await this.sendNegotiatedRequest("hello", token);
      if (!response.ok) {
        if (response.error.code === "DESKTOP_AGENT_UNAVAILABLE") return undefined;
        throw remoteError(response);
      }
      return decodeStatus(response.result);
    } catch (error) {
      if (isUnavailableError(error)) return undefined;
      throw error;
    }
  }

  private async requestReady(method: DesktopAgentMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      await this.ensureReady();
      try {
        return await this.requestExisting(method, params);
      } catch (error) {
        if (!isReconnectableError(error) || attempt >= RECONNECT_BACKOFF_MS.length) throw error;
        await delay(RECONNECT_BACKOFF_MS[attempt]!);
      }
    }
  }

  private async requestExisting(method: DesktopAgentMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    const token = readDesktopAgentSecret(this.paths);
    if (!token) {
      throw new DesktopAgentClientError("DESKTOP_AGENT_UNAVAILABLE", "Desktop agent is not running.", true);
    }
    const response = await this.sendNegotiatedRequest(method, token, params);
    if (!response.ok) throw remoteError(response);
    return response.result;
  }

  private async sendNegotiatedRequest(
    method: DesktopAgentMethod,
    authToken: string,
    params: Record<string, unknown> = {},
  ): Promise<DesktopAgentResponse> {
    let protocolVersion = this.negotiatedProtocolVersion;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await sendRequest(
        this.endpoint,
        request(method, authToken, params, protocolVersion),
        this.requestTimeoutMs,
      );
      if (response.protocolVersion === protocolVersion) {
        this.negotiatedProtocolVersion = protocolVersion;
        return response;
      }
      if (
        !response.ok
        && response.error.code === "DESKTOP_AGENT_PROTOCOL_MISMATCH"
        && desktopAgentProtocolSupported(response.protocolVersion)
      ) {
        protocolVersion = response.protocolVersion;
        this.negotiatedProtocolVersion = protocolVersion;
        continue;
      }
      throw new DesktopAgentClientError(
        "DESKTOP_AGENT_PROTOCOL_MISMATCH",
        `Desktop agent protocol ${response.protocolVersion} is incompatible with supported client protocols.`,
        false,
      );
    }
    throw new DesktopAgentClientError(
      "DESKTOP_AGENT_PROTOCOL_MISMATCH",
      "Desktop agent protocol negotiation failed.",
      false,
    );
  }
}

function request(
  method: DesktopAgentMethod,
  authToken: string,
  params: Record<string, unknown> = {},
  protocolVersion = DESKTOP_AGENT_PROTOCOL_VERSION,
): DesktopAgentRequest {
  return {
    requestId: randomUUID(),
    protocolVersion,
    authToken,
    method,
    params,
  } as DesktopAgentRequest;
}

async function sendRequest(
  endpoint: string,
  outgoing: DesktopAgentRequest,
  timeoutMs: number,
): Promise<DesktopAgentResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finishError = (error: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(normalizeSocketError(error));
    };
    const timer = setTimeout(() => {
      finishError(new DesktopAgentClientError("DESKTOP_AGENT_TIMEOUT", "Desktop agent request timed out.", true));
    }, timeoutMs);
    timer.unref();

    socket.once("connect", () => socket.write(encodeDesktopAgentRequest(outgoing)));
    socket.on("data", (chunk: string | Buffer) => {
      if (settled) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        finishError(new DesktopAgentClientError("DESKTOP_AGENT_INVALID_RESPONSE", "Desktop agent response is too large."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(decodeDesktopAgentResponse(JSON.parse(buffer.slice(0, newline))));
      } catch (cause) {
        reject(new DesktopAgentClientError("DESKTOP_AGENT_INVALID_RESPONSE", "Desktop agent returned invalid JSON.", false, { cause }));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      finishError(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (!settled) finishError(new DesktopAgentClientError("DESKTOP_AGENT_UNAVAILABLE", "Desktop agent connection closed.", true));
    });
  });
}

function decodeStatus(value: unknown): DesktopAgentStatus {
  try {
    return decodeDesktopAgentStatus(value);
  } catch (cause) {
    throw new DesktopAgentClientError("DESKTOP_AGENT_INVALID_RESPONSE", "Desktop agent returned invalid status.", false, { cause });
  }
}

function decodeCapability(value: unknown): DesktopCapabilityStatus {
  const status = decodeStatus({
    state: "ready",
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    pid: 1,
    endpoint: "validation",
    startedAt: new Date(0).toISOString(),
    platform: process.platform,
    sessionType: "validation",
    clientConnections: 0,
    capabilities: [value],
  });
  return status.capabilities[0]!;
}

function remoteError(response: Extract<DesktopAgentResponse, { ok: false }>): DesktopAgentClientError {
  return new DesktopAgentClientError(response.error.code, response.error.message, response.error.retryable ?? false);
}

function normalizeSocketError(error: unknown): DesktopAgentClientError {
  if (error instanceof DesktopAgentClientError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") {
    return new DesktopAgentClientError("DESKTOP_AGENT_UNAVAILABLE", "Desktop agent is unavailable.", true, { cause: error });
  }
  return new DesktopAgentClientError("DESKTOP_AGENT_CONNECTION_ERROR", error instanceof Error ? error.message : String(error), true, { cause: error });
}

function isUnavailableError(error: unknown): boolean {
  return error instanceof DesktopAgentClientError && error.code === "DESKTOP_AGENT_UNAVAILABLE";
}

function isReconnectableError(error: unknown): boolean {
  return error instanceof DesktopAgentClientError
    && (error.code === "DESKTOP_AGENT_UNAVAILABLE" || error.code === "DESKTOP_AGENT_CONNECTION_ERROR");
}

function spawnDesktopAgent(stateDir: string): void {
  const entrypoint = fileURLToPath(new URL("./desktop-agent-main.js", import.meta.url));
  if (process.platform === "linux" && spawnDesktopAgentThroughUserSystemd(stateDir, entrypoint)) {
    return;
  }
  const child = spawn(process.execPath, [entrypoint], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      DEVSPACE_STATE_DIR: stateDir,
    },
  });
  child.unref();
}

function spawnDesktopAgentThroughUserSystemd(stateDir: string, entrypoint: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const busPath = `${runtimeDir}/bus`;
  const systemdRun = "/usr/bin/systemd-run";
  if (!existsSync(systemdRun) || !existsSync(busPath)) return false;

  const unitSuffix = createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  const child = spawn(systemdRun, [
    "--user",
    `--unit=devspace-desktop-agent-${unitSuffix}`,
    "--collect",
    "--quiet",
    `--setenv=DEVSPACE_STATE_DIR=${stateDir}`,
    process.execPath,
    entrypoint,
  ], {
    stdio: "ignore",
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${busPath}`,
    },
  });
  child.unref();
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
