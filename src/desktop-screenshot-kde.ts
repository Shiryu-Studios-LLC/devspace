import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  DesktopScreenCapture,
  DesktopScreenCaptureRequest,
} from "./desktop-agent-protocol.js";

const execFileAsync = promisify(execFile);
const DEFAULT_HELPER_PATH = fileURLToPath(new URL("./bin/devspace-screenshot-helper", import.meta.url));
const DEFAULT_CAPTURE_TIMEOUT_MS = 10_000;
const MAX_PNG_BYTES = 128 * 1024 * 1024;
const SCREENSHOT_DESKTOP_FILE = "org.shiryustudios.DevSpace.ScreenshotHelper.desktop";
const authorizationPromises = new Map<string, Promise<void>>();

interface ScreenshotMetadata {
  width?: unknown;
  height?: unknown;
  scale?: unknown;
  screen?: unknown;
  windowId?: unknown;
}

export interface KdeScreenCaptureOptions {
  helperPath?: string;
  timeoutMs?: number;
  now?: () => number;
  runHelper?: (args: string[], options: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;
}

export function kdeScreenCaptureAvailable(helperPath = DEFAULT_HELPER_PATH): boolean {
  if (process.platform !== "linux") return false;
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return false;
  if (!process.env.WAYLAND_DISPLAY && !process.env.DISPLAY && !process.env.XDG_SESSION_TYPE) return false;
  try {
    return existsSync(helperPath) && statSync(helperPath).isFile();
  } catch {
    return false;
  }
}

export function createKdeScreenCaptureProvider(
  desktopAgentStateDir: string,
  options: KdeScreenCaptureOptions = {},
): (request: DesktopScreenCaptureRequest) => Promise<DesktopScreenCapture> {
  const helperPath = resolve(options.helperPath ?? DEFAULT_HELPER_PATH);
  const captureDir = resolve(desktopAgentStateDir, "captures");
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const runHelper = options.runHelper ?? (async (args, runOptions) => {
    const result = await execFileAsync(helperPath, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: runOptions.timeout,
      env: runOptions.env,
    });
    return { stdout: result.stdout };
  });

  return async (request) => {
    if (!kdeScreenCaptureAvailable(helperPath) && !options.runHelper) {
      throw new Error("KDE screenshot capture is unavailable in this desktop session.");
    }
    if (!options.runHelper) await ensureKdeScreenshotAuthorization(helperPath);
    await mkdir(captureDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(captureDir, 0o700);

    const outputPath = join(captureDir, `${randomUUID()}.png`);
    const args = buildHelperArgs(request, outputPath);
    try {
      const result = await runHelper(args, { timeout: timeoutMs, env: process.env });
      const metadata = parseMetadata(result.stdout);
      const output = await stat(outputPath);
      if (!output.isFile() || output.size <= 0 || output.size > MAX_PNG_BYTES) {
        throw new Error(`KDE screenshot PNG has invalid size: ${output.size}.`);
      }
      if (process.platform !== "win32") await chmod(outputPath, 0o600);
      return {
        path: outputPath,
        mimeType: "image/png",
        target: request.target,
        width: positiveInteger(metadata.width, "width"),
        height: positiveInteger(metadata.height, "height"),
        scale: positiveNumber(metadata.scale, "scale"),
        capturedAt: new Date(now()).toISOString(),
        ...(request.screen ? { screen: request.screen } : optionalString(metadata.screen) ? { screen: optionalString(metadata.screen) } : {}),
        ...(request.windowId ? { windowId: request.windowId } : optionalString(metadata.windowId) ? { windowId: optionalString(metadata.windowId) } : {}),
        ...(request.target === "area" ? { x: request.x, y: request.y } : {}),
      };
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };
}

async function ensureKdeScreenshotAuthorization(helperPath: string): Promise<void> {
  let pending = authorizationPromises.get(helperPath);
  if (!pending) {
    pending = installKdeScreenshotAuthorization(helperPath).catch((error) => {
      authorizationPromises.delete(helperPath);
      throw error;
    });
    authorizationPromises.set(helperPath, pending);
  }
  await pending;
}

async function installKdeScreenshotAuthorization(helperPath: string): Promise<void> {
  if (/[\r\n]/.test(helperPath)) throw new Error("Invalid KDE screenshot helper path.");
  const applicationsDir = join(homedir(), ".local", "share", "applications");
  const desktopPath = join(applicationsDir, SCREENSHOT_DESKTOP_FILE);
  const quotedHelper = `"${helperPath.replace(/[\\"`$]/g, "\\$&")}"`;
  const content = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=DevSpace Screenshot Helper",
    `Exec=${quotedHelper}`,
    "NoDisplay=true",
    "Terminal=false",
    "X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2",
    "",
  ].join("\n");
  const existing = await readFile(desktopPath, "utf8").catch(() => undefined);
  if (existing === content) return;

  await mkdir(applicationsDir, { recursive: true });
  const temporary = `${desktopPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, desktopPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }

  const cacheBuilder = "/usr/bin/kbuildsycoca6";
  if (existsSync(cacheBuilder)) {
    await execFileAsync(cacheBuilder, ["--noincremental"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
  }
}

function buildHelperArgs(request: DesktopScreenCaptureRequest, outputPath: string): string[] {
  const args = [request.target, outputPath];
  if (request.target === "screen") {
    if (!request.screen) throw new Error("Screen capture requires a screen name.");
    args.push(request.screen);
  } else if (request.target === "window") {
    if (!request.windowId) throw new Error("Window capture requires a window ID.");
    args.push(request.windowId);
  } else if (request.target === "area") {
    if (
      request.x === undefined
      || request.y === undefined
      || request.width === undefined
      || request.height === undefined
      || !Number.isSafeInteger(request.x)
      || !Number.isSafeInteger(request.y)
      || !Number.isSafeInteger(request.width)
      || !Number.isSafeInteger(request.height)
      || request.width <= 0
      || request.height <= 0
    ) {
      throw new Error("Area capture requires integer x/y and positive width/height.");
    }
    args.push(String(request.x), String(request.y), String(request.width), String(request.height));
  }

  appendBoolean(args, "include-cursor", request.includeCursor);
  appendBoolean(args, "include-decoration", request.includeDecoration);
  appendBoolean(args, "include-shadow", request.includeShadow);
  appendBoolean(args, "native-resolution", request.nativeResolution);
  appendBoolean(args, "hide-caller-windows", request.hideCallerWindows);
  return args;
}

function appendBoolean(args: string[], name: string, value: boolean | undefined): void {
  if (value !== undefined) args.push(`--${name}=${value ? "true" : "false"}`);
}

function parseMetadata(stdout: string): ScreenshotMetadata {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("KDE screenshot helper returned no metadata.");
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("KDE screenshot helper returned invalid metadata.");
  }
  return parsed as ScreenshotMetadata;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`KDE screenshot metadata has invalid ${field}.`);
  }
  return value;
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`KDE screenshot metadata has invalid ${field}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

