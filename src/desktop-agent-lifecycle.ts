import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const DESKTOP_AGENT_PROTOCOL_VERSION = 1;
const SOCKET_NAME = "desktop-agent.sock";
const PID_NAME = "desktop-agent.pid";
const LOCK_NAME = "desktop-agent.lock";
const SECRET_NAME = "desktop-agent.secret";
const LOG_NAME = "desktop-agent.log";

export interface DesktopAgentPaths {
  stateDir: string;
  socketPath: string;
  pidPath: string;
  lockPath: string;
  secretPath: string;
  logPath: string;
  endpoint: string;
}

export function desktopAgentPaths(
  devspaceStateDir: string,
  platform: NodeJS.Platform = process.platform,
): DesktopAgentPaths {
  const stateDir = resolve(join(devspaceStateDir, "desktop-agent"));
  const socketPath = join(stateDir, SOCKET_NAME);
  return {
    stateDir,
    socketPath,
    pidPath: join(stateDir, PID_NAME),
    lockPath: join(stateDir, LOCK_NAME),
    secretPath: join(stateDir, SECRET_NAME),
    logPath: join(stateDir, LOG_NAME),
    endpoint: platform === "win32"
      ? `\\\\.\\pipe\\devspace-desktop-agent-${hashStateDir(stateDir)}`
      : socketPath,
  };
}

export function ensureDesktopAgentStateDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(stateDir, 0o700);
}

export class DesktopAgentAlreadyRunningError extends Error {
  readonly code = "DESKTOP_AGENT_ALREADY_RUNNING" as const;

  constructor(readonly pid?: number) {
    super(pid ? `Desktop agent is already running (pid ${pid}).` : "Desktop agent is already running.");
    this.name = "DesktopAgentAlreadyRunningError";
  }
}

export class DesktopAgentLock {
  private acquired = false;

  constructor(readonly paths: DesktopAgentPaths) {}

  acquire(): void {
    ensureDesktopAgentStateDir(this.paths.stateDir);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const temporaryPath = `${this.paths.lockPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      let published = false;
      try {
        writeFileSecure(temporaryPath, `${process.pid}\n`);
        linkSync(temporaryPath, this.paths.lockPath);
        published = true;
        rmSync(temporaryPath, { force: true });
        if (process.platform !== "win32") chmodSync(this.paths.lockPath, 0o600);
        writeFileSecure(this.paths.pidPath, `${process.pid}\n`);
        this.acquired = true;
        return;
      } catch (error) {
        rmSync(temporaryPath, { force: true });
        if (published && readDesktopAgentPid(this.paths.lockPath) === process.pid) {
          rmSync(this.paths.lockPath, { force: true });
        }
        if (!isFileExistsError(error)) throw error;
        const pid = readDesktopAgentPid(this.paths.lockPath);
        if (pid !== undefined && isProcessAlive(pid)) {
          throw new DesktopAgentAlreadyRunningError(pid);
        }
        if (pid === undefined) throw new DesktopAgentAlreadyRunningError();
        if (!removeStaleLock(this.paths.lockPath)) continue;
      }
    }
    throw new DesktopAgentAlreadyRunningError(readDesktopAgentPid(this.paths.lockPath));
  }

  release(): void {
    if (!this.acquired) return;
    this.acquired = false;
    if (readDesktopAgentPid(this.paths.pidPath) === process.pid) rmSync(this.paths.pidPath, { force: true });
    if (readDesktopAgentPid(this.paths.lockPath) === process.pid) rmSync(this.paths.lockPath, { force: true });
  }
}

export function ensureDesktopAgentSecret(paths: DesktopAgentPaths): string {
  ensureDesktopAgentStateDir(paths.stateDir);
  const existing = readDesktopAgentSecret(paths);
  if (existing) return existing;

  const secret = randomBytes(32).toString("hex");
  try {
    const descriptor = openSync(paths.secretPath, "wx", 0o600);
    try {
      writeSync(descriptor, `${secret}\n`);
      if (process.platform !== "win32") chmodSync(paths.secretPath, 0o600);
      return secret;
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
    const raced = readDesktopAgentSecret(paths);
    if (!raced) throw new Error("Desktop agent secret is invalid.");
    return raced;
  }
}

export function readDesktopAgentSecret(paths: DesktopAgentPaths): string | undefined {
  try {
    const secret = readFileSync(paths.secretPath, "utf8").trim();
    return /^[0-9a-f]{64}$/i.test(secret) ? secret : undefined;
  } catch {
    return undefined;
  }
}

export function removeDesktopAgentRuntimeFiles(paths: DesktopAgentPaths): void {
  rmSync(paths.pidPath, { force: true });
  if (process.platform !== "win32") rmSync(paths.socketPath, { force: true });
}

export function readDesktopAgentPid(path: string): number | undefined {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!/^\d+$/.test(raw)) return undefined;
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writeFileSecure(path: string, content: string): void {
  const descriptor = openSync(path, "w", 0o600);
  try {
    writeSync(descriptor, content);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } finally {
    closeSync(descriptor);
  }
}

function isFileExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function removeStaleLock(path: string): boolean {
  const stalePath = `${path}.stale-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    renameSync(path, stalePath);
    rmSync(stalePath, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function hashStateDir(stateDir: string): string {
  return createHash("sha256").update(stateDir).digest("hex").slice(0, 24);
}
