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

export type DesktopAgentMethod =
  | "hello"
  | "desktop.status"
  | "desktop.capabilities"
  | "desktop.stop";

export type DesktopAgentRequest = {
  requestId: string;
  protocolVersion: number;
  authToken: string;
  method: DesktopAgentMethod;
  params: Record<string, never>;
};

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
  if (!params || Object.keys(params).length !== 0) {
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

export function desktopAgentProtocolVersion(): number {
  return DESKTOP_AGENT_PROTOCOL_VERSION;
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
    || value === "desktop.stop";
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
