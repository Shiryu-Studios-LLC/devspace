import { createReadStream, existsSync, realpathSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type {
  DesktopShiryuGenGenerationTrace,
  DesktopShiryuGenTraceDetails,
  DesktopShiryuGenTraceStage,
} from "./desktop-agent-protocol.js";
import { isPathInsideRoot } from "./roots.js";

const MAX_TRACE_FILES = 6;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_LATEST_SEARCH_BYTES = 16 * 1024 * 1024;
const MAX_TRACE_ID_LENGTH = 256;
const GENERATION_TRACE_ATTRIBUTE = "shiryugen.generation.trace_id";
const GENERATION_ACTION_ATTRIBUTE = "shiryugen.generation.action";
const GENERATION_STAGE_ATTRIBUTE = "shiryugen.generation.stage";
const DETAIL_PREFIX = "shiryugen.detail.";
const TRACE_ID_PATTERN = /^shiryugen-(?:generate|regenerate|edit)-[A-Za-z0-9._:-]+$/;

const SAFE_DETAIL_KEYS = new Set<keyof DesktopShiryuGenTraceDetails>([
  "endpoint",
  "nodeCount",
  "promptId",
  "pollAttempt",
  "state",
  "outputPath",
  "seed",
  "width",
  "height",
  "steps",
  "guidance",
  "engine",
  "checkpoint",
  "attachmentId",
  "durablePath",
  "generatorOutputPath",
  "sizeBytes",
  "reason",
  "missingNodes",
  "character",
  "sceneMode",
  "modelProfile",
  "policyVersion",
  "formatterModel",
  "formatterFallback",
  "promptSource",
]);

interface TraceRecord {
  name?: unknown;
  startTimeUnixNano?: unknown;
  endTimeUnixNano?: unknown;
  durationMs?: unknown;
  attributes?: unknown;
  exit?: unknown;
}

interface SearchStats {
  recordsScanned: number;
  bytesScanned: number;
}

export interface ShiryuGenTraceProviderOptions {
  allowedRoots: string[];
  basePaths?: string[];
  maxFiles?: number;
  maxTotalBytes?: number;
}

export type ShiryuGenTraceProvider = (
  traceId?: string,
) => Promise<DesktopShiryuGenGenerationTrace>;

export function defaultShiryuGenTraceBasePaths(home = homedir()): string[] {
  return [
    join(home, ".t3", "userdata", "logs", "server.trace.ndjson"),
    join(home, ".t3", "dev", "logs", "server.trace.ndjson"),
  ];
}

export function shiryuGenTraceAvailable(
  allowedRoots: string[],
  basePaths = defaultShiryuGenTraceBasePaths(),
): boolean {
  return basePaths.some((basePath) => {
    try {
      if (!existsSync(basePath) || !statSync(basePath).isFile()) return false;
      return realPathAllowed(basePath, allowedRoots);
    } catch {
      return false;
    }
  });
}

export function createShiryuGenTraceProvider(
  options: ShiryuGenTraceProviderOptions,
): ShiryuGenTraceProvider {
  const maxFiles = boundedInteger(options.maxFiles ?? MAX_TRACE_FILES, 1, 32, "ShiryuGen trace maxFiles");
  const maxTotalBytes = boundedInteger(
    options.maxTotalBytes ?? MAX_TOTAL_BYTES,
    1024,
    512 * 1024 * 1024,
    "ShiryuGen trace maxTotalBytes",
  );
  const configuredBasePaths = options.basePaths ?? defaultShiryuGenTraceBasePaths();

  return async (requestedTraceId) => {
    const traceId = requestedTraceId === undefined ? undefined : validateTraceId(requestedTraceId);
    const basePaths = configuredBasePaths.filter((path) => {
      try {
        return existsSync(path) && statSync(path).isFile() && realPathAllowed(path, options.allowedRoots);
      } catch {
        return false;
      }
    });

    if (basePaths.length === 0) {
      return emptyTrace(traceId, []);
    }

    const sourceFiles = basePaths.flatMap((basePath) => rotatedTraceFiles(basePath, maxFiles, options.allowedRoots));
    if (traceId) {
      return readTraceById(traceId, sourceFiles, maxTotalBytes);
    }

    const latest = await findLatestTraceId(sourceFiles, maxTotalBytes);
    if (!latest.traceId) {
      return {
        ...emptyTrace(undefined, latest.sourceFiles),
        recordsScanned: latest.stats.recordsScanned,
        bytesScanned: latest.stats.bytesScanned,
      };
    }
    return readTraceById(latest.traceId, sourceFiles, maxTotalBytes);
  };
}

async function findLatestTraceId(
  sourceFiles: string[],
  maxTotalBytes: number,
): Promise<{
  traceId?: string;
  sourceFiles: string[];
  stats: SearchStats;
}> {
  let latestTraceId: string | undefined;
  let latestStartNs: bigint | undefined;
  let bytesScanned = 0;
  let recordsScanned = 0;
  const scannedFiles: string[] = [];
  const searchBudget = Math.min(maxTotalBytes, MAX_LATEST_SEARCH_BYTES);

  for (const file of sourceFiles) {
    if (bytesScanned >= searchBudget) break;
    scannedFiles.push(file);
    const size = statSync(file).size;
    const bytesToRead = Math.min(size, searchBudget - bytesScanned);
    if (bytesToRead <= 0) continue;
    const position = size - bytesToRead;
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
      bytesScanned += bytesRead;
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (position > 0) {
        const newline = text.indexOf("\n");
        text = newline === -1 ? "" : text.slice(newline + 1);
      }
      const lines = text.split("\n").filter((line) => line.length > 0);
      recordsScanned += lines.length;
      for (const line of lines) {
        if (!line.includes(GENERATION_TRACE_ATTRIBUTE)) continue;
        const record = parseTraceRecord(line);
        const attributes = asRecord(record?.attributes);
        const candidate = stringValue(attributes?.[GENERATION_TRACE_ATTRIBUTE]);
        if (!candidate || !validTraceId(candidate)) continue;
        const startNs = bigintValue(record?.startTimeUnixNano);
        if (startNs !== undefined && (latestStartNs === undefined || startNs > latestStartNs)) {
          latestStartNs = startNs;
          latestTraceId = candidate;
        }
      }
    } finally {
      await handle.close();
    }
    if (latestTraceId) break;
  }

  return {
    traceId: latestTraceId,
    sourceFiles: scannedFiles,
    stats: { recordsScanned, bytesScanned },
  };
}

