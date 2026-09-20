import { DESKTOP_AGENT_PROTOCOL_VERSION } from "./desktop-agent-lifecycle.js";

export type DesktopCapabilityState = "ready" | "unavailable" | "disabled" | "not_implemented";

export interface DesktopCapabilityStatus {
  id: string;
  state: DesktopCapabilityState;
  detail?: string;
}

export interface DesktopAgentStatus {
  state: "ready" | "stopping";
  protocolVersion: number;
  pid: number;
  endpoint: string;
  startedAt: string;
  platform: NodeJS.Platform;
  sessionType: string;
  clientConnections: number;
  capabilities: DesktopCapabilityStatus[];
}

export interface DesktopWindowInfo {
  id: string;
  uuid: string;
  title: string;
  pid?: number;
  processName?: string;
  executable?: string;
  applicationId?: string;
  desktopFile?: string;
  resourceClass?: string;
  resourceName?: string;
  role?: string;
  clientMachine?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  minimized: boolean;
  fullscreen: boolean;
  maximizedHorizontal: boolean;
  maximizedVertical: boolean;
  keepAbove: boolean;
  keepBelow: boolean;
  skipTaskbar: boolean;
  skipPager: boolean;
  skipSwitcher: boolean;
  noBorder: boolean;
  excludeFromCapture: boolean;
  desktops: string[];
  activities: string[];
}

export interface DesktopDisplayMode {
  id: string;
  name: string;
  width: number;
  height: number;
  refreshRate?: number;
}

export interface DesktopDisplayInfo {
  id: number;
  name: string;
  connected: boolean;
  enabled: boolean;
  active: boolean;
  primary: boolean;
  priority: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  rotation: number;
  brightness?: number;
  ddcCiAllowed?: boolean;
  physicalWidthMm?: number;
  physicalHeightMm?: number;
  currentModeId?: string;
  currentMode?: DesktopDisplayMode;
  preferredModeIds: string[];
  modes: DesktopDisplayMode[];
  clones: number[];
  replicationSource?: number;
  connectorType?: number;
}

export interface DesktopProcessInfo {
  pid: number;
  ppid: number;
  uid?: number;
  sameUser?: boolean;
  name: string;
  state: string;
  executable?: string;
  threads?: number;
  residentMemoryBytes?: number;
  virtualMemoryBytes?: number;
  windowIds: string[];
  windowCount: number;
  hasWindow: boolean;
}

export type DesktopActivityEventType =
  | "process.started"
  | "process.stopped"
  | "window.created"
  | "window.closed"
  | "window.changed"
  | "display.connected"
  | "display.disconnected"
  | "display.changed"
  | "audio.stream.started"
  | "audio.stream.stopped"
  | "audio.stream.changed"
  | "audio.route.created"
  | "audio.route.removed"
  | "audio.route.changed"
  | "device.connected"
  | "device.disconnected"
  | "device.changed"
  | "network.interface.changed"
  | "network.route.changed"
  | "network.dns.changed"
  | "network.listener.opened"
  | "network.listener.closed"
  | "network.tunnel.started"
  | "network.tunnel.stopped"
  | "notification.created"
  | "notification.closed"
  | "virtual-desktop.created"
  | "virtual-desktop.removed"
  | "virtual-desktop.changed"
  | "virtual-desktop.current.changed";

export interface DesktopActivityEvent {
  sequence: number;
  timestamp: string;
  type: DesktopActivityEventType;
  sourceModule: "processes" | "windows" | "displays" | "audio" | "devices" | "network" | "notifications" | "virtual-desktops";
  entityId: string;
  correlationId: string;
  applicationId?: string;
  pid?: number;
  title?: string;
  summary: string;
}

export interface DesktopActivityTimeline {
  cursor: number;
  events: DesktopActivityEvent[];
}

export interface DesktopAudioNode {
  id: number;
  name: string;
  mediaClass: string;
  state?: string;
  nick?: string;
  description?: string;
  applicationName?: string;
  applicationBinary?: string;
  pid?: number;
  clientId?: number;
  deviceId?: number;
  mediaName?: string;
  targetObject?: string;
  sampleRate?: number;
  latency?: string;
  isStream: boolean;
  isSink: boolean;
  isSource: boolean;
}

export interface DesktopAudioPort {
  id: number;
  nodeId: number;
  name: string;
  direction: "in" | "out";
  alias?: string;
  channel?: string;
}

export interface DesktopAudioLink {
  id: number;
  state: string;
  outputNodeId: number;
  outputPortId: number;
  inputNodeId: number;
  inputPortId: number;
  outputNodeName: string;
  inputNodeName: string;
  outputPortName?: string;
  inputPortName?: string;
}

export interface DesktopAudioGraph {
  generatedAt: string;
  nodes: DesktopAudioNode[];
  ports: DesktopAudioPort[];
  links: DesktopAudioLink[];
}

export type DesktopDeviceSubsystem = "usb" | "pci" | "block" | "bluetooth";

