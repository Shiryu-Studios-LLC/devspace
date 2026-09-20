import { timingSafeEqual } from "node:crypto";
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
  type DesktopCapabilityStatus,
  type DesktopWindowInfo,
} from "./desktop-agent-protocol.js";
import {
  kdeWindowAwarenessAvailable,
  listKdeWindows,
} from "./desktop-windows-kde.js";

const MAX_REQUEST_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface DesktopAgentDaemonOptions {
  stateDir: string;
  paths?: DesktopAgentPaths;
  capabilities?: () => DesktopCapabilityStatus[];
  windows?: () => Promise<DesktopWindowInfo[]>;
  now?: () => number;
  onClosed?: () => void;
}

export class DesktopAgentDaemon {
  readonly paths: DesktopAgentPaths;
  private readonly lock: DesktopAgentLock;
  private readonly capabilitiesProvider: () => DesktopCapabilityStatus[];
  private readonly windowsProvider: () => Promise<DesktopWindowInfo[]>;
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
  return [
    windowsReady
      ? { id: "windows", state: "ready", detail: "KDE/KWin D-Bus window inventory" }
      : { id: "windows", state: "unavailable", detail: "KDE/KWin graphical session is unavailable" },
    { id: "screen", state: "not_implemented" },
    { id: "input", state: "not_implemented" },
    { id: "accessibility", state: "not_implemented" },
    { id: "clipboard", state: "not_implemented" },
    { id: "notifications", state: "not_implemented" },
    { id: "audio", state: "not_implemented" },
    { id: "devices", state: "not_implemented" },
    { id: "network", state: "not_implemented" },
    { id: "events", state: "not_implemented" },
  ];
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