async function readTraceById(
  traceId: string,
  sourceFiles: string[],
  maxTotalBytes: number,
): Promise<DesktopShiryuGenGenerationTrace> {
  const stages: DesktopShiryuGenTraceStage[] = [];
  let bytesScanned = 0;
  let recordsScanned = 0;
  const matchedFiles: string[] = [];
  let sawRequest = false;
  let sawTerminal = false;

  for (const file of sourceFiles) {
    if (bytesScanned >= maxTotalBytes) break;
    let matchedThisFile = false;
    const input = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      bytesScanned += bytes;
      recordsScanned += 1;
      if (bytesScanned > maxTotalBytes) {
        input.destroy();
        break;
      }
      if (!line.includes(traceId) || !line.includes(GENERATION_TRACE_ATTRIBUTE)) continue;
      const record = parseTraceRecord(line);
      const stage = normalizeGenerationStage(record, traceId, file);
      if (!stage) continue;
      matchedThisFile = true;
      stages.push(stage);
      if (stage.stage === "request.received") sawRequest = true;
      if (isTerminalStage(stage.stage)) sawTerminal = true;
    }
    if (matchedThisFile) matchedFiles.push(file);
    if (sawRequest && sawTerminal) break;
  }

  stages.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.stage.localeCompare(b.stage));
  if (stages.length === 0) {
    return {
      ...emptyTrace(traceId, matchedFiles.length ? matchedFiles : sourceFiles.slice(0, 1)),
      recordsScanned,
      bytesScanned,
    };
  }

  const action = stages.find((stage) => stage.action)?.action;
  const failed = stages.some((stage) => isFailureStage(stage.stage));
  const completed = stages.some((stage) => stage.stage === "attachment.persisted");
  const relatedPaths = uniqueStrings(
    stages.flatMap((stage) => [
      stage.details.outputPath,
      stage.details.durablePath,
      stage.details.generatorOutputPath,
    ]),
  );
  const promptId = stages.map((stage) => stage.details.promptId).find((value): value is string => Boolean(value));
  const outputPath = stages.map((stage) => stage.details.outputPath).find((value): value is string => Boolean(value));
  const durablePath = stages.map((stage) => stage.details.durablePath).find((value): value is string => Boolean(value));
  const attachmentId = stages.map((stage) => stage.details.attachmentId).find((value): value is string => Boolean(value));
  const startedAt = stages[0]?.startedAt;
  const endedAt = completed || failed ? stages.at(-1)?.endedAt : undefined;
  const durationMs = startedAt && endedAt
    ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
    : undefined;

  return {
    traceId,
    found: true,
    ...(action ? { action } : {}),
    state: failed ? "failed" : completed ? "completed" : "in-progress",
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(promptId ? { promptId } : {}),
    ...(outputPath ? { outputPath } : {}),
    ...(durablePath ? { durablePath } : {}),
    ...(attachmentId ? { attachmentId } : {}),
    relatedPaths,
    stages,
    filesystemEvents: [],
    sourceFiles: matchedFiles,
    recordsScanned,
    bytesScanned,
  };
}

