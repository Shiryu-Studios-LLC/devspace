import type { DesktopBrowserSessionSnapshot, DesktopBrowserTab } from "./desktop-agent-protocol.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TABS = 256;
const DEFAULT_TIMEOUT_MS = 1_500;
const MAX_TITLE_LENGTH = 512;
const MAX_URL_LENGTH = 4096;

export interface BrowserSessionProviderOptions {
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export type BrowserSessionProvider = () => Promise<DesktopBrowserSessionSnapshot>;

export function browserSessionConfigured(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  try {
    normalizeLoopbackEndpoint(endpoint);
    return true;
  } catch {
    return false;
  }
}

export function createBrowserSessionProvider(
  options: BrowserSessionProviderOptions = {},
): BrowserSessionProvider {
  const endpoint = options.endpoint;
  const timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100, 10_000, "Browser session timeout");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  return async () => {
    const base = normalizeLoopbackEndpoint(endpoint);
    const [version, targets] = await Promise.all([
      fetchBoundedJson(new URL("/json/version", base), fetchImpl, timeoutMs),
      fetchBoundedJson(new URL("/json/list", base), fetchImpl, timeoutMs),
    ]);
    if (!Array.isArray(targets)) {
      throw new Error("Browser CDP /json/list response must be an array.");
    }

    const browser = isRecord(version) && typeof version.Browser === "string"
      ? truncate(version.Browser, 256)
      : undefined;
    const tabs = targets
      .filter((target) => isRecord(target) && target.type === "page")
      .slice(0, MAX_TABS)
      .flatMap((target) => decodeTarget(target));

    return {
      ...(browser ? { browser } : {}),
      tabs,
      capturedAt: now().toISOString(),
    };
  };
}

export function normalizeLoopbackEndpoint(endpoint: string | undefined): URL {
  if (!endpoint?.trim()) {
    throw new Error("Browser session integration requires an explicitly configured local CDP endpoint.");
  }
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new Error("Browser CDP endpoint must be a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser CDP endpoint must use http or https.");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "[::1]") {
    throw new Error("Browser CDP endpoint must resolve to the local loopback interface.");
  }
  if (url.username || url.password) {
    throw new Error("Browser CDP endpoint must not include credentials.");
  }
  url.search = "";
  url.hash = "";
  return url;
}

async function fetchBoundedJson(
  url: URL,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Browser CDP endpoint returned HTTP ${response.status}.`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("Browser CDP response exceeds the 1 MiB limit.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Browser CDP response exceeds the 1 MiB limit.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Browser CDP endpoint returned invalid JSON.");
  }
}

function decodeTarget(value: unknown): DesktopBrowserTab[] {
  if (!isRecord(value)) return [];
  const id = stringField(value.id);
  const type = stringField(value.type);
  if (!id || !type) return [];
  const title = sanitizeBrowserTitle(stringField(value.title) ?? "");
  const url = sanitizeBrowserUrl(stringField(value.url) ?? "");
  return [{ id: truncate(id, 256), type: truncate(type, 64), title, url }];
}

function sanitizeBrowserTitle(raw: string): string {
  const sanitized = raw
    .split(/(\s+)/)
    .map((part) => /^(?:https?|file|chrome-extension):\/\//i.test(part) ? sanitizeBrowserUrl(part) : part)
    .join("");
  return truncate(sanitized, MAX_TITLE_LENGTH);
}

function sanitizeBrowserUrl(raw: string): string {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return truncate(url.toString(), MAX_URL_LENGTH);
    }
    if (url.protocol === "file:") return "file://[local-file]";
    if (url.protocol === "about:" || url.protocol === "chrome:" || url.protocol === "opera:" || url.protocol === "edge:") {
      url.search = "";
      url.hash = "";
      return truncate(url.toString(), MAX_URL_LENGTH);
    }
    return truncate(`${url.protocol}//[redacted]`, MAX_URL_LENGTH);
  } catch {
    return "[invalid-url]";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
