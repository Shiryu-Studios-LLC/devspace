#!/usr/bin/env node
import { execFile } from "node:child_process";
import { cp, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDist = join(repoRoot, "dist");
const targetRoot = resolve(
  process.argv[2]
    ?? process.env.DEVSPACE_LIVE_INSTALL_DIR
    ?? join(homedir(), ".local", "share", "devspace-linux"),
);
const targetDist = join(targetRoot, "dist");
const sourceHotBundle = join(sourceDist, "hot-modules.mjs");
const targetHotBundle = join(targetDist, "hot-modules.mjs");

await assertFile(sourceHotBundle, "Build DevSpace first with `npm run build`.");
await assertFile(
  targetHotBundle,
  "The target does not have the hot-reload bootstrap yet. Install the hot-reload-capable core once before using hot deploy.",
);

await mkdir(targetDist, { recursive: true });
await cp(sourceDist, targetDist, {
  recursive: true,
  force: true,
  filter: (source) => basename(source) !== "hot-modules.mjs",
});
const screenshotAuthorization = await installScreenshotAuthorization(targetDist);

const activationTemp = join(targetDist, `.hot-modules.${process.pid}.${Date.now()}.tmp`);
try {
  await copyFile(sourceHotBundle, activationTemp);
  await rename(activationTemp, targetHotBundle);
} finally {
  await rm(activationTemp, { force: true }).catch(() => undefined);
}

const recycledDesktopAgent = await recycleDesktopAgent();
console.log(JSON.stringify({
  ok: true,
  target: targetRoot,
  activation: targetHotBundle,
  coreRestarted: false,
  desktopAgentRecycled: recycledDesktopAgent,
  screenshotAuthorization,
}));

async function assertFile(path, message) {
  const value = await stat(path).catch(() => undefined);
  if (!value?.isFile()) throw new Error(`${message} Missing: ${path}`);
}

async function installScreenshotAuthorization(distDir) {
  if (process.platform !== "linux") return { installed: false, cacheRefreshed: false };
  const helper = join(distDir, "bin", "devspace-screenshot-helper");
  const helperStat = await stat(helper).catch(() => undefined);
  if (!helperStat?.isFile()) return { installed: false, cacheRefreshed: false };
  if (/[\r\n]/.test(helper)) throw new Error("Invalid screenshot helper path.");

  const applicationsDir = join(homedir(), ".local", "share", "applications");
  const desktopPath = join(applicationsDir, "org.shiryustudios.DevSpace.ScreenshotHelper.desktop");
  const desktopTemp = `${desktopPath}.${process.pid}.${Date.now()}.tmp`;
  const quotedHelper = `"${helper.replace(/[\\"`$]/g, "\\$&")}"`;
  const desktopEntry = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=DevSpace Screenshot Helper",
    `Exec=${quotedHelper}`,
    "NoDisplay=true",
    "Terminal=false",
    "X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2",
    "",
  ].join("\n");
  await mkdir(applicationsDir, { recursive: true });
  try {
    await writeFile(desktopTemp, desktopEntry, { mode: 0o600 });
    await rename(desktopTemp, desktopPath);
  } finally {
    await rm(desktopTemp, { force: true }).catch(() => undefined);
  }

  let cacheRefreshed = false;
  const cacheBuilder = "/usr/bin/kbuildsycoca6";
  if ((await stat(cacheBuilder).catch(() => undefined))?.isFile()) {
    try {
      await execFileAsync(cacheBuilder, ["--noincremental"], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      });
      cacheRefreshed = true;
    } catch {
      // KDE can still discover the desktop entry on its next cache refresh.
    }
  }
  return { installed: true, cacheRefreshed, desktopPath, helper };
}

async function recycleDesktopAgent() {
  try {
    const { loadConfig } = await import(new URL("../dist/config.js", import.meta.url).href);
    const { desktopAgentPaths } = await import(new URL("../dist/desktop-agent-lifecycle.js", import.meta.url).href);
    const paths = desktopAgentPaths(loadConfig().stateDir);
    const text = await readFile(paths.pidPath, "utf8").catch(() => "");
    const pid = Number(text.trim());
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
