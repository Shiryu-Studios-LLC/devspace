#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
const plasmaStateDir = join(stateDir, "plasma");
const plasmaHomeDir = join(plasmaStateDir, "home");
const plasmaConfigDir = join(plasmaStateDir, "config");
const plasmaDataDir = join(plasmaStateDir, "data");
const plasmaCacheDir = join(plasmaStateDir, "cache");
const plasmaRuntimeStateDir = join(plasmaStateDir, "state");
const wallpaperDir = join(plasmaStateDir, "wallpaper");
const wallpaperSvgPath = join(wallpaperDir, "devspace-agent-desktop.svg");
const wallpaperPngPath = join(wallpaperDir, "devspace-agent-desktop.png");
const launched = new Map<number, ChildProcess>();
const launchedProcessGroups = new Set<number>();
let agent: ChildProcess | undefined;
let plasmaShell: ChildProcess | undefined;
let shuttingDown = false;

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(agentStateDir, { recursive: true, mode: 0o700 });
for (const directory of [
  plasmaStateDir,
  plasmaHomeDir,
  join(plasmaHomeDir, "Desktop"),
  join(plasmaHomeDir, "Documents"),
  join(plasmaHomeDir, "Downloads"),
  plasmaConfigDir,
  plasmaDataDir,
  plasmaCacheDir,
  plasmaRuntimeStateDir,
  wallpaperDir,
]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
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

if (sessionMode === "isolated-window") {
  prepareAgentDesktopWallpaper();
  plasmaShell = startPlasmaShell();
  void configureAgentDesktop();
}

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
    plasmaShellPid: plasmaShell?.pid,
    plasmaShellEnabled: sessionMode === "isolated-window",
    wallpaperPath: sessionMode === "isolated-window" ? preferredWallpaperPath() : undefined,
    startedAt,
    controlSocket,
    waylandDisplay: process.env.WAYLAND_DISPLAY,
    display: process.env.DISPLAY,
    dbusSessionBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS,
    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
  };
}

function plasmaEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: plasmaHomeDir,
    XDG_CONFIG_HOME: plasmaConfigDir,
    XDG_DATA_HOME: plasmaDataDir,
    XDG_CACHE_HOME: plasmaCacheDir,
    XDG_STATE_HOME: plasmaRuntimeStateDir,
    XDG_CURRENT_DESKTOP: "KDE",
    XDG_SESSION_DESKTOP: "KDE",
    XDG_SESSION_TYPE: "wayland",
    KDE_FULL_SESSION: "true",
    KDE_SESSION_VERSION: "6",
    QT_QPA_PLATFORM: "wayland",
  };
}

