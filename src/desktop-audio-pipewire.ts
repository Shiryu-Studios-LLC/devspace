import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type {
  DesktopAudioGraph,
  DesktopAudioLink,
  DesktopAudioNode,
  DesktopAudioPort,
} from "./desktop-agent-protocol.js";

const execFileAsync = promisify(execFile);
const PW_DUMP = "/usr/bin/pw-dump";
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

interface PipeWireObject {
  id?: unknown;
  type?: unknown;
  info?: {
    state?: unknown;
    props?: Record<string, unknown>;
  };
}

export function pipeWireAudioAwarenessAvailable(): boolean {
  return process.platform === "linux"
    && existsSync(PW_DUMP)
    && Boolean(process.env.XDG_RUNTIME_DIR);
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
  const raw = JSON.parse(stdout) as unknown;
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
  const rate = parseRate(stringValue(props["node.rate"]));

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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
