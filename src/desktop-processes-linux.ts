import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type {
  DesktopProcessInfo,
  DesktopWindowInfo,
} from "./desktop-agent-protocol.js";

const PROC_ROOT = "/proc";
const PAGE_SIZE_FALLBACK = 4096;

export function linuxProcessAwarenessAvailable(): boolean {
  return process.platform === "linux";
}

export async function listLinuxProcesses(
  windows: DesktopWindowInfo[] = [],
): Promise<DesktopProcessInfo[]> {
  if (!linuxProcessAwarenessAvailable()) {
    throw new Error("Linux process awareness is unavailable on this platform.");
  }

  const currentUid = process.getuid?.();
  const windowIdsByPid = new Map<number, string[]>();
  for (const window of windows) {
    if (window.pid === undefined) continue;
    const ids = windowIdsByPid.get(window.pid) ?? [];
    ids.push(window.id);
    windowIdsByPid.set(window.pid, ids);
  }

  const processes: DesktopProcessInfo[] = [];
  for (const entry of readdirSync(PROC_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const info = readProcess(pid, currentUid, windowIdsByPid.get(pid) ?? []);
    if (info) processes.push(info);
  }

  processes.sort((left, right) => left.pid - right.pid);
  return processes;
}

function readProcess(
  pid: number,
  currentUid: number | undefined,
  windowIds: string[],
): DesktopProcessInfo | undefined {
  let status: Record<string, string>;
  try {
    status = parseStatus(readFileSync(`${PROC_ROOT}/${pid}/status`, "utf8"));
  } catch {
    return undefined;
  }

  const uid = parseFirstInteger(status.Uid);
  const ppid = parseFirstInteger(status.PPid) ?? 0;
  const threads = parseFirstInteger(status.Threads);
  const residentMemoryBytes = parseKilobytes(status.VmRSS);
  const virtualMemoryBytes = parseKilobytes(status.VmSize);
  const name = status.Name?.trim() || readComm(pid) || `pid-${pid}`;
  const state = status.State?.trim() || "unknown";
  const executable = readExecutable(pid);

  return {
    pid,
    ppid,
    ...(uid !== undefined ? { uid } : {}),
    sameUser: uid !== undefined && currentUid !== undefined ? uid === currentUid : undefined,
    name,
    state,
    ...(executable ? { executable } : {}),
    ...(threads !== undefined ? { threads } : {}),
    ...(residentMemoryBytes !== undefined ? { residentMemoryBytes } : {}),
    ...(virtualMemoryBytes !== undefined ? { virtualMemoryBytes } : {}),
    windowIds,
    windowCount: windowIds.length,
    hasWindow: windowIds.length > 0,
  };
}

function parseStatus(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return result;
}

function parseFirstInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(\d+)/.exec(value);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseKilobytes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(\d+)\s+kB\b/i.exec(value);
  if (!match) return undefined;
  const kilobytes = Number(match[1]);
  if (!Number.isSafeInteger(kilobytes)) return undefined;
  return kilobytes * 1024;
}

function readComm(pid: number): string | undefined {
  try {
    const value = readFileSync(`${PROC_ROOT}/${pid}/comm`, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function readExecutable(pid: number): string | undefined {
  try {
    return readlinkSync(`${PROC_ROOT}/${pid}/exe`);
  } catch {
    return undefined;
  }
}

// Kept local so a future CPU/memory sampler can use the host page size without
// changing the public process contract introduced here.
export const linuxPageSizeFallback = PAGE_SIZE_FALLBACK;