function normalizeGenerationStage(
  record: TraceRecord | undefined,
  traceId: string,
  sourceFile: string,
): DesktopShiryuGenTraceStage | undefined {
  if (!record) return undefined;
  const attributes = asRecord(record.attributes);
  if (stringValue(attributes?.[GENERATION_TRACE_ATTRIBUTE]) !== traceId) return undefined;
  const stage = stringValue(attributes?.[GENERATION_STAGE_ATTRIBUTE]);
  if (!stage) return undefined;
  const action = generationAction(attributes?.[GENERATION_ACTION_ATTRIBUTE]);
  const startedAt = nanoTimeToIso(record.startTimeUnixNano);
  const endedAt = nanoTimeToIso(record.endTimeUnixNano) ?? startedAt;
  if (!startedAt || !endedAt) return undefined;

  return {
    stage,
    spanName: stringValue(record.name) ?? `shiryugen.generation.${stage}`,
    ...(action ? { action } : {}),
    startedAt,
    endedAt,
    durationMs: numberValue(record.durationMs) ?? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    outcome: isFailureStage(stage) ? "error" : "ok",
    details: safeDetails(attributes),
    sourceFile,
  };
}

function safeDetails(attributes: Record<string, unknown> | undefined): DesktopShiryuGenTraceDetails {
  if (!attributes) return {};
  const result: DesktopShiryuGenTraceDetails = {};
  for (const [key, raw] of Object.entries(attributes)) {
    if (!key.startsWith(DETAIL_PREFIX)) continue;
    const detailKey = key.slice(DETAIL_PREFIX.length) as keyof DesktopShiryuGenTraceDetails;
    if (!SAFE_DETAIL_KEYS.has(detailKey)) continue;
    assignSafeDetail(result, detailKey, raw);
  }
  return result;
}

