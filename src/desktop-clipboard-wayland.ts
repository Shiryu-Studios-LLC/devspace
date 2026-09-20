import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import type {
  DesktopClipboardReadResult,
  DesktopClipboardWriteResult,
} from "./desktop-agent-protocol.js";

const execFileAsync = promisify(execFile);
const WL_PASTE = "/usr/bin/wl-paste";
const WL_COPY = "/usr/bin/wl-copy";
const MAX_CLIPBOARD_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5_000;
const TEXT_MIME_TYPES = [
  "text/plain;charset=utf-8",
  "text/plain",
  "UTF8_STRING",
  "TEXT",
  "STRING",
] as const;

export function waylandClipboardReadAvailable(): boolean {
  return process.platform === "linux"
    && existsSync(WL_PASTE)
    && Boolean(process.env.WAYLAND_DISPLAY);
}

export function waylandClipboardWriteAvailable(): boolean {
  return process.platform === "linux"
    && existsSync(WL_COPY)
    && Boolean(process.env.WAYLAND_DISPLAY);
}

export async function readWaylandClipboardText(): Promise<DesktopClipboardReadResult> {
  if (!waylandClipboardReadAvailable()) {
    throw new Error("Wayland clipboard reading is unavailable in this desktop session.");
  }

  let types: string[];
  try {
    const { stdout } = await execFileAsync(WL_PASTE, ["--list-types"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: COMMAND_TIMEOUT_MS,
      env: process.env,
    });
    types = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  } catch (error) {
    if (exitCode(error) === 1) return unavailableClipboard();
    throw error;
  }

  const mimeType = TEXT_MIME_TYPES.find((candidate) => types.includes(candidate));
  if (!mimeType) return unavailableClipboard();

  const { stdout } = await execFileAsync(WL_PASTE, ["--no-newline", "--type", mimeType], {
    encoding: "utf8",
    maxBuffer: MAX_CLIPBOARD_BYTES + 1,
    timeout: COMMAND_TIMEOUT_MS,
    env: process.env,
  });
  const bytes = Buffer.byteLength(stdout, "utf8");
  if (bytes > MAX_CLIPBOARD_BYTES) {
    throw new Error(`Clipboard text exceeds the ${MAX_CLIPBOARD_BYTES}-byte limit.`);
  }
  return {
    available: true,
    text: stdout,
    mimeType,
    bytes,
    readAt: new Date().toISOString(),
  };
}

export async function writeWaylandClipboardText(text: string): Promise<DesktopClipboardWriteResult> {
  if (!waylandClipboardWriteAvailable()) {
    throw new Error("Wayland clipboard writing is unavailable in this desktop session.");
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_CLIPBOARD_BYTES) {
    throw new Error(`Clipboard text exceeds the ${MAX_CLIPBOARD_BYTES}-byte limit.`);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(WL_COPY, ["--type", "text/plain;charset=utf-8"], {
      env: process.env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Wayland clipboard write timed out."));
    }, COMMAND_TIMEOUT_MS);
    timer.unref();

    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (code === 0) finish();
      else finish(new Error(`wl-copy exited with code ${code ?? "unknown"}.`));
    });
    child.stdin.end(text, "utf8");
  });

  return {
    bytes,
    mimeType: "text/plain;charset=utf-8",
    writtenAt: new Date().toISOString(),
  };
}

function unavailableClipboard(): DesktopClipboardReadResult {
  return {
    available: false,
    readAt: new Date().toISOString(),
  };
}

function exitCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "number" ? code : undefined;
}
