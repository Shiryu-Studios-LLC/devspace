import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { promisify } from "node:util";
import type {
  DesktopNetworkAddress,
  DesktopNetworkDnsServer,
  DesktopNetworkInterface,
  DesktopNetworkListener,
  DesktopNetworkRoute,
  DesktopNetworkSnapshot,
} from "./desktop-agent-protocol.js";

const execFileAsync = promisify(execFile);
const IP = "/usr/bin/ip";
const SS = "/usr/bin/ss";
const RESOLVECTL = "/usr/bin/resolvectl";
const PROC = "/proc";
const MAX_BUFFER = 8 * 1024 * 1024;

interface IpAddressRecord {
  ifindex?: unknown;
  ifname?: unknown;
  flags?: unknown;
  mtu?: unknown;
  operstate?: unknown;
  link_type?: unknown;
  addr_info?: unknown;
}

interface IpAddressInfo {
  family?: unknown;
  local?: unknown;
  prefixlen?: unknown;
  scope?: unknown;
  dynamic?: unknown;
}

interface IpRouteRecord {
  dst?: unknown;
  gateway?: unknown;
  dev?: unknown;
  table?: unknown;
  protocol?: unknown;
  scope?: unknown;
  prefsrc?: unknown;
  metric?: unknown;
  type?: unknown;
  flags?: unknown;
}

export function linuxNetworkAwarenessAvailable(): boolean {
  return process.platform === "linux" && existsSync(IP);
}

export async function getLinuxNetworkSnapshot(): Promise<DesktopNetworkSnapshot> {
  if (!linuxNetworkAwarenessAvailable()) {
    throw new Error("Linux network awareness is unavailable.");
  }

  const [interfacesResult, routesResult, dnsResult, listenersResult, cloudflareResult] = await Promise.allSettled([
    listInterfaces(),
    listRoutes(),
    listDnsServers(),
    listListeners(),
    findCloudflareTunnelProcesses(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    interfaces: interfacesResult.status === "fulfilled" ? interfacesResult.value : [],
    routes: routesResult.status === "fulfilled" ? routesResult.value : [],
    dnsServers: dnsResult.status === "fulfilled" ? dnsResult.value : [],
    listeners: listenersResult.status === "fulfilled" ? listenersResult.value : [],
    cloudflareTunnel: {
      running: cloudflareResult.status === "fulfilled" && cloudflareResult.value.length > 0,
      pids: cloudflareResult.status === "fulfilled" ? cloudflareResult.value : [],
    },
  };
}

async function listInterfaces(): Promise<DesktopNetworkInterface[]> {
  const { stdout } = await execFileAsync(IP, ["-j", "address", "show"], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    env: process.env,
  });
  const raw = JSON.parse(stdout) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeInterface)
    .filter((value): value is DesktopNetworkInterface => value !== undefined)
    .sort((a, b) => a.index - b.index);
}

function normalizeInterface(value: unknown): DesktopNetworkInterface | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as IpAddressRecord;
  const index = integerValue(record.ifindex);
  const name = stringValue(record.ifname);
  if (index === undefined || !name) return undefined;
  const flags = stringArray(record.flags);
  const addressInfo = Array.isArray(record.addr_info) ? record.addr_info : [];
  const addresses = addressInfo
    .map(normalizeAddress)
    .filter((address): address is DesktopNetworkAddress => address !== undefined);
  return {
    index,
    name,
    kind: inferInterfaceKind(name, stringValue(record.link_type)),
    linkType: stringValue(record.link_type),
    operState: stringValue(record.operstate) ?? "unknown",
    mtu: integerValue(record.mtu),
    up: flags.includes("UP"),
    lowerUp: flags.includes("LOWER_UP"),
    loopback: flags.includes("LOOPBACK"),
    addresses,
  };
}

function normalizeAddress(value: unknown): DesktopNetworkAddress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as IpAddressInfo;
  const family = stringValue(record.family);
  const address = stringValue(record.local);
  const prefixLength = integerValue(record.prefixlen);
  if ((family !== "inet" && family !== "inet6") || !address || prefixLength === undefined) return undefined;
  return {
    family: family === "inet" ? "ipv4" : "ipv6",
    address,
    prefixLength,
    scope: stringValue(record.scope),
    dynamic: booleanValue(record.dynamic),
  };
}

async function listRoutes(): Promise<DesktopNetworkRoute[]> {
  const { stdout } = await execFileAsync(IP, ["-j", "route", "show", "table", "all"], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    env: process.env,
  });
  const raw = JSON.parse(stdout) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeRoute)
    .filter((value): value is DesktopNetworkRoute => value !== undefined);
}

