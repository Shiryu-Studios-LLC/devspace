import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  decodeDesktopAccessibilityActionResult,
  decodeDesktopAccessibilitySnapshot,
  type DesktopAccessibilityActionRequest,
  type DesktopAccessibilityActionResult,
  type DesktopAccessibilitySnapshot,
} from "./desktop-agent-protocol.js";

const execFileAsync = promisify(execFile);
const PYTHON = "/usr/bin/python3";
const DEFAULT_HELPER_PATH = fileURLToPath(new URL("./bin/devspace-accessibility-helper.py", import.meta.url));
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_NODES = 200;

export interface DesktopAccessibilitySnapshotOptions {
  application?: string;
  maxDepth?: number;
  maxNodes?: number;
}

export interface AtspiAccessibilityOptions {
  helperPath?: string;
  timeoutMs?: number;
  runHelper?: (args: string[], options: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;
}

export interface AtspiFocusEvent {
  focusedAt: string;
  processId: number;
  application: string;
  applicationId: string;
  windowRole: string;
  windowName: string;
  windowAccessibleId: string;
  controlRole: string;
  controlName: string;
  controlAccessibleId: string;
}

export interface DesktopFocusMonitor {
  start(): void;
  stop(): void;
}

export class AtspiFocusMonitor implements DesktopFocusMonitor {
  private readonly helperPath: string;
  private readonly onFocus: (event: AtspiFocusEvent) => void;
  private child?: ChildProcess;
  private buffer = "";

  constructor(options: { helperPath?: string; onFocus: (event: AtspiFocusEvent) => void }) {
    this.helperPath = options.helperPath ?? DEFAULT_HELPER_PATH;
    this.onFocus = options.onFocus;
  }

  start(): void {
    if (this.child || !atspiAccessibilityAvailable(this.helperPath)) return;
    const child = spawn(PYTHON, [this.helperPath, "focus-monitor"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => this.consume(chunk.toString()));
    child.once("error", () => {
      if (this.child === child) this.child = undefined;
    });
    child.once("close", () => {
      if (this.child === child) this.child = undefined;
    });
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.buffer = "";
    if (child && !child.killed) child.kill("SIGTERM");
  }

  ingest(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (typeof record.focusedAt !== "string"
      || typeof record.processId !== "number"
      || !Number.isSafeInteger(record.processId)
      || record.processId <= 0) return;
    const text = (key: string) => typeof record[key] === "string" ? record[key] as string : "";
    this.onFocus({
      focusedAt: record.focusedAt,
      processId: record.processId,
      application: text("application"),
      applicationId: text("applicationId"),
      windowRole: text("windowRole"),
      windowName: text("windowName"),
      windowAccessibleId: text("windowAccessibleId"),
      controlRole: text("controlRole"),
      controlName: text("controlName"),
      controlAccessibleId: text("controlAccessibleId"),
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.ingest(JSON.parse(line));
      } catch {
        // Ignore malformed helper lines without taking down desktop awareness.
      }
    }
  }
}

export function atspiAccessibilityAvailable(helperPath = DEFAULT_HELPER_PATH): boolean {
  return process.platform === "linux"
    && existsSync(PYTHON)
    && existsSync(helperPath)
    && Boolean(process.env.DBUS_SESSION_BUS_ADDRESS)
    && Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);
}

export function createAtspiAccessibilityActionProvider(
  options: AtspiAccessibilityOptions = {},
): (request: DesktopAccessibilityActionRequest) => Promise<DesktopAccessibilityActionResult> {
  const helperPath = options.helperPath ?? DEFAULT_HELPER_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runHelper = createHelperRunner(helperPath, options.runHelper);
  return async (request) => {
    if (!options.runHelper && !atspiAccessibilityAvailable(helperPath)) {
      throw new Error("AT-SPI accessibility actions are unavailable in this desktop session.");
    }
    if (!/^pid-\d+(?:\.\d+)*$/.test(request.nodeId)) {
      throw new Error("Accessibility action requires a pid-based node ID from a recent snapshot.");
    }
    if (!Number.isSafeInteger(request.actionIndex) || request.actionIndex < 0 || request.actionIndex > 63) {
      throw new Error("Accessibility actionIndex must be an integer between 0 and 63.");
    }
    const args = [
      "action",
      "--node-id",
      request.nodeId,
      "--action-index",
      String(request.actionIndex),
      "--expected-role",
      request.expectedRole,
      "--expected-name",
      request.expectedName,
      ...(request.expectedAccessibleId === undefined ? [] : ["--expected-accessible-id", request.expectedAccessibleId]),
    ];
    const { stdout } = await runHelper(args, { timeout: timeoutMs, env: process.env });
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!line) throw new Error("AT-SPI helper returned no accessibility action result.");
    return decodeDesktopAccessibilityActionResult(JSON.parse(line));
  };
}

export function createAtspiAccessibilityProvider(
  options: AtspiAccessibilityOptions = {},
): (request?: DesktopAccessibilitySnapshotOptions) => Promise<DesktopAccessibilitySnapshot> {
  const helperPath = options.helperPath ?? DEFAULT_HELPER_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runHelper = createHelperRunner(helperPath, options.runHelper);

  return async (request = {}) => {
    if (!options.runHelper && !atspiAccessibilityAvailable(helperPath)) {
      throw new Error("AT-SPI accessibility awareness is unavailable in this desktop session.");
    }
    const maxDepth = request.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxNodes = request.maxNodes ?? DEFAULT_MAX_NODES;
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 8) {
      throw new Error("Accessibility maxDepth must be an integer between 0 and 8.");
    }
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 500) {
      throw new Error("Accessibility maxNodes must be an integer between 1 and 500.");
    }
    const args = [
      "snapshot",
      "--max-depth",
      String(maxDepth),
      "--max-nodes",
      String(maxNodes),
      ...(request.application ? ["--application", request.application] : []),
    ];
    const { stdout } = await runHelper(args, { timeout: timeoutMs, env: process.env });
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!line) throw new Error("AT-SPI helper returned no accessibility snapshot.");
    return decodeDesktopAccessibilitySnapshot(JSON.parse(line));
  };
}

function createHelperRunner(
  helperPath: string,
  override: AtspiAccessibilityOptions["runHelper"],
): NonNullable<AtspiAccessibilityOptions["runHelper"]> {
  return override ?? (async (args, runOptions) => {
    const result = await execFileAsync(PYTHON, [helperPath, ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: runOptions.timeout,
      env: runOptions.env,
    });
    return { stdout: result.stdout };
  });
}
