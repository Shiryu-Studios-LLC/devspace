import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type {
  DesktopLogEntry,
  DesktopLogReadResult,
  DesktopLogSource,
} from "./desktop-agent-protocol.js";

const execFileAsync = promisify(execFile);
const JOURNALCTL = "/usr/bin/journalctl";
const MAX_BUFFER = 8 * 1024 * 1024;
const INVENTORY_SAMPLE_LINES = 2_000;
const DEFAULT_READ_LINES = 100;
const MAX_READ_LINES = 500;

type JournalSelectorField = "_SYSTEMD_USER_UNIT" | "SYSLOG_IDENTIFIER" | "_COMM";

interface JournalRecord {
  __REALTIME_TIMESTAMP?: unknown;
  _SYSTEMD_USER_UNIT?: unknown;
  SYSLOG_IDENTIFIER?: unknown;
  _COMM?: unknown;
  _PID?: unknown;
  PRIORITY?: unknown;
  MESSAGE?: unknown;
}

interface SourceAccumulator {
  source: DesktopLogSource;
  count: number;
}

export function linuxLogAwarenessAvailable(): boolean {
  return process.platform === "linux" && existsSync(JOURNALCTL);
}

export async function listLinuxLogSources(): Promise<DesktopLogSource[]> {
  if (!linuxLogAwarenessAvailable()) return [];
  const records = await readJournalRecords(["--user", "-n", String(INVENTORY_SAMPLE_LINES), "-o", "json", "--no-pager"]);
  const sources = new Map<string, SourceAccumulator>();

  for (const record of records) {
    const selector = preferredSelector(record);
    if (!selector) continue;
    const id = encodeSourceId(selector.field, selector.value);
    const timestamp = journalTimestamp(record.__REALTIME_TIMESTAMP);
    const existing = sources.get(id);
    if (existing) {
      existing.count += 1;
      if (timestamp && (!existing.source.lastSeen || timestamp > existing.source.lastSeen)) {
        existing.source.lastSeen = timestamp;
      }
      continue;
    }
    sources.set(id, {
      count: 1,
      source: {
        id,
        kind: "journal",
        label: selector.value,
        selector: `${selector.field}=${selector.value}`,
        lastSeen: timestamp,
        sampledEntries: 1,
      },
    });
  }

  return [...sources.values()]
    .map(({ source, count }) => ({ ...source, sampledEntries: count }))
    .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "") || a.label.localeCompare(b.label));
}

export async function readLinuxLogs(
  sourceId: string,
  options: { lines?: number; query?: string } = {},
): Promise<DesktopLogReadResult> {
  if (!linuxLogAwarenessAvailable()) throw new Error("Linux journal awareness is unavailable.");
  const selector = decodeSourceId(sourceId);
  const lines = normalizeLineCount(options.lines);
  const query = normalizeQuery(options.query);
  const args = [
    "--user",
    "-n",
    String(lines),
    "-o",
    "json",
    "--no-pager",
    `${selector.field}=${selector.value}`,
  ];
  const records = await readJournalRecords(args);
  const entries = records
    .map(normalizeJournalEntry)
    .filter((entry): entry is DesktopLogEntry => entry !== undefined)
    .filter((entry) => !query || entry.message.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  return {
    sourceId,
    generatedAt: new Date().toISOString(),
    query,
    entries,
  };
}

function preferredSelector(record: JournalRecord): { field: JournalSelectorField; value: string } | undefined {
  const unit = stringValue(record._SYSTEMD_USER_UNIT);
  if (unit) return { field: "_SYSTEMD_USER_UNIT", value: unit };
  const identifier = stringValue(record.SYSLOG_IDENTIFIER);
  if (identifier) return { field: "SYSLOG_IDENTIFIER", value: identifier };
  const comm = stringValue(record._COMM);
  if (comm) return { field: "_COMM", value: comm };
  return undefined;
}

function normalizeJournalEntry(record: JournalRecord): DesktopLogEntry | undefined {
  const message = stringValue(record.MESSAGE);
  if (!message) return undefined;
  return {
    timestamp: journalTimestamp(record.__REALTIME_TIMESTAMP) ?? new Date(0).toISOString(),
    priority: integerValue(record.PRIORITY),
    unit: stringValue(record._SYSTEMD_USER_UNIT),
    identifier: stringValue(record.SYSLOG_IDENTIFIER),
    processName: stringValue(record._COMM),
    pid: integerValue(record._PID),
    message,
  };
}

async function readJournalRecords(args: string[]): Promise<JournalRecord[]> {
  const { stdout } = await execFileAsync(JOURNALCTL, args, {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    timeout: 10_000,
    env: process.env,
  });
  const records: JournalRecord[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed as JournalRecord);
    } catch {
      // Ignore individual malformed journal records; one bad entry should not
      // make the whole source unavailable.
    }
  }
  return records;
}

function encodeSourceId(field: JournalSelectorField, value: string): string {
  return `journal:${field}:${Buffer.from(value, "utf8").toString("base64url")}`;
}

function decodeSourceId(sourceId: string): { field: JournalSelectorField; value: string } {
  const match = /^journal:(_SYSTEMD_USER_UNIT|SYSLOG_IDENTIFIER|_COMM):([A-Za-z0-9_-]+)$/.exec(sourceId);
  if (!match) throw new Error("Unknown or invalid log source ID.");
  const field = match[1] as JournalSelectorField;
  let value: string;
  try {
    value = Buffer.from(match[2]!, "base64url").toString("utf8");
  } catch {
    throw new Error("Unknown or invalid log source ID.");
  }
  if (!value || value.includes("\0") || value.length > 512) throw new Error("Unknown or invalid log source ID.");
  return { field, value };
}

function normalizeLineCount(value: number | undefined): number {
  if (value === undefined) return DEFAULT_READ_LINES;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Log line count must be a positive integer.");
  return Math.min(value, MAX_READ_LINES);
}

function normalizeQuery(value: string | undefined): string | undefined {
  const query = value?.trim();
  if (!query) return undefined;
  if (query.length > 256) throw new Error("Log search query is too long.");
  return query;
}

function journalTimestamp(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const micros = Number(raw);
  if (!Number.isSafeInteger(micros)) return undefined;
  return new Date(Math.floor(micros / 1000)).toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}
