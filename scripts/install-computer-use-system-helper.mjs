#!/usr/bin/env node
import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  throw new Error("The DevSpace computer-use screenshot helper installer is Linux-only.");
}
if (process.getuid?.() !== 0) {
  throw new Error("Run this installer with root privileges so KWin can trust the restricted screenshot helper.");
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperSource = resolve(repoRoot, "dist", "bin", "devspace-screenshot-helper");
const desktopSource = resolve(repoRoot, "dist", "share", "org.shiryustudios.DevSpace.ScreenshotHelper.desktop");
const helperTarget = "/usr/lib/devspace/devspace-screenshot-helper";
const desktopTarget = "/usr/share/applications/org.shiryustudios.DevSpace.ScreenshotHelper.desktop";

for (const path of [helperSource, desktopSource]) {
  const value = await stat(path).catch(() => undefined);
  if (!value?.isFile()) throw new Error(`Build DevSpace first; required file is missing: ${path}`);
}

await mkdir(dirname(helperTarget), { recursive: true, mode: 0o755 });
await copyFile(helperSource, helperTarget);
await chmod(helperTarget, 0o755);
await copyFile(desktopSource, desktopTarget);
await chmod(desktopTarget, 0o644);

console.log(JSON.stringify({
  ok: true,
  helper: helperTarget,
  desktopEntry: desktopTarget,
  note: "Refresh the user's KDE service cache (kbuildsycoca6 --noincremental) after installation.",
}));