function prepareAgentDesktopWallpaper(): void {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#090b12"/>
      <stop offset="0.55" stop-color="#151126"/>
      <stop offset="1" stop-color="#071a23"/>
    </linearGradient>
    <radialGradient id="orb" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#8d6cff" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#8d6cff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#9b7cff"/>
      <stop offset="1" stop-color="#48d3ff"/>
    </linearGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#bg)"/>
  <circle cx="1520" cy="140" r="520" fill="url(#orb)"/>
  <circle cx="310" cy="930" r="460" fill="url(#orb)" opacity="0.55"/>
  <g opacity="0.13" stroke="#a899ff" fill="none">
    <path d="M0 720 C360 570 610 760 960 640 S1560 510 1920 640" stroke-width="2"/>
    <path d="M0 785 C380 635 650 825 1010 700 S1600 585 1920 710" stroke-width="1.5"/>
  </g>
  <g transform="translate(960 505)">
    <circle r="150" fill="#0b0e18" stroke="url(#ring)" stroke-width="6"/>
    <circle r="104" fill="none" stroke="#8f76ff" stroke-width="2" opacity="0.55"/>
    <path d="M-62 -18 L0 -82 L62 -18 L0 46 Z" fill="none" stroke="url(#ring)" stroke-width="9" stroke-linejoin="round"/>
    <circle cy="72" r="10" fill="#5fd6ff"/>
  </g>
  <text x="960" y="735" text-anchor="middle" fill="#f3f0ff" font-size="54" font-family="sans-serif" font-weight="600" letter-spacing="2">DEVSPACE</text>
  <text x="960" y="786" text-anchor="middle" fill="#a69ebf" font-size="23" font-family="sans-serif" letter-spacing="7">AGENT DESKTOP</text>
  <text x="960" y="1010" text-anchor="middle" fill="#77718a" font-size="16" font-family="sans-serif" letter-spacing="2">SHIRYU STUDIOS</text>
</svg>\n`;
  writeFileSync(wallpaperSvgPath, svg, { mode: 0o600 });
  const converter = "/usr/bin/rsvg-convert";
  if (existsSync(converter)) {
    const result = spawnSync(converter, ["-w", "1920", "-h", "1080", "-o", wallpaperPngPath, wallpaperSvgPath], {
      env: process.env,
      stdio: "ignore",
      timeout: 10_000,
    });
    if (result.status === 0 && existsSync(wallpaperPngPath) && process.platform !== "win32") {
      chmodSync(wallpaperPngPath, 0o600);
    }
  }
}

function preferredWallpaperPath(): string {
  return existsSync(wallpaperPngPath) ? wallpaperPngPath : wallpaperSvgPath;
}

function startPlasmaShell(): ChildProcess | undefined {
  const executable = "/usr/bin/plasmashell";
  if (!existsSync(executable)) return undefined;
  const child = spawn(executable, ["--no-respawn"], {
    env: plasmaEnvironment(),
    detached: false,
    stdio: "ignore",
  });
  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`DevSpace Agent Desktop Plasma shell exited (${signal ?? code ?? "unknown"}).`);
    }
  });
  return child;
}

async function configureAgentDesktop(): Promise<void> {
  const qdbus = "/usr/bin/qdbus6";
  if (!plasmaShell || !existsSync(qdbus)) return;
  const wallpaperUrl = `file://${preferredWallpaperPath()}`;
  const script = [
    "var desktopList = desktops();",
    "if (desktopList.length === 0) { print('DEVSPACE_WAIT'); } else {",
    "for (var i = 0; i < desktopList.length; ++i) {",
    "  var desktop = desktopList[i];",
    "  desktop.wallpaperPlugin = 'org.kde.image';",
    "  desktop.currentConfigGroup = ['Wallpaper', 'org.kde.image', 'General'];",
    `  desktop.writeConfig('Image', ${JSON.stringify(wallpaperUrl)});`,
    `  desktop.writeConfig('PreviewImage', ${JSON.stringify(wallpaperUrl)});`,
    "  desktop.writeConfig('FillMode', 2);",
    "}",
    "var panelList = panels();",
    "if (panelList.length === 0) {",
    "  var panel = new Panel;",
    "  panel.location = 'bottom';",
    "  panel.height = 42;",
    "  function addSafe(plugin) { try { panel.addWidget(plugin); } catch (e) {} }",
    "  addSafe('org.kde.plasma.kickoff');",
    "  addSafe('org.kde.plasma.icontasks');",
    "  addSafe('org.kde.plasma.panelspacer');",
    "  addSafe('org.kde.plasma.systemtray');",
    "  addSafe('org.kde.plasma.digitalclock');",
    "}",
    "print('DEVSPACE_READY');",
    "}",
  ].join("\n");

  for (let attempt = 0; attempt < 60 && !shuttingDown; ++attempt) {
    const result = await runChild(qdbus, [
      "org.kde.plasmashell",
      "/PlasmaShell",
      "org.kde.PlasmaShell.evaluateScript",
      script,
    ], plasmaEnvironment(), 2_000);
    if (result.code === 0 && result.stdout.includes("DEVSPACE_READY")) return;
    await delay(150);
  }
  console.error("DevSpace Agent Desktop Plasma customization did not become ready before timeout.");
}

async function runChild(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code?: number; stdout: string }> {
  return new Promise((resolveExit) => {
    let settled = false;
    let stdout = "";
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString();
    });
    const finish = (code?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExit({ code, stdout });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      finish(undefined);
    }, timeoutMs);
    timer.unref();
    child.once("error", () => finish(undefined));
    child.once("exit", (code) => finish(code ?? undefined));
  });
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
  if (plasmaShell && plasmaShell.exitCode === null) {
    try { plasmaShell.kill("SIGTERM"); } catch { /* already gone */ }
  }
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
