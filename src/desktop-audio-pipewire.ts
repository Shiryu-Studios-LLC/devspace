import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type {
  DesktopAudioGraph,
  DesktopAudioLink,
  DesktopAudioNode,
  DesktopAudioPort,
  DesktopAudioRuntimeNode,
  DesktopAudioRuntimeSnapshot,
} from "./desktop-agent-protocol.js";

const execFileAsync = promisify(execFile);
const PW_DUMP = "/usr/bin/pw-dump";
const PW_TOP = "/usr/bin/pw-top";
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;
const RUNTIME_SAMPLE_ITERATIONS = 2;
const RUNTIME_TIMEOUT_MS = 3_000;

interface PipeWireObject {
  id?: unknown;
  type?: unknown;
  info?: {
    state?: unknown;
    props?: Record<string, unknown>;
    params?: Record<string, unknown>;
  };
}

export function pipeWireAudioAwarenessAvailable(): boolean {
  return process.platform === "linux"
    && existsSync(PW_DUMP)
    && Boolean(process.env.XDG_RUNTIME_DIR);
}

export function pipeWireAudioRuntimeAvailable(): boolean {
  return pipeWireAudioAwarenessAvailable() && existsSync(PW_TOP);
}

export async function getPipeWireAudioRuntime(): Promise<DesktopAudioRuntimeSnapshot> {
  if (!pipeWireAudioRuntimeAvailable()) {
    throw new Error("PipeWire runtime telemetry is unavailable in this desktop session.");
  }
  const { stdout } = await execFileAsync(PW_TOP, ["-b", "-n", String(RUNTIME_SAMPLE_ITERATIONS)], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: RUNTIME_TIMEOUT_MS,
    env: process.env,
  });
  return parsePipeWireTop(stdout, RUNTIME_SAMPLE_ITERATIONS);
}

export async function getPipeWireAudioGraph(): Promise<DesktopAudioGraph> {
  if (!pipeWireAudioAwarenessAvailable()) {
    throw new Error("PipeWire audio awareness is unavailable in this desktop session.");
  }

  const { stdout } = await execFileAsync(PW_DUMP, [], {
    encoding: "utf8",
    maxBuffer: DEFAULT_MAX_BUFFER,
    env: process.env,
  });
  return normalizePipeWireAudioGraph(JSON.parse(stdout) as unknown);
}

export function normalizePipeWireAudioGraph(raw: unknown): DesktopAudioGraph {
  if (!Array.isArray(raw)) throw new Error("pw-dump returned an invalid PipeWire graph.");
  const objects = raw.filter((value): value is PipeWireObject => Boolean(value && typeof value === "object"));

  const nodes = objects
    .filter((object) => object.type === "PipeWire:Interface:Node")
    .map(normalizeNode)
    .filter((node): node is DesktopAudioNode => Boolean(node));
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  const ports = objects
    .filter((object) => object.type === "PipeWire:Interface:Port")
    .map(normalizePort)
    .filter((port): port is DesktopAudioPort => port !== undefined && nodeMap.has(port.nodeId));
  const portMap = new Map(ports.map((port) => [port.id, port]));

  const links = objects
    .filter((object) => object.type === "PipeWire:Interface:Link")
    .map((object) => normalizeLink(object, nodeMap, portMap))
    .filter((link): link is DesktopAudioLink => Boolean(link));

  return {
    nodes,
    ports,
    links,
    generatedAt: new Date().toISOString(),
  };
}

