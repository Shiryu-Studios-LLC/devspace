#!/usr/bin/env node
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "devspace-computer-use-session-host");
const target = join(root, "dist", "bin", "devspace-computer-use-session-host");
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
await chmod(target, 0o755);
console.log(`Built ${target}`);
