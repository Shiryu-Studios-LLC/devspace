#!/usr/bin/env node
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "devspace-computer-use-session-host");
const target = join(root, "dist", "bin", "devspace-computer-use-session-host");
const desktopSource = join(root, "native", "org.shiryustudios.DevSpace.ComputerUse.desktop");
const desktopTarget = join(root, "dist", "share", "applications", "org.shiryustudios.DevSpace.ComputerUse.desktop");
const iconSource = join(root, "native", "devspace-agent-desktop.svg");
const iconTarget = join(root, "dist", "share", "icons", "hicolor", "scalable", "apps", "devspace-agent-desktop.svg");

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
await chmod(target, 0o755);
await mkdir(dirname(desktopTarget), { recursive: true });
await copyFile(desktopSource, desktopTarget);
await mkdir(dirname(iconTarget), { recursive: true });
await copyFile(iconSource, iconTarget);
console.log(`Built ${target}`);
console.log(`Built ${desktopTarget}`);
console.log(`Built ${iconTarget}`);