function normalizeNode(object: PipeWireObject): DesktopAudioNode | undefined {
  const id = integerValue(object.id);
  const props = object.info?.props ?? {};
  const mediaClass = stringValue(props["media.class"]);
  if (id === undefined || !mediaClass || !isAudioMediaClass(mediaClass)) return undefined;
  const name = stringValue(props["node.name"])
    ?? stringValue(props["media.name"])
    ?? `audio-node-${id}`;
  const params = object.info?.params ?? {};
  const propsParam = firstRecord(params.Props);
  const formatParam = firstRecord(params.Format);
  const processLatencyParam = firstRecord(params.ProcessLatency);
  const formatRate = integerValue(formatParam?.rate);
  const rate = parseRate(stringValue(props["node.rate"])) ?? formatRate;

  return {
    id,
    name,
    mediaClass,
    state: stringValue(object.info?.state),
    nick: stringValue(props["node.nick"]),
    description: stringValue(props["node.description"]),
    applicationName: stringValue(props["application.name"]),
    applicationBinary: stringValue(props["application.process.binary"]),
    pid: integerValue(props["application.process.id"]),
    clientId: integerValue(props["client.id"]),
    deviceId: integerValue(props["device.id"]),
    mediaName: stringValue(props["media.name"]),
    targetObject: stringValue(props["target.object"]),
    sampleRate: rate,
    latency: stringValue(props["node.latency"]),
    volume: numberValue(propsParam?.volume),
    mute: booleanValue(propsParam?.mute),
    channelVolumes: numberArray(propsParam?.channelVolumes),
    channelMap: stringArray(propsParam?.channelMap),
    softMute: booleanValue(propsParam?.softMute),
    softVolumes: numberArray(propsParam?.softVolumes),
    monitorMute: booleanValue(propsParam?.monitorMute),
    monitorVolumes: numberArray(propsParam?.monitorVolumes),
    audioFormat: stringValue(formatParam?.format),
    channels: integerValue(formatParam?.channels),
    streamLive: booleanValue(props["stream.is-live"]),
    corked: booleanValue(props["pulse.corked"]),
    processLatencyQuantum: numberValue(processLatencyParam?.quantum),
    processLatencyRate: integerValue(processLatencyParam?.rate),
    processLatencyNs: integerValue(processLatencyParam?.ns),
    isStream: mediaClass.startsWith("Stream/"),
    isSink: mediaClass === "Audio/Sink",
    isSource: mediaClass === "Audio/Source",
  };
}

function normalizePort(object: PipeWireObject): DesktopAudioPort | undefined {
  const id = integerValue(object.id);
  const props = object.info?.props ?? {};
  const nodeId = integerValue(props["node.id"]);
  const direction = stringValue(props["port.direction"]);
  if (id === undefined || nodeId === undefined || (direction !== "in" && direction !== "out")) return undefined;
  return {
    id,
    nodeId,
    name: stringValue(props["port.name"]) ?? `port-${id}`,
    direction,
    alias: stringValue(props["port.alias"]),
    channel: stringValue(props["audio.channel"]),
  };
}

function normalizeLink(
  object: PipeWireObject,
  nodes: Map<number, DesktopAudioNode>,
  ports: Map<number, DesktopAudioPort>,
): DesktopAudioLink | undefined {
  const id = integerValue(object.id);
  const props = object.info?.props ?? {};
  const outputNodeId = integerValue(props["link.output.node"]);
  const outputPortId = integerValue(props["link.output.port"]);
  const inputNodeId = integerValue(props["link.input.node"]);
  const inputPortId = integerValue(props["link.input.port"]);
  if (
    id === undefined
    || outputNodeId === undefined
    || outputPortId === undefined
    || inputNodeId === undefined
    || inputPortId === undefined
    || !nodes.has(outputNodeId)
    || !nodes.has(inputNodeId)
  ) return undefined;

  const outputNode = nodes.get(outputNodeId)!;
  const inputNode = nodes.get(inputNodeId)!;
  return {
    id,
    state: stringValue(object.info?.state) ?? "unknown",
    outputNodeId,
    outputPortId,
    inputNodeId,
    inputPortId,
    outputNodeName: outputNode.description ?? outputNode.nick ?? outputNode.name,
    inputNodeName: inputNode.description ?? inputNode.nick ?? inputNode.name,
    outputPortName: ports.get(outputPortId)?.name,
    inputPortName: ports.get(inputPortId)?.name,
  };
}

