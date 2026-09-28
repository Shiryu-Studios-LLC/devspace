#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stateDir = requiredEnv("DEVSPACE_COMPUTER_USE_STATE_DIR");
const agentStateDir = requiredEnv("DEVSPACE_COMPUTER_USE_AGENT_STATE_DIR");
const sessionId = requiredEnv("DEVSPACE_COMPUTER_USE_SESSION_ID");
const sessionMode = process.env.DEVSPACE_COMPUTER_USE_MODE || "isolated-window";
const startedAt = new Date().toISOString();
const controlSocket = join(stateDir, "control.sock");
const sessionPath = join(stateDir, "session.json");
const agentEntrypoint = fileURLToPath(new URL("./desktop-agent-main.js", import.meta.url));
const launched = new Map<number, ChildProcess>();
const launchedProcessGroups = new Set<number>();
let agent: ChildProcess | undefined;
let shuttingDown = false;

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(agentStateDir, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") {
  chmodSync(stateDir, 0o700);
  chmodSync(agentStateDir, 0o700);
  rmSync(controlSocket, { force: true });
}

agent = spawn(process.execPath, [agentEntrypoint], {
  env: {
    ...process.env,
    DEVSPACE_STATE_DIR: agentStateDir,
  },
  stdio: "ignore",
});
agent.once("exit", (code, signal) => {
  if (!shuttingDown) {
    console.error(`DevSpace isolated desktop agent exited (${signal ?? code ?? "unknown"}).`);
    void shutdown(1);
  }
});

const server = createServer((socket) => handleSocket(socket));
server.listen(controlSocket, () => {
  if (process.platform !== "win32") chmodSync(controlSocket, 0o600);
  persistSession();
});

const shutdownSignal = () => { void shutdown(0); };
process.once("SIGINT", shutdownSignal);
process.once("SIGTERM", shutdownSignal);

function handleSocket(socket: Socket): void {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string | Buffer) => {
    buffer += chunk.toString();
    if (Buffer.byteLength(buffer, "utf8") > 64 * 1024) {
      socket.end(JSON.stringify({ ok: false, error: "request too large" }) + "\n");
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    void dispatch(line).then((result) => {
      socket.end(JSON.stringify({ ok: true, ...result }) + "\n");
    }).catch((error) => {
      socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
    });
  });
}

async function dispatch(line: string): Promise<Record<string, unknown>> {
  const request = JSON.parse(line) as { type?: unknown; file?: unknown; args?: unknown; cwd?: unknown };
  if (request.type === "ping") {
    return sessionMetadata();
  }
  if (request.type === "launch") {
    if (typeof request.file !== "string" || !isAbsolute(request.file) || !existsSync(request.file)) {
      throw new Error("launch requires an existing absolute executable path");
    }
    const args = Array.isArray(request.args) ? request.args : [];
    if (!args.every((value) => typeof value === "string" && value.length <= 16_384)) {
      throw new Error("launch args must be bounded strings");
    }
    const cwd = typeof request.cwd === "string" && request.cwd.trim() !== ""
      ? resolve(request.cwd)
      : undefined;
    if (cwd && !isAbsolute(cwd)) throw new Error("launch cwd must be absolute");
    const detached = process.platform !== "win32";
    const child = spawn(request.file, args as string[], {
      cwd,
      env: process.env,
      detached,
      stdio: "ignore",
    });
    child.unref();
    launched.set(child.pid!, child);
    if (detached && child.pid) launchedProcessGroups.add(child.pid);
    child.once("exit", () => launched.delete(child.pid!));
    return { pid: child.pid, file: request.file };
  }
  if (request.type === "stop") {
    setImmediate(() => { void shutdown(0); });
    return { stopping: true };
  }
  throw new Error("unsupported computer-use control request");
}

function sessionMetadata(): Record<string, unknown> {
  return {
    sessionId,
    mode: sessionMode,
    hostPid: process.pid,
    kwinPid: process.ppid,
    agentPid: agent?.pid,
    startedAt,
    controlSocket,
    waylandDisplay: process.env.WAYLAND_DISPLAY,
    display: process.env.DISPLAY,
    dbusSessionBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS,
    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
  };
}

function persistSession(): void {
  writeFileSync(sessionPath, JSON.stringify(sessionMetadata(), null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(sessionPath, 0o600);
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose())).catch(() => undefined);
  if (process.platform !== "win32") {
    const processGroups = [...launchedProcessGroups];
    for (const processGroup of processGroups) terminateProcessGroup(processGroup, "SIGTERM");
    if (processGroups.length > 0) await delay(750);
    for (const processGroup of processGroups) terminateProcessGroup(processGroup, "SIGKILL");
  } else {
    for (const child of launched.values()) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }
  launched.clear();
  launchedProcessGroups.clear();
  if (agent && agent.exitCode === null) {
    try { agent.kill("SIGTERM"); } catch { /* already gone */ }
  }
  rmSync(controlSocket, { force: true });
  rmSync(sessionPath, { force: true });
  process.exit(exitCode);
}

function terminateProcessGroup(processGroup: number, signal: NodeJS.Signals): void {
  try { process.kill(-processGroup, signal); } catch { /* process group already exited */ }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