export interface DesktopDeviceInfo {
  id: string;
  subsystem: DesktopDeviceSubsystem;
  category: string;
  name: string;
  vendor?: string;
  model?: string;
  vendorId?: string;
  productId?: string;
  classCode?: string;
  driver?: string;
  path?: string;
  transport?: string;
  speed?: string;
  connected: boolean;
  hotplug?: boolean;
  removable?: boolean;
  paired?: boolean;
  sizeBytes?: number;
  parentId?: string;
  mountpoints: string[];
}

export interface DesktopNetworkAddress {
  family: "ipv4" | "ipv6";
  address: string;
  prefixLength: number;
  scope?: string;
  dynamic?: boolean;
}

export interface DesktopNetworkInterface {
  index: number;
  name: string;
  kind: string;
  linkType?: string;
  operState: string;
  mtu?: number;
  up: boolean;
  lowerUp: boolean;
  loopback: boolean;
  addresses: DesktopNetworkAddress[];
}

export interface DesktopNetworkRoute {
  family: "ipv4" | "ipv6";
  destination: string;
  gateway?: string;
  interfaceName?: string;
  table?: string | number;
  protocol?: string;
  scope?: string;
  preferredSource?: string;
  metric?: number;
  type?: string;
  linkDown: boolean;
}

export interface DesktopNetworkDnsServer {
  interfaceName?: string;
  address: string;
}

export interface DesktopNetworkListener {
  protocol: "tcp" | "udp";
  address: string;
  port: number;
  interfaceName?: string;
  processName?: string;
  pid?: number;
}

export interface DesktopNetworkSnapshot {
  generatedAt: string;
  interfaces: DesktopNetworkInterface[];
  routes: DesktopNetworkRoute[];
  dnsServers: DesktopNetworkDnsServer[];
  listeners: DesktopNetworkListener[];
  cloudflareTunnel: {
    running: boolean;
    pids: number[];
  };
}

export interface DesktopVirtualDesktopInfo {
  position: number;
  id: string;
  name: string;
  current: boolean;
}

export interface DesktopVirtualDesktopSnapshot {
  generatedAt: string;
  currentId: string;
  count: number;
  rows: number;
  navigationWrappingAround: boolean;
  desktops: DesktopVirtualDesktopInfo[];
}

export interface DesktopLogSource {
  id: string;
  kind: "journal";
  label: string;
  selector: string;
  lastSeen?: string;
  sampledEntries: number;
}

export interface DesktopLogEntry {
  timestamp: string;
  priority?: number;
  unit?: string;
  identifier?: string;
  processName?: string;
  pid?: number;
  message: string;
}

export interface DesktopLogReadResult {
  sourceId: string;
  generatedAt: string;
  query?: string;
  entries: DesktopLogEntry[];
}

export interface DesktopTraceCorrelation {
  correlationId: string;
  generatedAt: string;
  events: DesktopActivityEvent[];
  logs?: DesktopLogReadResult;
}

export interface DesktopNotificationInfo {
  id: string;
  notificationId?: number;
  replacesId?: number;
  appName: string;
  summary: string;
  body: string;
  pid?: number;
  desktopEntry?: string;
  category?: string;
  urgency?: number;
  actions: Array<{ id: string; label: string }>;
  expireTimeoutMs: number;
  createdAt: string;
  closedAt?: string;
  closeReason?: number;
}

export type DesktopAgentMethod =
  | "hello"
  | "desktop.status"
  | "desktop.capabilities"
  | "windows.list"
  | "displays.list"
  | "processes.list"
  | "events.recent"
  | "audio.graph"
  | "devices.list"
  | "network.snapshot"
  | "virtual-desktops.snapshot"
  | "logs.sources"
  | "logs.read"
  | "trace.correlate"
  | "notifications.recent"
  | "desktop.stop";

type DesktopAgentRequestBase = {
  requestId: string;
  protocolVersion: number;
  authToken: string;
};

type DesktopAgentNoParamsMethod = Exclude<DesktopAgentMethod, "logs.read" | "trace.correlate">;

export type DesktopAgentRequest = DesktopAgentRequestBase & (
  | {
      method: DesktopAgentNoParamsMethod;
      params: Record<string, never>;
    }
  | {
      method: "logs.read";
      params: {
        sourceId: string;
        lines?: number;
        query?: string;
      };
    }
  | {
      method: "trace.correlate";
      params: {
        correlationId: string;
        lines?: number;
        query?: string;
      };
    }
);

export type DesktopAgentResponse =
  | {
      requestId: string;
      protocolVersion: number;
      ok: true;
      result: unknown;
    }
  | {
      requestId: string;
      protocolVersion: number;
      ok: false;
      error: {
        code: string;
        message: string;
        retryable?: boolean;
      };
    };

export class DesktopAgentProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DesktopAgentProtocolError";
  }
}