export function parsePipeWireTop(
  stdout: string,
  samplingIterations = RUNTIME_SAMPLE_ITERATIONS,
  now: () => number = Date.now,
): DesktopAudioRuntimeSnapshot {
  const lines = stdout.split(/\r?\n/);
  let lastHeader = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*S\s+ID\s+QUANT\s+RATE\s+WAIT\s+BUSY\s+W\/Q\s+B\/Q\s+ERR\s+FORMAT\s+NAME\s*$/.test(lines[index] ?? "")) {
      lastHeader = index;
    }
  }
  if (lastHeader < 0) throw new Error("pw-top returned an invalid runtime snapshot.");

  const nodes: DesktopAudioRuntimeNode[] = [];
  for (const line of lines.slice(lastHeader + 1)) {
    const node = parsePipeWireTopLine(line);
    if (node) nodes.push(node);
  }
  return {
    generatedAt: new Date(now()).toISOString(),
    samplingIterations,
    nodes,
  };
}

function parsePipeWireTopLine(line: string): DesktopAudioRuntimeNode | undefined {
  const match = /^\s*([A-Z])\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*(.*)$/.exec(line);
  if (!match) return undefined;
  const id = Number(match[2]);
  const quantum = Number(match[3]);
  const rate = Number(match[4]);
  const errors = Number(match[9]);
  if (![id, quantum, rate, errors].every(Number.isSafeInteger)) return undefined;

  const remainder = (match[10] ?? "").trim();
  let audioFormat: string | undefined;
  let channels: number | undefined;
  let formatRate: number | undefined;
  let name = remainder;
  const formatMatch = /^(\S+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(remainder);
  if (formatMatch && isPipeWireAudioFormat(formatMatch[1] ?? "")) {
    audioFormat = formatMatch[1];
    channels = Number(formatMatch[2]);
    formatRate = Number(formatMatch[3]);
    name = formatMatch[4] ?? "";
  }
  name = name.replace(/^\+\s*/, "").trim();
  if (!name) name = `audio-node-${id}`;

  return {
    id,
    stateCode: match[1] ?? "?",
    running: match[1] === "R",
    quantum,
    rate,
    waitUsec: parsePipeWireDurationUsec(match[5]),
    busyUsec: parsePipeWireDurationUsec(match[6]),
    waitRatio: parsePipeWireRatio(match[7]),
    busyRatio: parsePipeWireRatio(match[8]),
    errors,
    audioFormat,
    channels: Number.isSafeInteger(channels) ? channels : undefined,
    formatRate: Number.isSafeInteger(formatRate) ? formatRate : undefined,
    name,
  };
}

function parsePipeWireDurationUsec(value: string | undefined): number | undefined {
  if (!value || value === "---") return undefined;
  const match = /^(\d+(?:\.\d+)?)(ns|us|ms|s)$/.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  switch (match[2]) {
    case "ns": return amount / 1_000;
    case "us": return amount;
    case "ms": return amount * 1_000;
    case "s": return amount * 1_000_000;
    default: return undefined;
  }
}

function parsePipeWireRatio(value: string | undefined): number | undefined {
  if (!value || value === "---" || value === "???") return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function isPipeWireAudioFormat(value: string): boolean {
  return /^(?:[FSU]\d+(?:_\d+)?(?:LE|BE|P)?|UNKNOWN)$/.test(value);
}

function isAudioMediaClass(mediaClass: string): boolean {
  return mediaClass === "Audio/Sink"
    || mediaClass === "Audio/Source"
    || mediaClass === "Audio/Duplex"
    || mediaClass.startsWith("Stream/Input/Audio")
    || mediaClass.startsWith("Stream/Output/Audio");
}

function parseRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const fraction = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!fraction) return undefined;
  const denominator = Number(fraction[2]);
  return Number.isFinite(denominator) && denominator > 0 ? denominator : undefined;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberArray(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item)) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
