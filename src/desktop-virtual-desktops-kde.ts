import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { DesktopVirtualDesktopSnapshot } from "./desktop-agent-protocol.js";

const execFileAsync = promisify(execFile);
const BUSCTL = "/usr/bin/busctl";
const KWIN_SERVICE = "org.kde.KWin";
const VIRTUAL_DESKTOP_PATH = "/VirtualDesktopManager";
const VIRTUAL_DESKTOP_INTERFACE = "org.kde.KWin.VirtualDesktopManager";
const PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
const DEFAULT_MAX_BUFFER = 1024 * 1024;

interface BusctlResponse {
  type?: string;
  data?: unknown[];
}

interface BusVariant {
  type?: string;
  data?: unknown;
}

export function kdeVirtualDesktopAwarenessAvailable(): boolean {
  if (process.platform !== "linux" || !existsSync(BUSCTL)) return false;
  const uid = process.getuid?.();
  const runtimeDir = process.env.XDG_RUNTIME_DIR || (uid === undefined ? undefined : `/run/user/${uid}`);
  const busAddress = process.env.DBUS_SESSION_BUS_ADDRESS || (runtimeDir ? `unix:path=${runtimeDir}/bus` : undefined);
  if (!busAddress?.startsWith("unix:path=")) return false;
  return existsSync(busAddress.slice("unix:path=".length));
}

export async function getKdeVirtualDesktopSnapshot(): Promise<DesktopVirtualDesktopSnapshot> {
  if (!kdeVirtualDesktopAwarenessAvailable()) {
    throw new Error("KDE virtual desktop awareness is unavailable in this desktop session.");
  }
  const response = await busctlJson([
    "call",
    KWIN_SERVICE,
    VIRTUAL_DESKTOP_PATH,
    PROPERTIES_INTERFACE,
    "GetAll",
    "s",
    VIRTUAL_DESKTOP_INTERFACE,
  ]);
  return parseKdeVirtualDesktopProperties(response.data?.[0]);
}

export function parseKdeVirtualDesktopProperties(
  raw: unknown,
  now: () => number = Date.now,
): DesktopVirtualDesktopSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("KWin returned an invalid virtual desktop response.");
  }
  const props = raw as Record<string, BusVariant>;
  const currentId = stringVariant(props.current) ?? "";
  const desktops = Array.isArray(props.desktops?.data)
    ? (props.desktops!.data as unknown[]).flatMap((value) => {
        if (!Array.isArray(value) || typeof value[0] !== "number" || typeof value[1] !== "string" || typeof value[2] !== "string") return [];
        return [{ position: value[0], id: value[1], name: value[2], current: value[1] === currentId }];
      })
    : [];
  return {
    generatedAt: new Date(now()).toISOString(),
    currentId,
    count: integerVariant(props.count) ?? desktops.length,
    rows: integerVariant(props.rows) ?? 1,
    navigationWrappingAround: booleanVariant(props.navigationWrappingAround) ?? false,
    desktops,
  };
}

async function busctlJson(args: string[]): Promise<BusctlResponse> {
  const uid = process.getuid?.();
  const runtimeDir = process.env.XDG_RUNTIME_DIR || (uid === undefined ? undefined : `/run/user/${uid}`);
  const busAddress = process.env.DBUS_SESSION_BUS_ADDRESS || (runtimeDir ? `unix:path=${runtimeDir}/bus` : undefined);
  const { stdout } = await execFileAsync(BUSCTL, ["--user", "--json=short", ...args], {
    encoding: "utf8",
    maxBuffer: DEFAULT_MAX_BUFFER,
    env: {
      ...process.env,
      ...(runtimeDir ? { XDG_RUNTIME_DIR: runtimeDir } : {}),
      ...(busAddress ? { DBUS_SESSION_BUS_ADDRESS: busAddress } : {}),
    },
  });
  return JSON.parse(stdout) as BusctlResponse;
}

function stringVariant(value: BusVariant | undefined): string | undefined {
  return typeof value?.data === "string" ? value.data : undefined;
}

function integerVariant(value: BusVariant | undefined): number | undefined {
  return typeof value?.data === "number" && Number.isSafeInteger(value.data) ? value.data : undefined;
}

function booleanVariant(value: BusVariant | undefined): boolean | undefined {
  return typeof value?.data === "boolean" ? value.data : undefined;
}