export function encodeDesktopAgentRequest(request: DesktopAgentRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function encodeDesktopAgentResponse(response: DesktopAgentResponse): string {
  return `${JSON.stringify(response)}\n`;
}

export function decodeDesktopAgentRequest(value: unknown): DesktopAgentRequest {
  const record = asRecord(value);
  const requestId = requiredString(record?.requestId, "requestId");
  const protocolVersion = requiredInteger(record?.protocolVersion, "protocolVersion");
  const authToken = requiredString(record?.authToken, "authToken");
  const method = requiredString(record?.method, "method") as DesktopAgentMethod;
  if (!isDesktopAgentMethod(method)) {
    throw new DesktopAgentProtocolError("UNKNOWN_METHOD", `Unknown desktop agent method: ${method}`);
  }
  const params = asRecord(record?.params);
  if (!params) {
    throw new DesktopAgentProtocolError("INVALID_PARAMS", `${method} requires an object params field.`);
  }
  if (method === "logs.read") {
    const sourceId = requiredString(params.sourceId, "logs.sourceId");
    const lines = params.lines === undefined ? undefined : requiredInteger(params.lines, "logs.lines");
    const query = params.query === undefined ? undefined : requiredString(params.query, "logs.query");
    const allowed = new Set(["sourceId", "lines", "query"]);
    if (Object.keys(params).some((key) => !allowed.has(key))) {
      throw new DesktopAgentProtocolError("INVALID_PARAMS", "logs.read received unknown parameters.");
    }
    return {
      requestId,
      protocolVersion,
      authToken,
      method,
      params: { sourceId, ...(lines === undefined ? {} : { lines }), ...(query === undefined ? {} : { query }) },
    };
  }
  if (method === "trace.correlate") {
    const correlationId = requiredString(params.correlationId, "trace.correlationId");
    const lines = params.lines === undefined ? undefined : requiredInteger(params.lines, "trace.lines");
    const query = params.query === undefined ? undefined : requiredString(params.query, "trace.query");
    const allowed = new Set(["correlationId", "lines", "query"]);
    if (Object.keys(params).some((key) => !allowed.has(key))) {
      throw new DesktopAgentProtocolError("INVALID_PARAMS", "trace.correlate received unknown parameters.");
    }
    return {
      requestId,
      protocolVersion,
      authToken,
      method,
      params: { correlationId, ...(lines === undefined ? {} : { lines }), ...(query === undefined ? {} : { query }) },
    };
  }
  if (Object.keys(params).length !== 0) {
    throw new DesktopAgentProtocolError("INVALID_PARAMS", `${method} does not accept parameters.`);
  }
  return { requestId, protocolVersion, authToken, method, params: {} };
}

export function decodeDesktopAgentResponse(value: unknown): DesktopAgentResponse {
  const record = asRecord(value);
  const requestId = requiredString(record?.requestId, "requestId");
  const protocolVersion = requiredInteger(record?.protocolVersion, "protocolVersion");
  if (record?.ok === true) {
    return { requestId, protocolVersion, ok: true, result: record.result };
  }
  if (record?.ok === false) {
    const error = asRecord(record.error);
    return {
      requestId,
      protocolVersion,
      ok: false,
      error: {
        code: requiredString(error?.code, "error.code"),
        message: requiredString(error?.message, "error.message"),
        retryable: optionalBoolean(error?.retryable),
      },
    };
  }
  throw new DesktopAgentProtocolError("INVALID_RESPONSE", "Desktop agent returned an invalid response.");
}

export function decodeDesktopAgentStatus(value: unknown): DesktopAgentStatus {
  const record = asRecord(value);
  const state = requiredString(record?.state, "state");
  if (state !== "ready" && state !== "stopping") {
    throw new DesktopAgentProtocolError("INVALID_STATUS", "Desktop agent returned an invalid state.");
  }
  const capabilities = record?.capabilities;
  if (!Array.isArray(capabilities)) {
    throw new DesktopAgentProtocolError("INVALID_STATUS", "Desktop agent capabilities are missing.");
  }
  return {
    state,
    protocolVersion: requiredInteger(record?.protocolVersion, "protocolVersion"),
    pid: requiredInteger(record?.pid, "pid"),
    endpoint: requiredString(record?.endpoint, "endpoint"),
    startedAt: requiredString(record?.startedAt, "startedAt"),
    platform: requiredString(record?.platform, "platform") as NodeJS.Platform,
    sessionType: requiredString(record?.sessionType, "sessionType"),
    clientConnections: requiredInteger(record?.clientConnections, "clientConnections"),
    capabilities: capabilities.map(decodeCapabilityStatus),
  };
}

export function decodeDesktopWindowList(value: unknown): DesktopWindowInfo[] {
  if (!Array.isArray(value)) {
    throw new DesktopAgentProtocolError("INVALID_WINDOWS", "Desktop agent returned an invalid window list.");
  }
  return value.map(decodeDesktopWindowInfo);
}

export function decodeDesktopDisplayList(value: unknown): DesktopDisplayInfo[] {
  if (!Array.isArray(value)) {
    throw new DesktopAgentProtocolError("INVALID_DISPLAYS", "Desktop agent returned an invalid display list.");
  }
  return value.map(decodeDesktopDisplayInfo);
}

export function decodeDesktopProcessList(value: unknown): DesktopProcessInfo[] {
  if (!Array.isArray(value)) {
    throw new DesktopAgentProtocolError("INVALID_PROCESSES", "Desktop agent returned an invalid process list.");
  }
  return value.map(decodeDesktopProcessInfo);
}

export function decodeDesktopActivityTimeline(value: unknown): DesktopActivityTimeline {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.events)) {
    throw new DesktopAgentProtocolError("INVALID_EVENTS", "Desktop agent returned an invalid activity timeline.");
  }
  return {
    cursor: requiredInteger(record.cursor, "events.cursor"),
    events: record.events.map(decodeDesktopActivityEvent),
  };
}

