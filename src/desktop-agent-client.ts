import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_AGENT_PROTOCOL_VERSION,
  desktopAgentPaths,
  readDesktopAgentSecret,
  type DesktopAgentPaths,
} from "./desktop-agent-lifecycle.js";
import {
  decodeDesktopAgentResponse,
  decodeDesktopAgentStatus,
  decodeDesktopDisplayList,
  decodeDesktopProcessList,
  decodeDesktopWindowList,
  encodeDesktopAgentRequest,
  type DesktopAgentMethod,
  type DesktopAgentRequest,
  type DesktopAgentResponse,
  type DesktopAgentStatus,
  type DesktopCapabilityStatus,
  type DesktopDisplayInfo,
  type DesktopProcessInfo,
  type DesktopWindowInfo,
} from "./desktop-agent-protocol.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 50;
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
    await this.ensureReady();
    const result = await this.requestExisting("desktop.capabilities");
    if (!Array.isArray(result)) {
      throw new DesktopAgentClientError("DESKTOP_AGENT_INVALID_RESPONSE", "Desktop agent returned invalid capabilities.");
    }
    return result.map((item) => decodeCapability(item));
  }

  async windows(): Promise<DesktopWindowInfo[]> {
    await this.ensureReady();
    return decodeDesktopWindowList(await this.requestExisting("windows.list"));
  }

  async displays(): Promise<DesktopDisplayInfo[]> {
    await this.ensureReady();
    return decodeDesktopDisplayList(await this.requestExisting("displays.list"));
  }

  async processes(): Promise<DesktopProcessInfo[]> {
    await this.ensureReady();
    return decodeDesktopProcessList(await this.requestExisting("processes.list"));
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
      const response = await sendRequest(
        this.endpoint,
        request("hello", token),
        this.requestTimeoutMs,
      );
      if (!response.ok) {
        if (response.error.code === "DESKTOP_AGENT_UNAVAILABLE") return undefined;
        throw remoteError(response);
      }
      if (response.protocolVersion !== DESKTOP_AGENT_PROTOCOL_VERSION) {
        throw new DesktopAgentClientError(
          "DESKTOP_AGENT_PROTOCOL_MISMATCH",
          `Desktop agent protocol ${response.protocolVersion} does not match ${DESKTOP_AGENT_PROTOCOL_VERSION}.`,
          true,
        );
      }
      return decodeStatus(response.result);
    } catch (error) {
      if (isUnavailableError(error)) return undefined;
      throw error;
    }
  }

  private async requestExisting(method: DesktopAgentMethod): Promise<unknown> {
    const token = readDesktopAgentSecret(this.paths);
    if (!token) {
      throw new DesktopAgentClientError("DESKTOP_AGENT_UNAVAILABLE", "Desktop agent is not running.", true);
    }
    const response = await sendRequest(
      this.endpoint,
      request(method, token),
      this.requestTimeoutMs,
    );
    if (!response.ok) throw remoteError(response);
    if (response.protocolVersion !== DESKTOP_AGENT_PROTOCOL_VERSION) {
      throw new DesktopAgentClientError(
        "DESKTOP_AGENT_PROTOCOL_MISMATCH",
        `Desktop agent protocol ${response.protocolVersion} does not match ${DESKTOP_AGENT_PROTOCOL_VERSION}.`,
        true,
      );
    }
    return response.result;
  }
}

function request(method: DesktopAgentMethod, authToken: string): DesktopAgentRequest {
  return {
    requestId: randomUUID(),
    protocolVersion: DESKTOP_AGENT_PROTOCOL_VERSION,
    authToken,
    method,
    params: {},
  };
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
