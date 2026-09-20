import { execFile } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { promisify } from "node:util";
import type { DesktopWindowInfo } from "./desktop-agent-protocol.js";

const execFileAsync = promisify(execFile);
const BUSCTL = "/usr/bin/busctl";
const KWIN_SERVICE = "org.kde.KWin";
const KWIN_WINDOWS_RUNNER = "/WindowsRunner";
const KWIN_OBJECT = "/KWin";
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const WINDOW_INFO_CONCURRENCY = 6;

interface BusctlResponse {
  type?: string;
  data?: unknown[];
}

interface BusVariant {
  type?: string;
  data?: unknown;
}

export function kdeWindowAwarenessAvailable(): boolean {
  if (process.platform !== "linux") return false;
  if (!existsSync(BUSCTL)) return false;
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return false;
  return Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY || process.env.XDG_SESSION_TYPE);
}

export async function listKdeWindows(): Promise<DesktopWindowInfo[]> {
  if (!kdeWindowAwarenessAvailable()) {
    throw new Error("KDE window awareness is unavailable in this desktop session.");
  }

  const matches = await busctlJson([
    "call",
    KWIN_SERVICE,
    KWIN_WINDOWS_RUNNER,
    "org.kde.krunner1",
    "Match",
    "s",
    "",
  ]);
  const rawMatches = Array.isArray(matches.data?.[0]) ? matches.data![0] as unknown[] : [];
  const windows = new Map<string, { uuid: string; runnerTitle?: string }>();

  for (const value of rawMatches) {
    if (!Array.isArray(value) || typeof value[0] !== "string") continue;
    const uuid = runnerIdToUuid(value[0]);
    if (!uuid) continue;
    const runnerTitle = typeof value[1] === "string" && value[1].trim() !== "" ? value[1] : undefined;
    if (!windows.has(uuid)) windows.set(uuid, { uuid, runnerTitle });
  }

  return mapConcurrent([...windows.values()], WINDOW_INFO_CONCURRENCY, async ({ uuid, runnerTitle }) => {
    const info = await getKwinWindowInfo(uuid);
    return toDesktopWindowInfo(info, uuid, runnerTitle);
  });
}

async function getKwinWindowInfo(uuid: string): Promise<Record<string, BusVariant>> {
  const response = await busctlJson([
    "call",
    KWIN_SERVICE,
    KWIN_OBJECT,
    "org.kde.KWin",
    "getWindowInfo",
    "s",
    uuid,
  ]);
  const map = response.data?.[0];
  if (!map || typeof map !== "object" || Array.isArray(map)) return {};
  return map as Record<string, BusVariant>;
}

function toDesktopWindowInfo(
  info: Record<string, BusVariant>,
  uuid: string,
  runnerTitle?: string,
): DesktopWindowInfo {
  const pid = numberValue(info.pid);
  const title = stringValue(info.caption) ?? runnerTitle ?? "";
  const desktopFile = stringValue(info.desktopFile);
  const resourceClass = stringValue(info.resourceClass);
  const resourceName = stringValue(info.resourceName);
  const processInfo = pid !== undefined ? readProcessIdentity(pid) : {};

  return {
    id: uuid,
    uuid,
    title,
    ...(pid !== undefined ? { pid } : {}),
    ...(desktopFile ? { desktopFile } : {}),
    ...(resourceClass ? { resourceClass } : {}),
    ...(resourceName ? { resourceName } : {}),
    applicationId: desktopFile || resourceClass || resourceName,
    ...(stringValue(info.role) ? { role: stringValue(info.role) } : {}),
    ...(stringValue(info.clientMachine) ? { clientMachine: stringValue(info.clientMachine) } : {}),
    ...(numberValue(info.x) !== undefined ? { x: numberValue(info.x) } : {}),
    ...(numberValue(info.y) !== undefined ? { y: numberValue(info.y) } : {}),
    ...(numberValue(info.width) !== undefined ? { width: numberValue(info.width) } : {}),
    ...(numberValue(info.height) !== undefined ? { height: numberValue(info.height) } : {}),
    minimized: booleanValue(info.minimized) ?? false,
    fullscreen: booleanValue(info.fullscreen) ?? false,
    maximizedHorizontal: (numberValue(info.maximizeHorizontal) ?? 0) !== 0,
    maximizedVertical: (numberValue(info.maximizeVertical) ?? 0) !== 0,
    keepAbove: booleanValue(info.keepAbove) ?? false,
    keepBelow: booleanValue(info.keepBelow) ?? false,
    skipTaskbar: booleanValue(info.skipTaskbar) ?? false,
    skipPager: booleanValue(info.skipPager) ?? false,
    skipSwitcher: booleanValue(info.skipSwitcher) ?? false,
    noBorder: booleanValue(info.noBorder) ?? false,
    excludeFromCapture: booleanValue(info.excludeFromCapture) ?? false,
    desktops: stringListValue(info.desktops),
    activities: stringListValue(info.activities),
    ...processInfo,
  };
}

function readProcessIdentity(pid: number): Pick<DesktopWindowInfo, "processName" | "executable"> {
  const result: Pick<DesktopWindowInfo, "processName" | "executable"> = {};
  try {
    const processName = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    if (processName) result.processName = processName;
  } catch {
    // Process may exit between KWin enumeration and /proc inspection.
  }
  try {
    result.executable = readlinkSync(`/proc/${pid}/exe`);
  } catch {
    // Process may exit or hide its executable path.
  }
  return result;
}

async function busctlJson(args: string[]): Promise<BusctlResponse> {
  const { stdout } = await execFileAsync(BUSCTL, ["--user", "--json=short", ...args], {
    encoding: "utf8",
    maxBuffer: DEFAULT_MAX_BUFFER,
    env: process.env,
  });
  const parsed = JSON.parse(stdout) as BusctlResponse;
  if (!parsed || typeof parsed !== "object") throw new Error("KWin returned an invalid D-Bus response.");
  return parsed;
}

function runnerIdToUuid(value: string): string | undefined {
  const match = /^\d+_(\{[0-9a-f-]+\})$/i.exec(value);
  return match?.[1];
}

function variantData(value: BusVariant | undefined): unknown {
  return value?.data;
}

function stringValue(value: BusVariant | undefined): string | undefined {
  const data = variantData(value);
  return typeof data === "string" && data !== "" ? data : undefined;
}

function numberValue(value: BusVariant | undefined): number | undefined {
  const data = variantData(value);
  return typeof data === "number" && Number.isFinite(data) ? data : undefined;
}

function booleanValue(value: BusVariant | undefined): boolean | undefined {
  const data = variantData(value);
  return typeof data === "boolean" ? data : undefined;
}

function stringListValue(value: BusVariant | undefined): string[] {
  const data = variantData(value);
  return Array.isArray(data) ? data.filter((item): item is string => typeof item === "string") : [];
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