export function decodeDesktopAudioGraph(value: unknown): DesktopAudioGraph {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.nodes) || !Array.isArray(record.ports) || !Array.isArray(record.links)) {
    throw new DesktopAgentProtocolError("INVALID_AUDIO", "Desktop agent returned an invalid audio graph.");
  }
  return {
    generatedAt: requiredString(record.generatedAt, "audio.generatedAt"),
    nodes: record.nodes.map(decodeDesktopAudioNode),
    ports: record.ports.map(decodeDesktopAudioPort),
    links: record.links.map(decodeDesktopAudioLink),
  };
}

export function decodeDesktopDeviceList(value: unknown): DesktopDeviceInfo[] {
  if (!Array.isArray(value)) {
    throw new DesktopAgentProtocolError("INVALID_DEVICES", "Desktop agent returned an invalid device list.");
  }
  return value.map(decodeDesktopDeviceInfo);
}

export function decodeDesktopNetworkSnapshot(value: unknown): DesktopNetworkSnapshot {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.interfaces) || !Array.isArray(record.routes) || !Array.isArray(record.dnsServers) || !Array.isArray(record.listeners)) {
    throw new DesktopAgentProtocolError("INVALID_NETWORK", "Desktop agent returned an invalid network snapshot.");
  }
  const tunnel = asRecord(record.cloudflareTunnel);
  if (!tunnel) {
    throw new DesktopAgentProtocolError("INVALID_NETWORK", "Desktop agent returned invalid Cloudflare tunnel state.");
  }
  return {
    generatedAt: requiredString(record.generatedAt, "network.generatedAt"),
    interfaces: record.interfaces.map(decodeDesktopNetworkInterface),
    routes: record.routes.map(decodeDesktopNetworkRoute),
    dnsServers: record.dnsServers.map(decodeDesktopNetworkDnsServer),
    listeners: record.listeners.map(decodeDesktopNetworkListener),
    cloudflareTunnel: {
      running: requiredBoolean(tunnel.running, "network.cloudflareTunnel.running"),
      pids: integerArray(tunnel.pids, "network.cloudflareTunnel.pids"),
    },
  };
}

export function decodeDesktopVirtualDesktopSnapshot(value: unknown): DesktopVirtualDesktopSnapshot {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.desktops)) {
    throw new DesktopAgentProtocolError("INVALID_VIRTUAL_DESKTOPS", "Desktop agent returned an invalid virtual desktop snapshot.");
  }
  return {
    generatedAt: requiredString(record.generatedAt, "virtualDesktops.generatedAt"),
    currentId: requiredString(record.currentId, "virtualDesktops.currentId"),
    count: requiredInteger(record.count, "virtualDesktops.count"),
    rows: requiredInteger(record.rows, "virtualDesktops.rows"),
    navigationWrappingAround: requiredBoolean(record.navigationWrappingAround, "virtualDesktops.navigationWrappingAround"),
    desktops: record.desktops.map((value) => {
      const desktop = asRecord(value);
      if (!desktop) throw new DesktopAgentProtocolError("INVALID_VIRTUAL_DESKTOPS", "Virtual desktop must be an object.");
      return {
        position: requiredInteger(desktop.position, "virtualDesktop.position"),
        id: requiredString(desktop.id, "virtualDesktop.id"),
        name: requiredString(desktop.name, "virtualDesktop.name"),
        current: requiredBoolean(desktop.current, "virtualDesktop.current"),
      };
    }),
  };
}

export function decodeDesktopLogSources(value: unknown): DesktopLogSource[] {
  if (!Array.isArray(value)) {
    throw new DesktopAgentProtocolError("INVALID_LOGS", "Desktop agent returned an invalid log source list.");
  }
  return value.map(decodeDesktopLogSource);
}

export function decodeDesktopLogReadResult(value: unknown): DesktopLogReadResult {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.entries)) {
    throw new DesktopAgentProtocolError("INVALID_LOGS", "Desktop agent returned an invalid log read result.");
  }
  return {
    sourceId: requiredString(record.sourceId, "logs.sourceId"),
    generatedAt: requiredString(record.generatedAt, "logs.generatedAt"),
    query: optionalString(record.query),
    entries: record.entries.map(decodeDesktopLogEntry),
  };
}

export function decodeDesktopTraceCorrelation(value: unknown): DesktopTraceCorrelation {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.events)) {
    throw new DesktopAgentProtocolError("INVALID_TRACE", "Desktop agent returned an invalid trace correlation result.");
  }
  return {
    correlationId: requiredString(record.correlationId, "trace.correlationId"),
    generatedAt: requiredString(record.generatedAt, "trace.generatedAt"),
    events: record.events.map(decodeDesktopActivityEvent),
    logs: record.logs === undefined ? undefined : decodeDesktopLogReadResult(record.logs),
  };
}

