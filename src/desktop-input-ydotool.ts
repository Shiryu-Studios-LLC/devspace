import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  DesktopInputKey,
  DesktopInputModifier,
  DesktopInputRequest,
  DesktopInputResult,
} from "./desktop-agent-protocol.js";

const execFileAsync = promisify(execFile);
const DEFAULT_YDOTOOL = "/usr/bin/ydotool";
const DEFAULT_TIMEOUT_MS = 8_000;

export interface YdotoolInputOptions {
  ydotoolPath?: string;
  socketPath?: string;
  timeoutMs?: number;
  now?: () => number;
  runYdotool?: (args: string[], options: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<void>;
}

export function ydotoolInputAvailable(
  ydotoolPath = DEFAULT_YDOTOOL,
  socketPath = defaultYdotoolSocketPath(),
): boolean {
  if (process.platform !== "linux" || !existsSync(ydotoolPath) || !socketPath) return false;
  try {
    const socket = statSync(socketPath);
    return socket.isSocket();
  } catch {
    return false;
  }
}

export function createYdotoolInputProvider(
  options: YdotoolInputOptions = {},
): (request: DesktopInputRequest) => Promise<DesktopInputResult> {
  const ydotoolPath = options.ydotoolPath ?? DEFAULT_YDOTOOL;
  const socketPath = options.socketPath ?? defaultYdotoolSocketPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const runYdotool = options.runYdotool ?? (async (args, runOptions) => {
    await execFileAsync(ydotoolPath, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: runOptions.timeout,
      env: runOptions.env,
    });
  });

  return async (request) => {
    if (!options.runYdotool && !ydotoolInputAvailable(ydotoolPath, socketPath)) {
      throw new Error("ydotool input control is unavailable in this desktop session.");
    }
    const args = buildYdotoolArgs(request);
    await runYdotool(args, {
      timeout: timeoutMs,
      env: {
        ...process.env,
        YDOTOOL_SOCKET: socketPath,
      },
    });
    return {
      type: request.type,
      completed: true,
      completedAt: new Date(now()).toISOString(),
    };
  };
}

export function defaultYdotoolSocketPath(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR
    ?? (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "");
  return runtimeDir ? join(runtimeDir, ".ydotool_socket") : "/tmp/.ydotool_socket";
}

function buildYdotoolArgs(request: DesktopInputRequest): string[] {
  switch (request.type) {
    case "mouse-move": {
      if (!Number.isSafeInteger(request.x) || !Number.isSafeInteger(request.y)) {
        throw new Error("Mouse coordinates must be integers.");
      }
      const limit = request.mode === "absolute" ? 100_000 : 32_768;
      const minimum = request.mode === "absolute" ? 0 : -limit;
      if (request.x < minimum || request.x > limit || request.y < minimum || request.y > limit) {
        throw new Error(`Mouse coordinates are outside the ${request.mode} bounds.`);
      }
      return [
        "mousemove",
        ...(request.mode === "absolute" ? ["--absolute"] : []),
        "--xpos",
        String(request.x),
        "--ypos",
        String(request.y),
      ];
    }
    case "mouse-click": {
      const button = CLICK_CODES[request.button];
      if (!button) throw new Error("Unsupported mouse button.");
      const count = request.count ?? 1;
      const nextDelayMs = request.nextDelayMs ?? 40;
      if (!Number.isSafeInteger(count) || count < 1 || count > 10) throw new Error("Mouse click count must be between 1 and 10.");
      if (!Number.isSafeInteger(nextDelayMs) || nextDelayMs < 0 || nextDelayMs > 1000) throw new Error("Mouse click delay must be between 0 and 1000 ms.");
      return ["click", `--repeat=${count}`, `--next-delay=${nextDelayMs}`, button];
    }
    case "mouse-scroll": {
      const x = request.x ?? 0;
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(request.y) || x < -120 || x > 120 || request.y < -120 || request.y > 120) {
        throw new Error("Mouse scroll values must be integers between -120 and 120.");
      }
      return ["mousemove", "--wheel", "--xpos", String(x), "--ypos", String(request.y)];
    }
    case "type-text": {
      if (typeof request.text !== "string" || request.text.length > 16_384) throw new Error("Typed text must be at most 16384 characters.");
      const keyDelayMs = request.keyDelayMs ?? 20;
      const keyHoldMs = request.keyHoldMs ?? 20;
      if (!validDelay(keyDelayMs) || !validDelay(keyHoldMs)) throw new Error("Keyboard delays must be between 0 and 1000 ms.");
      return ["type", `--key-delay=${keyDelayMs}`, `--key-hold=${keyHoldMs}`, "--escape=0", request.text];
    }
    case "key-chord": {
      const keyCode = KEY_CODES[request.key];
      if (!keyCode) throw new Error(`Unsupported keyboard key: ${request.key}.`);
      const modifiers = [...new Set(request.modifiers ?? [])];
      if (modifiers.length > 4 || modifiers.some((modifier) => MODIFIER_CODES[modifier] === undefined)) {
        throw new Error("Unsupported keyboard modifier.");
      }
      const keyDelayMs = request.keyDelayMs ?? 20;
      if (!validDelay(keyDelayMs)) throw new Error("Keyboard delay must be between 0 and 1000 ms.");
      const down = modifiers.map((modifier) => `${MODIFIER_CODES[modifier]}:1`);
      const up = [...modifiers].reverse().map((modifier) => `${MODIFIER_CODES[modifier]}:0`);
      return ["key", `--key-delay=${keyDelayMs}`, ...down, `${keyCode}:1`, `${keyCode}:0`, ...up];
    }
  }
}

function validDelay(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1000;
}

const CLICK_CODES: Record<"left" | "right" | "middle", string> = {
  left: "0xC0",
  right: "0xC1",
  middle: "0xC2",
};

const MODIFIER_CODES: Record<DesktopInputModifier, number> = {
  ctrl: 29,
  shift: 42,
  alt: 56,
  meta: 125,
};

const KEY_CODES: Record<DesktopInputKey, number> = {
  "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50,
  enter: 28,
  escape: 1,
  tab: 15,
  backspace: 14,
  space: 57,
  delete: 111,
  insert: 110,
  left: 105,
  right: 106,
  up: 103,
  down: 108,
  home: 102,
  end: 107,
  pageup: 104,
  pagedown: 109,
  f1: 59,
  f2: 60,
  f3: 61,
  f4: 62,
  f5: 63,
  f6: 64,
  f7: 65,
  f8: 66,
  f9: 67,
  f10: 68,
  f11: 87,
  f12: 88,
};
