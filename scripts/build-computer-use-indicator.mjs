#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "devspace-computer-use-indicator.cpp");
const scriptSource = join(root, "native", "devspace-computer-use-indicator-kwin.js");
const output = join(root, "dist", "bin", "devspace-computer-use-indicator");
const scriptOutput = join(root, "dist", "share", "devspace-computer-use-indicator-kwin.js");

if (process.platform !== "linux") {
  console.log("Skipping computer-use indicator build on non-Linux platform.");
  process.exit(0);
}

try {
  const { stdout } = await execFileAsync(
    "/usr/bin/pkg-config",
    ["--cflags", "--libs", "Qt6Core", "Qt6Gui", "Qt6Widgets", "Qt6DBus"],
    { encoding: "utf8" },
  );
  const flags = splitShellWords(stdout.trim());
  await mkdir(dirname(output), { recursive: true });
  await mkdir(dirname(scriptOutput), { recursive: true });
  await execFileAsync(
    "/usr/bin/g++",
    ["-std=c++20", "-O2", "-fPIC", "-no-pie", source, "-o", output, ...flags, "-lLayerShellQtInterface"],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  await chmod(output, 0o755);
  await copyFile(scriptSource, scriptOutput);
  console.log(`Built ${output}`);
} catch (error) {
  await rm(output, { force: true }).catch(() => undefined);
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`Skipping optional computer-use indicator: ${detail}`);
}

function splitShellWords(value) {
  const words = [];
  let current = "";
  let quote = "";
  let escaping = false;
  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping || quote) throw new Error("pkg-config returned malformed compiler flags.");
  if (current) words.push(current);
  return words;
}