export function decodeDesktopNotificationList(value: unknown): DesktopNotificationInfo[] {
  if (!Array.isArray(value)) {
    throw new DesktopAgentProtocolError("INVALID_NOTIFICATIONS", "Desktop agent returned an invalid notification list.");
  }
  return value.map(decodeDesktopNotificationInfo);
}

export function desktopAgentProtocolVersion(): number {
  return DESKTOP_AGENT_PROTOCOL_VERSION;
}

function decodeDesktopWindowInfo(value: unknown): DesktopWindowInfo {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_WINDOWS", "Desktop window must be an object.");
  return {
    id: requiredString(record.id, "window.id"),
    uuid: requiredString(record.uuid, "window.uuid"),
    title: typeof record.title === "string" ? record.title : "",
    pid: optionalInteger(record.pid),
    processName: optionalString(record.processName),
    executable: optionalString(record.executable),
    applicationId: optionalString(record.applicationId),
    desktopFile: optionalString(record.desktopFile),
    resourceClass: optionalString(record.resourceClass),
    resourceName: optionalString(record.resourceName),
    role: optionalString(record.role),
    clientMachine: optionalString(record.clientMachine),
    x: optionalNumber(record.x),
    y: optionalNumber(record.y),
    width: optionalNumber(record.width),
    height: optionalNumber(record.height),
    minimized: requiredBoolean(record.minimized, "window.minimized"),
    fullscreen: requiredBoolean(record.fullscreen, "window.fullscreen"),
    maximizedHorizontal: requiredBoolean(record.maximizedHorizontal, "window.maximizedHorizontal"),
    maximizedVertical: requiredBoolean(record.maximizedVertical, "window.maximizedVertical"),
    keepAbove: requiredBoolean(record.keepAbove, "window.keepAbove"),
    keepBelow: requiredBoolean(record.keepBelow, "window.keepBelow"),
    skipTaskbar: requiredBoolean(record.skipTaskbar, "window.skipTaskbar"),
    skipPager: requiredBoolean(record.skipPager, "window.skipPager"),
    skipSwitcher: requiredBoolean(record.skipSwitcher, "window.skipSwitcher"),
    noBorder: requiredBoolean(record.noBorder, "window.noBorder"),
    excludeFromCapture: requiredBoolean(record.excludeFromCapture, "window.excludeFromCapture"),
    desktops: stringArray(record.desktops, "window.desktops"),
    activities: stringArray(record.activities, "window.activities"),
  };
}

function decodeDesktopDisplayInfo(value: unknown): DesktopDisplayInfo {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_DISPLAYS", "Desktop display must be an object.");
  return {
    id: requiredInteger(record.id, "display.id"),
    name: requiredString(record.name, "display.name"),
    connected: requiredBoolean(record.connected, "display.connected"),
    enabled: requiredBoolean(record.enabled, "display.enabled"),
    active: requiredBoolean(record.active, "display.active"),
    primary: requiredBoolean(record.primary, "display.primary"),
    priority: requiredInteger(record.priority, "display.priority"),
    x: requiredNumber(record.x, "display.x"),
    y: requiredNumber(record.y, "display.y"),
    width: requiredNumber(record.width, "display.width"),
    height: requiredNumber(record.height, "display.height"),
    scale: requiredNumber(record.scale, "display.scale"),
    rotation: requiredInteger(record.rotation, "display.rotation"),
    brightness: optionalNumber(record.brightness),
    ddcCiAllowed: optionalBoolean(record.ddcCiAllowed),
    physicalWidthMm: optionalNumber(record.physicalWidthMm),
    physicalHeightMm: optionalNumber(record.physicalHeightMm),
    currentModeId: optionalString(record.currentModeId),
    currentMode: record.currentMode === undefined ? undefined : decodeDesktopDisplayMode(record.currentMode),
    preferredModeIds: stringArray(record.preferredModeIds, "display.preferredModeIds"),
    modes: displayModeArray(record.modes, "display.modes"),
    clones: integerArray(record.clones, "display.clones"),
    replicationSource: optionalInteger(record.replicationSource),
    connectorType: optionalInteger(record.connectorType),
  };
}

function decodeDesktopDisplayMode(value: unknown): DesktopDisplayMode {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_DISPLAYS", "Desktop display mode must be an object.");
  return {
    id: requiredString(record.id, "display.mode.id"),
    name: requiredString(record.name, "display.mode.name"),
    width: requiredNumber(record.width, "display.mode.width"),
    height: requiredNumber(record.height, "display.mode.height"),
    refreshRate: optionalNumber(record.refreshRate),
  };
}

function decodeDesktopProcessInfo(value: unknown): DesktopProcessInfo {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_PROCESSES", "Desktop process must be an object.");
  return {
    pid: requiredInteger(record.pid, "process.pid"),
    ppid: requiredInteger(record.ppid, "process.ppid"),
    uid: optionalInteger(record.uid),
    sameUser: optionalBoolean(record.sameUser),
    name: requiredString(record.name, "process.name"),
    state: requiredString(record.state, "process.state"),
    executable: optionalString(record.executable),
    threads: optionalInteger(record.threads),
    residentMemoryBytes: optionalInteger(record.residentMemoryBytes),
    virtualMemoryBytes: optionalInteger(record.virtualMemoryBytes),
    windowIds: stringArray(record.windowIds, "process.windowIds"),
    windowCount: requiredInteger(record.windowCount, "process.windowCount"),
    hasWindow: requiredBoolean(record.hasWindow, "process.hasWindow"),
  };
}

