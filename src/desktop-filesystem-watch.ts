import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";
import type { DesktopFilesystemWatchInfo } from "./desktop-agent-protocol.js";

const DEFAULT_MAX_WATCHES = 32;
const EVENT_DEBOUNCE_MS = 75;
const CREATE_CHANGE_COALESCE_MS = 250;

export type DesktopFilesystemChangeType = "created" | "changed" | "deleted";

export interface DesktopFilesystemChange {
  watchId: string;
  type: DesktopFilesystemChangeType;
  path: string;
  occurredAt: string;
}

export interface DesktopFilesystemWatchManager {
  start(path: string, recursive?: boolean): DesktopFilesystemWatchInfo;
  stop(id: string): DesktopFilesystemWatchInfo;
  list(): DesktopFilesystemWatchInfo[];
  close(): void;
}

type WatchFactory = (
  path: string,
  options: { recursive: boolean; persistent: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => FSWatcher;

interface WatchRecord {
  info: DesktopFilesystemWatchInfo;
  watcher: FSWatcher;
  rootIsDirectory: boolean;
  recentEvents: Map<string, number>;
}

export class LinuxFilesystemWatchManager implements DesktopFilesystemWatchManager {
  private readonly allowedRoots: string[];
  private readonly onEvent: (event: DesktopFilesystemChange) => void;
  private readonly now: () => number;
  private readonly watchFactory: WatchFactory;
  private readonly maxWatches: number;
  private readonly records = new Map<string, WatchRecord>();

  constructor(options: {
    allowedRoots: string[];
    onEvent: (event: DesktopFilesystemChange) => void;
    now?: () => number;
    watchFactory?: WatchFactory;
    maxWatches?: number;
  }) {
    this.allowedRoots = [...new Set([
      ...options.allowedRoots,
      ...options.allowedRoots.flatMap((root) => {
        try { return [realpathSync(root)]; } catch { return []; }
      }),
    ])];
    this.onEvent = options.onEvent;
    this.now = options.now ?? Date.now;
    this.watchFactory = options.watchFactory ?? ((path, watchOptions, listener) => watch(path, watchOptions, listener));
    this.maxWatches = options.maxWatches ?? DEFAULT_MAX_WATCHES;
    if (!Number.isSafeInteger(this.maxWatches) || this.maxWatches < 1 || this.maxWatches > 256) {
      throw new Error("Filesystem watch max count must be between 1 and 256.");
    }
  }

  start(inputPath: string, recursive = false): DesktopFilesystemWatchInfo {
    if (this.records.size >= this.maxWatches) {
      throw new Error(`Filesystem watch limit reached (${this.maxWatches}).`);
    }
    const path = assertAllowedPath(inputPath, this.allowedRoots);
    const realPath = realpathSync(path);
    assertAllowedPath(realPath, this.allowedRoots);
    const stat = lstatSync(path);
    if (recursive && !stat.isDirectory()) {
      throw new Error("Recursive filesystem watches require a directory path.");
    }
    const duplicate = [...this.records.values()].find((record) => record.info.path === path && record.info.recursive === recursive);
    if (duplicate) return cloneInfo(duplicate.info);

    const id = `fswatch:${randomUUID()}`;
    const info: DesktopFilesystemWatchInfo = {
      id,
      path,
      recursive,
      startedAt: new Date(this.now()).toISOString(),
      eventCount: 0,
      state: "ready",
    };
    const watcher = this.watchFactory(path, { recursive, persistent: false }, (eventType, filename) => {
      this.handleEvent(id, eventType, filename);
    });
    const record: WatchRecord = { info, watcher, rootIsDirectory: stat.isDirectory(), recentEvents: new Map() };
    this.records.set(id, record);
    watcher.on("error", (error) => {
      const current = this.records.get(id);
      if (!current) return;
      current.info.state = "failed";
      current.info.error = error instanceof Error ? error.message : String(error);
    });
    return cloneInfo(info);
  }

  stop(id: string): DesktopFilesystemWatchInfo {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown filesystem watch: ${id}`);
    this.records.delete(id);
    record.watcher.close();
    return cloneInfo(record.info);
  }

  list(): DesktopFilesystemWatchInfo[] {
    return [...this.records.values()].map((record) => cloneInfo(record.info));
  }

  close(): void {
    for (const record of this.records.values()) record.watcher.close();
    this.records.clear();
  }

  private handleEvent(id: string, eventType: string, filename: string | Buffer | null): void {
    const record = this.records.get(id);
    if (!record || record.info.state !== "ready") return;
    const name = filename === null ? "" : filename.toString();
    const candidate = record.rootIsDirectory && name ? resolve(record.info.path, name) : record.info.path;
    if (!isPathInsideRoot(candidate, record.info.path) && candidate !== record.info.path) return;
    let type: DesktopFilesystemChangeType;
    if (eventType === "change") {
      type = "changed";
    } else if (eventType === "rename") {
      try {
        lstatSync(candidate);
        type = "created";
      } catch {
        type = "deleted";
      }
    } else {
      return;
    }

    const now = this.now();
    const eventKey = `${type}:${candidate}`;
    const lastAt = record.recentEvents.get(eventKey);
    if (lastAt !== undefined && now - lastAt < EVENT_DEBOUNCE_MS) return;
    if (type === "changed") {
      const createdAt = record.recentEvents.get(`created:${candidate}`);
      if (createdAt !== undefined && now - createdAt < CREATE_CHANGE_COALESCE_MS) return;
    }
    record.recentEvents.set(eventKey, now);
    for (const [key, timestamp] of record.recentEvents) {
      if (now - timestamp > 5_000) record.recentEvents.delete(key);
    }

    const occurredAt = new Date(now).toISOString();
    record.info.eventCount += 1;
    record.info.lastEventAt = occurredAt;
    this.onEvent({ watchId: id, type, path: candidate, occurredAt });
  }
}

export function linuxFilesystemWatchAvailable(allowedRoots: string[]): boolean {
  return process.platform === "linux" && allowedRoots.length > 0;
}

function cloneInfo(info: DesktopFilesystemWatchInfo): DesktopFilesystemWatchInfo {
  return { ...info };
}
