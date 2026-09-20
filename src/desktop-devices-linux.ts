import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { DesktopDeviceInfo } from "./desktop-agent-protocol.js";

const execFileAsync = promisify(execFile);
const USB_ROOT = "/sys/bus/usb/devices";
const PCI_ROOT = "/sys/bus/pci/devices";
const LSBLK = "/usr/bin/lsblk";
const LSPCI = "/usr/bin/lspci";
const BLUETOOTHCTL = "/usr/bin/bluetoothctl";
const MAX_BUFFER = 8 * 1024 * 1024;

interface LsblkDevice {
  name?: unknown;
  kname?: unknown;
  type?: unknown;
  size?: unknown;
  model?: unknown;
  vendor?: unknown;
  tran?: unknown;
  rm?: unknown;
  hotplug?: unknown;
  mountpoints?: unknown;
  children?: unknown;
}

export function linuxDeviceAwarenessAvailable(): boolean {
  return process.platform === "linux" && (existsSync(USB_ROOT) || existsSync(PCI_ROOT) || existsSync(LSBLK));
}

export async function listLinuxDevices(): Promise<DesktopDeviceInfo[]> {
  if (!linuxDeviceAwarenessAvailable()) {
    throw new Error("Linux hardware device awareness is unavailable.");
  }

  const [usbResult, pciResult, blockResult, bluetoothResult] = await Promise.allSettled([
    listUsbDevices(),
    listPciDevices(),
    listBlockDevices(),
    listBluetoothDevices(),
  ]);

  const devices = [
    ...(usbResult.status === "fulfilled" ? usbResult.value : []),
    ...(pciResult.status === "fulfilled" ? pciResult.value : []),
    ...(blockResult.status === "fulfilled" ? blockResult.value : []),
    ...(bluetoothResult.status === "fulfilled" ? bluetoothResult.value : []),
  ];

  devices.sort((a, b) => a.subsystem.localeCompare(b.subsystem) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return devices;
}

async function listUsbDevices(): Promise<DesktopDeviceInfo[]> {
  if (!existsSync(USB_ROOT)) return [];
  const entries = await fs.readdir(USB_ROOT, { withFileTypes: true });
  const devices: DesktopDeviceInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const root = join(USB_ROOT, entry.name);
    const vendorId = await readTrimmed(join(root, "idVendor"));
    const productId = await readTrimmed(join(root, "idProduct"));
    if (!vendorId || !productId) continue;
    const manufacturer = await readTrimmed(join(root, "manufacturer"));
    const product = await readTrimmed(join(root, "product"));
    const classCode = await readTrimmed(join(root, "bDeviceClass"));
    const speed = await readTrimmed(join(root, "speed"));
    const driver = await linkedBasename(join(root, "driver"));
    const name = product || manufacturer || `USB ${vendorId}:${productId}`;
    devices.push({
      id: `usb:${entry.name}`,
      subsystem: "usb",
      category: usbCategory(classCode),
      name,
      vendor: manufacturer,
      model: product,
      vendorId,
      productId,
      classCode,
      driver,
      path: entry.name,
      transport: "usb",
      speed: speed ? `${speed} Mb/s` : undefined,
      connected: true,
      hotplug: !entry.name.startsWith("usb"),
      removable: true,
      mountpoints: [],
    });
  }
  return devices;
}

async function listPciDevices(): Promise<DesktopDeviceInfo[]> {
  if (!existsSync(PCI_ROOT)) return [];
  const labels = existsSync(LSPCI) ? await pciLabels().catch(() => new Map<string, PciLabel>()) : new Map<string, PciLabel>();
  const entries = await fs.readdir(PCI_ROOT, { withFileTypes: true });
  const devices: DesktopDeviceInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const root = join(PCI_ROOT, entry.name);
    const vendorId = stripHexPrefix(await readTrimmed(join(root, "vendor")));
    const productId = stripHexPrefix(await readTrimmed(join(root, "device")));
    if (!vendorId || !productId) continue;
    const classCode = stripHexPrefix(await readTrimmed(join(root, "class")));
    const driver = await linkedBasename(join(root, "driver"));
    const label = labels.get(entry.name);
    const model = label?.device;
    devices.push({
      id: `pci:${entry.name}`,
      subsystem: "pci",
      category: label?.className ?? pciCategory(classCode),
      name: model ?? `${label?.vendor ?? "PCI device"} ${vendorId}:${productId}`,
      vendor: label?.vendor,
      model,
      vendorId,
      productId,
      classCode,
      driver,
      path: entry.name,
      transport: "pci",
      connected: true,
      hotplug: false,
      removable: false,
      mountpoints: [],
    });
  }
  return devices;
}

async function listBlockDevices(): Promise<DesktopDeviceInfo[]> {
  if (!existsSync(LSBLK)) return [];
  const { stdout } = await execFileAsync(LSBLK, [
    "--json",
    "--bytes",
    "-o",
    "NAME,KNAME,TYPE,SIZE,MODEL,VENDOR,TRAN,RM,HOTPLUG,MOUNTPOINTS",
  ], { encoding: "utf8", maxBuffer: MAX_BUFFER, env: process.env });
  const parsed = JSON.parse(stdout) as { blockdevices?: unknown };
  if (!Array.isArray(parsed.blockdevices)) return [];
  return flattenBlockDevices(parsed.blockdevices as LsblkDevice[]);
}