function decodeDesktopActivityEvent(value: unknown): DesktopActivityEvent {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_EVENTS", "Desktop activity event must be an object.");
  const type = requiredString(record.type, "event.type");
  if (!isDesktopActivityEventType(type)) {
    throw new DesktopAgentProtocolError("INVALID_EVENTS", `Invalid desktop activity event type: ${type}`);
  }
  const sourceModule = requiredString(record.sourceModule, "event.sourceModule");
  if (sourceModule !== "processes" && sourceModule !== "windows" && sourceModule !== "displays" && sourceModule !== "audio" && sourceModule !== "devices" && sourceModule !== "network" && sourceModule !== "notifications" && sourceModule !== "virtual-desktops") {
    throw new DesktopAgentProtocolError("INVALID_EVENTS", `Invalid desktop activity source: ${sourceModule}`);
  }
  return {
    sequence: requiredInteger(record.sequence, "event.sequence"),
    timestamp: requiredString(record.timestamp, "event.timestamp"),
    type,
    sourceModule,
    entityId: requiredString(record.entityId, "event.entityId"),
    correlationId: requiredString(record.correlationId, "event.correlationId"),
    applicationId: optionalString(record.applicationId),
    pid: optionalInteger(record.pid),
    title: typeof record.title === "string" ? record.title : undefined,
    summary: requiredString(record.summary, "event.summary"),
  };
}

function decodeDesktopAudioNode(value: unknown): DesktopAudioNode {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_AUDIO", "Desktop audio node must be an object.");
  return {
    id: requiredInteger(record.id, "audio.node.id"),
    name: requiredString(record.name, "audio.node.name"),
    mediaClass: requiredString(record.mediaClass, "audio.node.mediaClass"),
    state: optionalString(record.state),
    nick: optionalString(record.nick),
    description: optionalString(record.description),
    applicationName: optionalString(record.applicationName),
    applicationBinary: optionalString(record.applicationBinary),
    pid: optionalInteger(record.pid),
    clientId: optionalInteger(record.clientId),
    deviceId: optionalInteger(record.deviceId),
    mediaName: optionalString(record.mediaName),
    targetObject: optionalString(record.targetObject),
    sampleRate: optionalInteger(record.sampleRate),
    latency: optionalString(record.latency),
    isStream: requiredBoolean(record.isStream, "audio.node.isStream"),
    isSink: requiredBoolean(record.isSink, "audio.node.isSink"),
    isSource: requiredBoolean(record.isSource, "audio.node.isSource"),
  };
}

function decodeDesktopAudioPort(value: unknown): DesktopAudioPort {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_AUDIO", "Desktop audio port must be an object.");
  const direction = requiredString(record.direction, "audio.port.direction");
  if (direction !== "in" && direction !== "out") {
    throw new DesktopAgentProtocolError("INVALID_AUDIO", `Invalid audio port direction: ${direction}`);
  }
  return {
    id: requiredInteger(record.id, "audio.port.id"),
    nodeId: requiredInteger(record.nodeId, "audio.port.nodeId"),
    name: requiredString(record.name, "audio.port.name"),
    direction,
    alias: optionalString(record.alias),
    channel: optionalString(record.channel),
  };
}

function decodeDesktopAudioLink(value: unknown): DesktopAudioLink {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_AUDIO", "Desktop audio link must be an object.");
  return {
    id: requiredInteger(record.id, "audio.link.id"),
    state: requiredString(record.state, "audio.link.state"),
    outputNodeId: requiredInteger(record.outputNodeId, "audio.link.outputNodeId"),
    outputPortId: requiredInteger(record.outputPortId, "audio.link.outputPortId"),
    inputNodeId: requiredInteger(record.inputNodeId, "audio.link.inputNodeId"),
    inputPortId: requiredInteger(record.inputPortId, "audio.link.inputPortId"),
    outputNodeName: requiredString(record.outputNodeName, "audio.link.outputNodeName"),
    inputNodeName: requiredString(record.inputNodeName, "audio.link.inputNodeName"),
    outputPortName: optionalString(record.outputPortName),
    inputPortName: optionalString(record.inputPortName),
  };
}

function decodeDesktopDeviceInfo(value: unknown): DesktopDeviceInfo {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_DEVICES", "Desktop device must be an object.");
  const subsystem = requiredString(record.subsystem, "device.subsystem");
  if (subsystem !== "usb" && subsystem !== "pci" && subsystem !== "block" && subsystem !== "bluetooth") {
    throw new DesktopAgentProtocolError("INVALID_DEVICES", `Invalid device subsystem: ${subsystem}`);
  }
  return {
    id: requiredString(record.id, "device.id"),
    subsystem,
    category: requiredString(record.category, "device.category"),
    name: requiredString(record.name, "device.name"),
    vendor: optionalString(record.vendor),
    model: optionalString(record.model),
    vendorId: optionalString(record.vendorId),
    productId: optionalString(record.productId),
    classCode: optionalString(record.classCode),
    driver: optionalString(record.driver),
    path: optionalString(record.path),
    transport: optionalString(record.transport),
    speed: optionalString(record.speed),
    connected: requiredBoolean(record.connected, "device.connected"),
    hotplug: optionalBoolean(record.hotplug),
    removable: optionalBoolean(record.removable),
    paired: optionalBoolean(record.paired),
    sizeBytes: optionalInteger(record.sizeBytes),
    parentId: optionalString(record.parentId),
    mountpoints: stringArray(record.mountpoints, "device.mountpoints"),
  };
}