function assignSafeDetail(
  result: DesktopShiryuGenTraceDetails,
  key: keyof DesktopShiryuGenTraceDetails,
  raw: unknown,
): void {
  if (key === "missingNodes") {
    const values = stringArrayValue(raw);
    if (values) result.missingNodes = values.slice(0, 64);
    return;
  }
  if (key === "formatterFallback") {
    if (typeof raw === "boolean") result.formatterFallback = raw;
    return;
  }
  if (["nodeCount", "pollAttempt", "seed", "width", "height", "steps", "guidance", "sizeBytes"].includes(key)) {
    const value = numberValue(raw);
    if (value === undefined) return;
    switch (key) {
      case "nodeCount": result.nodeCount = value; break;
      case "pollAttempt": result.pollAttempt = value; break;
      case "seed": result.seed = value; break;
      case "width": result.width = value; break;
      case "height": result.height = value; break;
      case "steps": result.steps = value; break;
      case "guidance": result.guidance = value; break;
      case "sizeBytes": result.sizeBytes = value; break;
    }
    return;
  }
  const value = stringValue(raw);
  if (!value) return;
  switch (key) {
    case "endpoint": result.endpoint = value; break;
    case "promptId": result.promptId = value; break;
    case "state": result.state = value; break;
    case "outputPath": result.outputPath = value; break;
    case "engine": result.engine = value; break;
    case "checkpoint": result.checkpoint = value; break;
    case "attachmentId": result.attachmentId = value; break;
    case "durablePath": result.durablePath = value; break;
    case "generatorOutputPath": result.generatorOutputPath = value; break;
    case "reason": result.reason = value; break;
    case "character": result.character = value; break;
    case "sceneMode": result.sceneMode = value; break;
    case "modelProfile": result.modelProfile = value; break;
    case "policyVersion": result.policyVersion = value; break;
    case "formatterModel": result.formatterModel = value; break;
    case "promptSource": result.promptSource = value; break;
  }
}

function rotatedTraceFiles(basePath: string, maxFiles: number, allowedRoots: string[]): string[] {
  const directory = dirname(basePath);
  const base = basename(basePath);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const candidates = entries
    .map((entry) => {
      if (entry === base) return { suffix: 0, path: join(directory, entry) };
      if (!entry.startsWith(`${base}.`)) return undefined;
      const suffix = Number(entry.slice(base.length + 1));
      return Number.isSafeInteger(suffix) && suffix > 0 ? { suffix, path: join(directory, entry) } : undefined;
    })
    .filter((entry): entry is { suffix: number; path: string } => Boolean(entry))
    .filter((entry) => {
      try {
        return statSync(entry.path).isFile() && realPathAllowed(entry.path, allowedRoots);
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.suffix - b.suffix)
    .slice(0, maxFiles)
    .map((entry) => entry.path);
  return candidates;
}

function realPathAllowed(path: string, allowedRoots: string[]): boolean {
  const candidate = realpathSync(path);
  return allowedRoots.some((root) => {
    try {
      const canonicalRoot = realpathSync(resolve(root));
      return isPathInsideRoot(candidate, canonicalRoot);
    } catch {
      return false;
    }
  });
}

function emptyTrace(traceId: string | undefined, sourceFiles: string[]): DesktopShiryuGenGenerationTrace {
  return {
    ...(traceId ? { traceId } : {}),
    found: false,
    state: "not-found",
    relatedPaths: [],
    stages: [],
    filesystemEvents: [],
    sourceFiles,
    recordsScanned: 0,
    bytesScanned: 0,
  };
}

function parseTraceRecord(line: string): TraceRecord | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as TraceRecord : undefined;
  } catch {
    return undefined;
  }
}

function validateTraceId(value: string): string {
  const traceId = value.trim();
  if (!validTraceId(traceId)) {
    throw new Error("ShiryuGen traceId must be a shiryugen-generate/regenerate/edit trace identifier.");
  }
  return traceId;
}

function validTraceId(value: string): boolean {
  return value.length <= MAX_TRACE_ID_LENGTH && TRACE_ID_PATTERN.test(value);
}

function generationAction(value: unknown): "generate" | "regenerate" | "edit" | undefined {
  return value === "generate" || value === "regenerate" || value === "edit" ? value : undefined;
}

function isFailureStage(stage: string): boolean {
  return stage.endsWith(".failed")
    || stage.endsWith("-failed")
    || stage.endsWith(".timeout")
    || stage === "renderer.failed"
    || stage === "reference.failed";
}

function isTerminalStage(stage: string): boolean {
  return stage === "attachment.persisted" || isFailureStage(stage);
}

function nanoTimeToIso(value: unknown): string | undefined {
  const nano = bigintValue(value);
  if (nano === undefined) return undefined;
  const milliseconds = Number(nano / 1_000_000n);
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function bigintValue(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