function flattenBlockDevices(values: LsblkDevice[], parentName?: string): DesktopDeviceInfo[] {
  const result: DesktopDeviceInfo[] = [];
  for (const value of values) {
    const name = stringValue(value.name);
    const kname = stringValue(value.kname) ?? name;
    if (!name || !kname) continue;
    const type = stringValue(value.type) ?? "block";
    const model = cleanString(value.model);
    const vendor = cleanString(value.vendor);
    const transport = cleanString(value.tran);
    const sizeBytes = integerValue(value.size);
    const mountpoints = stringArray(value.mountpoints);
    result.push({
      id: `block:${kname}`,
      subsystem: "block",
      category: type,
      name: model ?? name,
      vendor,
      model,
      path: `/dev/${kname}`,
      transport,
      connected: true,
      hotplug: booleanValue(value.hotplug),
      removable: booleanValue(value.rm),
      sizeBytes,
      parentId: parentName ? `block:${parentName}` : undefined,
      mountpoints,
    });
    if (Array.isArray(value.children)) {
      result.push(...flattenBlockDevices(value.children as LsblkDevice[], kname));
    }
  }
  return result;
}

interface PciLabel {
  className?: string;
  vendor?: string;
  device?: string;
}

async function pciLabels(): Promise<Map<string, PciLabel>> {
  const { stdout } = await execFileAsync(LSPCI, ["-Dmm", "-nn"], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    env: process.env,
  });
  const labels = new Map<string, PciLabel>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = quotedFields(line);
    if (fields.length < 4) continue;
    labels.set(fields[0]!, {
      className: stripBracketId(fields[1]),
      vendor: stripBracketId(fields[2]),
      device: stripBracketId(fields[3]),
    });
  }
  return labels;
}

async function listBluetoothDevices(): Promise<DesktopDeviceInfo[]> {
  if (!existsSync(BLUETOOTHCTL)) return [];
  const env = bluetoothEnvironment();
  const [paired, connected] = await Promise.all([
    bluetoothDeviceLines("Paired", env).catch(() => []),
    bluetoothDeviceLines("Connected", env).catch(() => []),
  ]);
  const connectedAddresses = new Set(connected.map((device) => device.address));
  const merged = new Map<string, { address: string; name: string; paired: boolean; connected: boolean }>();
  for (const device of paired) merged.set(device.address, { ...device, paired: true, connected: connectedAddresses.has(device.address) });
  for (const device of connected) {
    const existing = merged.get(device.address);
    merged.set(device.address, existing
      ? { ...existing, connected: true }
      : { ...device, paired: false, connected: true });
  }
  return [...merged.values()].map((device) => ({
    id: `bluetooth:${hashIdentifier(device.address)}`,
    subsystem: "bluetooth" as const,
    category: "bluetooth-device",
    name: device.name,
    transport: "bluetooth",
    connected: device.connected,
    hotplug: true,
    removable: true,
    paired: device.paired,
    mountpoints: [],
  }));
}

async function bluetoothDeviceLines(
  selector: "Paired" | "Connected",
  env: NodeJS.ProcessEnv,
): Promise<Array<{ address: string; name: string }>> {
  const { stdout } = await execFileAsync(BLUETOOTHCTL, ["devices", selector], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    env,
    timeout: 5_000,
  });
  const result: Array<{ address: string; name: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^Device\s+([0-9A-Fa-f:]{17})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    result.push({ address: match[1]!.toUpperCase(), name: match[2]!.trim() });
  }
  return result;
}

function bluetoothEnvironment(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  if (uid === undefined) return process.env;
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus`,
  };
}

async function readTrimmed(path: string): Promise<string | undefined> {
  try {
    const value = (await fs.readFile(path, "utf8")).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function linkedBasename(path: string): Promise<string | undefined> {
  try {
    return basename(await fs.realpath(path));
  } catch {
    return undefined;
  }
}

function quotedFields(line: string): string[] {
  const fields: string[] = [];
  for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    fields.push(match[1] !== undefined ? match[1].replace(/\\"/g, '"') : match[2]!);
  }
  return fields;
}

function stripBracketId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const result = value.replace(/\s*\[[0-9a-fA-F]{4}\]\s*$/, "").trim();
  return result || undefined;
}

function stripHexPrefix(value: string | undefined): string | undefined {
  return value?.replace(/^0x/i, "").toLowerCase();
}

function usbCategory(classCode: string | undefined): string {
  switch (classCode?.toLowerCase()) {
    case "01": return "audio";
    case "03": return "human-interface";
    case "08": return "storage";
    case "09": return "hub";
    case "0e": return "video";
    case "e0": return "wireless";
    default: return "usb-device";
  }
}

function pciCategory(classCode: string | undefined): string {
  const base = classCode?.slice(0, 2).toLowerCase();
  switch (base) {
    case "01": return "storage-controller";
    case "02": return "network-controller";
    case "03": return "display-controller";
    case "04": return "multimedia-controller";
    case "06": return "bridge";
    case "0c": return "serial-bus-controller";
    default: return "pci-device";
  }
}

function hashIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item !== "");
}