function decodeDesktopNetworkInterface(value: unknown): DesktopNetworkInterface {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_NETWORK", "Desktop network interface must be an object.");
  return {
    index: requiredInteger(record.index, "network.interface.index"),
    name: requiredString(record.name, "network.interface.name"),
    kind: requiredString(record.kind, "network.interface.kind"),
    linkType: optionalString(record.linkType),
    operState: requiredString(record.operState, "network.interface.operState"),
    mtu: optionalInteger(record.mtu),
    up: requiredBoolean(record.up, "network.interface.up"),
    lowerUp: requiredBoolean(record.lowerUp, "network.interface.lowerUp"),
    loopback: requiredBoolean(record.loopback, "network.interface.loopback"),
    addresses: Array.isArray(record.addresses)
      ? record.addresses.map(decodeDesktopNetworkAddress)
      : (() => { throw new DesktopAgentProtocolError("INVALID_NETWORK", "Invalid network.interface.addresses."); })(),
  };
}

function decodeDesktopNetworkAddress(value: unknown): DesktopNetworkAddress {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_NETWORK", "Desktop network address must be an object.");
  const family = requiredString(record.family, "network.address.family");
  if (family !== "ipv4" && family !== "ipv6") {
    throw new DesktopAgentProtocolError("INVALID_NETWORK", `Invalid network address family: ${family}`);
  }
  return {
    family,
    address: requiredString(record.address, "network.address.address"),
    prefixLength: requiredInteger(record.prefixLength, "network.address.prefixLength"),
    scope: optionalString(record.scope),
    dynamic: optionalBoolean(record.dynamic),
  };
}

function decodeDesktopNetworkRoute(value: unknown): DesktopNetworkRoute {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_NETWORK", "Desktop network route must be an object.");
  const family = requiredString(record.family, "network.route.family");
  if (family !== "ipv4" && family !== "ipv6") {
    throw new DesktopAgentProtocolError("INVALID_NETWORK", `Invalid network route family: ${family}`);
  }
  const table = typeof record.table === "string" || (typeof record.table === "number" && Number.isFinite(record.table))
    ? record.table
    : undefined;
  return {
    family,
    destination: requiredString(record.destination, "network.route.destination"),
    gateway: optionalString(record.gateway),
    interfaceName: optionalString(record.interfaceName),
    table,
    protocol: optionalString(record.protocol),
    scope: optionalString(record.scope),
    preferredSource: optionalString(record.preferredSource),
    metric: optionalInteger(record.metric),
    type: optionalString(record.type),
    linkDown: requiredBoolean(record.linkDown, "network.route.linkDown"),
  };
}

function decodeDesktopNetworkDnsServer(value: unknown): DesktopNetworkDnsServer {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_NETWORK", "Desktop DNS server must be an object.");
  return {
    interfaceName: optionalString(record.interfaceName),
    address: requiredString(record.address, "network.dns.address"),
  };
}

function decodeDesktopNetworkListener(value: unknown): DesktopNetworkListener {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_NETWORK", "Desktop network listener must be an object.");
  const protocol = requiredString(record.protocol, "network.listener.protocol");
  if (protocol !== "tcp" && protocol !== "udp") {
    throw new DesktopAgentProtocolError("INVALID_NETWORK", `Invalid listener protocol: ${protocol}`);
  }
  return {
    protocol,
    address: requiredString(record.address, "network.listener.address"),
    port: requiredInteger(record.port, "network.listener.port"),
    interfaceName: optionalString(record.interfaceName),
    processName: optionalString(record.processName),
    pid: optionalInteger(record.pid),
  };
}

function decodeDesktopLogSource(value: unknown): DesktopLogSource {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_LOGS", "Desktop log source must be an object.");
  const kind = requiredString(record.kind, "logs.source.kind");
  if (kind !== "journal") throw new DesktopAgentProtocolError("INVALID_LOGS", `Invalid log source kind: ${kind}`);
  return {
    id: requiredString(record.id, "logs.source.id"),
    kind,
    label: requiredString(record.label, "logs.source.label"),
    selector: requiredString(record.selector, "logs.source.selector"),
    lastSeen: optionalString(record.lastSeen),
    sampledEntries: requiredInteger(record.sampledEntries, "logs.source.sampledEntries"),
  };
}

function decodeDesktopLogEntry(value: unknown): DesktopLogEntry {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_LOGS", "Desktop log entry must be an object.");
  return {
    timestamp: requiredString(record.timestamp, "logs.entry.timestamp"),
    priority: optionalInteger(record.priority),
    unit: optionalString(record.unit),
    identifier: optionalString(record.identifier),
    processName: optionalString(record.processName),
    pid: optionalInteger(record.pid),
    message: requiredString(record.message, "logs.entry.message"),
  };
}

