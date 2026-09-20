import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  decodeDesktopAccessibilitySnapshot,
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

export function atspiAccessibilityAvailable(helperPath = DEFAULT_HELPER_PATH): boolean {
  return process.platform === "linux"
    && existsSync(PYTHON)
    && existsSync(helperPath)
    && Boolean(process.env.DBUS_SESSION_BUS_ADDRESS)
    && Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);
}

export function createAtspiAccessibilityProvider(
  options: AtspiAccessibilityOptions = {},
): (request?: DesktopAccessibilitySnapshotOptions) => Promise<DesktopAccessibilitySnapshot> {
  const helperPath = options.helperPath ?? DEFAULT_HELPER_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runHelper = options.runHelper ?? (async (args, runOptions) => {
    const result = await execFileAsync(PYTHON, [helperPath, ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: runOptions.timeout,
      env: runOptions.env,
    });
    return { stdout: result.stdout };
  });

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
