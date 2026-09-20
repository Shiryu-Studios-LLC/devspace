import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type {
  DesktopDisplayInfo,
  DesktopDisplayMode,
} from "./desktop-agent-protocol.js";

const execFileAsync = promisify(execFile);
const KSCREEN_DOCTOR = "/usr/bin/kscreen-doctor";
const BUSCTL = "/usr/bin/busctl";
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

interface KScreenMode {
  id?: unknown;
  name?: unknown;
  refreshRate?: unknown;
  size?: { width?: unknown; height?: unknown };
}

interface KScreenOutput {
  id?: unknown;
  name?: unknown;
  connected?: unknown;
  enabled?: unknown;
  currentModeId?: unknown;
  preferredModes?: unknown;
  priority?: unknown;
  replicationSource?: unknown;
  rotation?: unknown;
  scale?: unknown;
  brightness?: unknown;
  ddcCiAllowed?: unknown;
  pos?: { x?: unknown; y?: unknown };
  size?: { width?: unknown; height?: unknown };
  sizeMM?: { width?: unknown; height?: unknown };
  modes?: unknown;
  clones?: unknown;
  type?: unknown;
}

interface KScreenJson {
  outputs?: unknown;
}

interface BusctlResponse {
  type?: string;
  data?: unknown[];
}

export function kdeDisplayAwarenessAvailable(): boolean {
  if (process.platform !== "linux") return false;
  if (!existsSync(KSCREEN_DOCTOR)) return false;
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return false;
  return Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY || process.env.XDG_SESSION_TYPE);
}

export async function listKdeDisplays(): Promise<DesktopDisplayInfo[]> {
  if (!kdeDisplayAwarenessAvailable()) {
    throw new Error("KDE display awareness is unavailable in this desktop session.");
  }

  const { stdout } = await execFileAsync(KSCREEN_DOCTOR, ["-j"], {
    encoding: "utf8",
    maxBuffer: DEFAULT_MAX_BUFFER,
    env: process.env,
  });
  const parsed = JSON.parse(stdout) as KScreenJson;
  const rawOutputs = Array.isArray(parsed.outputs) ? parsed.outputs : [];
  const activeOutputName = await getActiveOutputName();

  return rawOutputs
    .filter((value): value is KScreenOutput => Boolean(value && typeof value === "object" && !Array.isArray(value)))
    .map((output) => normalizeDisplay(output, activeOutputName));
}

function normalizeDisplay(output: KScreenOutput, activeOutputName?: string): DesktopDisplayInfo {
  const id = integerValue(output.id) ?? 0;
  const name = stringValue(output.name) ?? `output-${id}`;
  const modes = Array.isArray(output.modes)
    ? output.modes
        .filter((value): value is KScreenMode => Boolean(value && typeof value === "object" && !Array.isArray(value)))
        .map(normalizeMode)
        .filter((value): value is DesktopDisplayMode => Boolean(value))
    : [];
  const currentModeId = stringValue(output.currentModeId);
  const currentMode = currentModeId ? modes.find((mode) => mode.id === currentModeId) : undefined;
  const priority = integerValue(output.priority) ?? 0;
  const connected = booleanValue(output.connected) ?? false;
  const enabled = booleanValue(output.enabled) ?? false;

  return {
    id,
    name,
    connected,
    enabled,
    active: activeOutputName === name,
    primary: enabled && priority === 1,
    priority,
    x: numberValue(output.pos?.x) ?? 0,
    y: numberValue(output.pos?.y) ?? 0,
    width: numberValue(output.size?.width) ?? currentMode?.width ?? 0,
    height: numberValue(output.size?.height) ?? currentMode?.height ?? 0,
    scale: numberValue(output.scale) ?? 1,
    rotation: integerValue(output.rotation) ?? 1,
    brightness: numberValue(output.brightness),
    ddcCiAllowed: booleanValue(output.ddcCiAllowed),
    physicalWidthMm: numberValue(output.sizeMM?.width),
    physicalHeightMm: numberValue(output.sizeMM?.height),
    currentModeId,
    currentMode,
    preferredModeIds: stringList(output.preferredModes),
    modes,
    clones: integerList(output.clones),
    replicationSource: integerValue(output.replicationSource),
    connectorType: integerValue(output.type),
  };
}

function normalizeMode(value: KScreenMode): DesktopDisplayMode | undefined {
  const id = stringValue(value.id);
  const width = numberValue(value.size?.width);
  const height = numberValue(value.size?.height);
  if (!id || width === undefined || height === undefined) return undefined;
  return {
    id,
    name: stringValue(value.name) ?? `${width}x${height}`,
    width,
    height,
    refreshRate: numberValue(value.refreshRate),
  };
}

async function getActiveOutputName(): Promise<string | undefined> {
  if (!existsSync(BUSCTL)) return undefined;
  try {
    const { stdout } = await execFileAsync(BUSCTL, [
      "--user",
      "--json=short",
      "call",
      "org.kde.KWin",
      "/KWin",
      "org.kde.KWin",
      "activeOutputName",
    ], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      env: process.env,
    });
    const parsed = JSON.parse(stdout) as BusctlResponse;
    const value = parsed.data?.[0];
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function integerList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number" && Number.isSafeInteger(item))
    : [];
}