function decodeDesktopNotificationInfo(value: unknown): DesktopNotificationInfo {
  const record = asRecord(value);
  if (!record) throw new DesktopAgentProtocolError("INVALID_NOTIFICATIONS", "Desktop notification must be an object.");
  const actions = record.actions;
  if (!Array.isArray(actions)) {
    throw new DesktopAgentProtocolError("INVALID_NOTIFICATIONS", "Desktop notification actions must be an array.");
  }
  return {
    id: requiredString(record.id, "notification.id"),
    notificationId: optionalInteger(record.notificationId),
    replacesId: optionalInteger(record.replacesId),
    appName: requiredString(record.appName, "notification.appName"),
    summary: typeof record.summary === "string" ? record.summary : "",
    body: typeof record.body === "string" ? record.body : "",
    pid: optionalInteger(record.pid),
    desktopEntry: optionalString(record.desktopEntry),
    category: optionalString(record.category),
    urgency: optionalInteger(record.urgency),
    actions: actions.map((action) => {
      const actionRecord = asRecord(action);
      if (!actionRecord) throw new DesktopAgentProtocolError("INVALID_NOTIFICATIONS", "Desktop notification action must be an object.");
      return {
        id: requiredString(actionRecord.id, "notification.action.id"),
        label: requiredString(actionRecord.label, "notification.action.label"),
      };
    }),
    expireTimeoutMs: requiredInteger(record.expireTimeoutMs, "notification.expireTimeoutMs"),
    createdAt: requiredString(record.createdAt, "notification.createdAt"),
    closedAt: optionalString(record.closedAt),
    closeReason: optionalInteger(record.closeReason),
  };
}

function decodeCapabilityStatus(value: unknown): DesktopCapabilityStatus {
  const record = asRecord(value);
  const state = requiredString(record?.state, "capability.state");
  if (state !== "ready" && state !== "unavailable" && state !== "disabled" && state !== "not_implemented") {
    throw new DesktopAgentProtocolError("INVALID_STATUS", `Invalid desktop capability state: ${state}`);
  }
  return {
    id: requiredString(record?.id, "capability.id"),
    state,
    detail: optionalString(record?.detail),
  };
}

function isDesktopAgentMethod(value: string): value is DesktopAgentMethod {
  return value === "hello"
    || value === "desktop.status"
    || value === "desktop.capabilities"
    || value === "windows.list"
    || value === "displays.list"
    || value === "processes.list"
    || value === "events.recent"
    || value === "audio.graph"
    || value === "devices.list"
    || value === "network.snapshot"
    || value === "virtual-desktops.snapshot"
    || value === "logs.sources"
    || value === "logs.read"
    || value === "trace.correlate"
    || value === "notifications.recent"
    || value === "desktop.stop";
}

function isDesktopActivityEventType(value: string): value is DesktopActivityEventType {
  return value === "process.started"
    || value === "process.stopped"
    || value === "window.created"
    || value === "window.closed"
    || value === "window.changed"
    || value === "display.connected"
    || value === "display.disconnected"
    || value === "display.changed"
    || value === "audio.stream.started"
    || value === "audio.stream.stopped"
    || value === "audio.stream.changed"
    || value === "audio.route.created"
    || value === "audio.route.removed"
    || value === "audio.route.changed"
    || value === "device.connected"
    || value === "device.disconnected"
    || value === "device.changed"
    || value === "network.interface.changed"
    || value === "network.route.changed"
    || value === "network.dns.changed"
    || value === "network.listener.opened"
    || value === "network.listener.closed"
    || value === "network.tunnel.started"
    || value === "network.tunnel.stopped"
    || value === "notification.created"
    || value === "notification.closed"
    || value === "virtual-desktop.created"
    || value === "virtual-desktop.removed"
    || value === "virtual-desktop.changed"
    || value === "virtual-desktop.current.changed";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value);
  if (!result) throw new DesktopAgentProtocolError("INVALID_REQUEST", `Missing ${field}.`);
  return result;
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DesktopAgentProtocolError("INVALID_REQUEST", `Invalid ${field}.`);
  }
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new DesktopAgentProtocolError("INVALID_RESPONSE", `Invalid ${field}.`);
  }
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredNumber(value: unknown, field: string): number {
  const result = optionalNumber(value);
  if (result === undefined) {
    throw new DesktopAgentProtocolError("INVALID_RESPONSE", `Invalid ${field}.`);
  }
  return result;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DesktopAgentProtocolError("INVALID_RESPONSE", `Invalid ${field}.`);
  }
  return value as string[];
}

function integerArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isSafeInteger(item))) {
    throw new DesktopAgentProtocolError("INVALID_DISPLAYS", `Invalid ${field}.`);
  }
  return value as number[];
}

function displayModeArray(value: unknown, field: string): DesktopDisplayMode[] {
  if (!Array.isArray(value)) {
    throw new DesktopAgentProtocolError("INVALID_DISPLAYS", `Invalid ${field}.`);
  }
  return value.map(decodeDesktopDisplayMode);
}
