#!/usr/bin/env node
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "native", "devspace-accessibility-helper.py");
const target = join(repoRoot, "dist", "bin", "devspace-accessibility-helper.py");
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
await chmod(target, 0o755);
console.log(`Built ${target}`);