function normalizeRoute(value: unknown): DesktopNetworkRoute | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as IpRouteRecord;
  const destination = stringValue(record.dst) ?? "default";
  const gateway = stringValue(record.gateway);
  const preferredSource = stringValue(record.prefsrc);
  const family = [destination, gateway, preferredSource].some((item) => item?.includes(":")) ? "ipv6" : "ipv4";
  return {
    family,
    destination,
    gateway,
    interfaceName: stringValue(record.dev),
    table: stringOrNumber(record.table),
    protocol: stringValue(record.protocol),
    scope: stringValue(record.scope),
    preferredSource,
    metric: integerValue(record.metric),
    type: stringValue(record.type),
    linkDown: stringArray(record.flags).includes("linkdown"),
  };
}

async function listDnsServers(): Promise<DesktopNetworkDnsServer[]> {
  if (!existsSync(RESOLVECTL)) return [];
  const { stdout } = await execFileAsync(RESOLVECTL, ["dns"], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    env: process.env,
    timeout: 5_000,
  });
  const result: DesktopNetworkDnsServer[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(Global|Link\s+\d+\s+\(([^)]+)\)):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const interfaceName = match[1] === "Global" ? undefined : match[2];
    for (const address of (match[3] ?? "").split(/\s+/).filter(Boolean)) {
      if (!looksLikeIpAddress(address)) continue;
      result.push({ interfaceName, address });
    }
  }
  return result;
}

async function listListeners(): Promise<DesktopNetworkListener[]> {
  if (!existsSync(SS)) return [];
  const { stdout } = await execFileAsync(SS, ["-H", "-ltnup"], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    env: process.env,
    timeout: 5_000,
  });
  const result: DesktopNetworkListener[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const listener = normalizeListener(line);
    if (listener) result.push(listener);
  }
  return result.sort((a, b) => a.protocol.localeCompare(b.protocol) || a.port - b.port || a.address.localeCompare(b.address));
}

function normalizeListener(line: string): DesktopNetworkListener | undefined {
  if (!line.trim()) return undefined;
  const parts = line.trim().split(/\s+/);
  if (parts.length < 6) return undefined;
  const protocolRaw = parts[0]?.toLowerCase();
  if (protocolRaw !== "tcp" && protocolRaw !== "udp") return undefined;
  const endpoint = parseEndpoint(parts[4] ?? "");
  if (!endpoint || endpoint.port === undefined) return undefined;
  const processText = parts.slice(6).join(" ");
  const owner = /users:\(\(\"([^\"]+)\",pid=(\d+)/.exec(processText);
  return {
    protocol: protocolRaw,
    address: endpoint.address,
    port: endpoint.port,
    interfaceName: endpoint.interfaceName,
    processName: owner?.[1],
    pid: owner?.[2] ? Number(owner[2]) : undefined,
  };
}

function parseEndpoint(value: string): { address: string; port?: number; interfaceName?: string } | undefined {
  let addressPart: string;
  let portPart: string;
  const bracketed = /^\[(.*)\]:(\*|\d+)$/.exec(value);
  if (bracketed) {
    addressPart = bracketed[1]!;
    portPart = bracketed[2]!;
  } else {
    const separator = value.lastIndexOf(":");
    if (separator < 0) return undefined;
    addressPart = value.slice(0, separator);
    portPart = value.slice(separator + 1);
  }
  if (portPart === "*") return undefined;
  const port = Number(portPart);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) return undefined;
  const percent = addressPart.lastIndexOf("%");
  const interfaceName = percent >= 0 ? addressPart.slice(percent + 1) : undefined;
  const address = percent >= 0 ? addressPart.slice(0, percent) : addressPart;
  return { address: address || "*", port, interfaceName };
}

async function findCloudflareTunnelProcesses(): Promise<number[]> {
  const entries = await fs.readdir(PROC, { withFileTypes: true });
  const pids: number[] = [];
  await Promise.all(entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map(async (entry) => {
    try {
      const comm = (await fs.readFile(`${PROC}/${entry.name}/comm`, "utf8")).trim();
      if (comm === "cloudflared") pids.push(Number(entry.name));
    } catch {
      // Processes can exit while /proc is being sampled.
    }
  }));
  return pids.sort((a, b) => a - b);
}

function inferInterfaceKind(name: string, linkType: string | undefined): string {
  if (name === "lo" || linkType === "loopback") return "loopback";
  if (/^(wl|wlan)/.test(name)) return "wifi";
  if (/^(en|eth)/.test(name)) return "ethernet";
  if (/^(docker|br-|virbr)/.test(name)) return "bridge";
  if (/^(tun|tap|wg)/.test(name)) return "tunnel";
  if (/^(awdl|mon\d|go\d)/.test(name)) return "wireless-virtual";
  return "virtual-or-other";
}

function looksLikeIpAddress(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || value.includes(":");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function stringOrNumber(value: unknown): string | number | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
