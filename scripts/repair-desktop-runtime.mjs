import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WAYLAND_MARKER = "DEVSPACE KWIN SOCKET ENV FIX";
const MODE_MARKER = "DEVSPACE PERSISTENT PHYSICAL OBSERVATION MODE";
const DESCRIPTION_MARKER = "Select the physical KDE desktop for read-only observation";
const DESCRIPTION = `${DESCRIPTION_MARKER}. This selection persists until stopped or switched to isolated mode. Mouse and keyboard actions still use the isolated desktop.`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function repairDesktopRuntime(rootDir = root) {
  const sessionFiles = [
    resolve(rootDir, "dist/computer-use-session.js"),
    resolve(rootDir, "dist/hot-modules.mjs"),
  ];

  for (const filePath of sessionFiles) {
    if (!existsSync(filePath)) {
      throw new Error(`Expected installed DevSpace desktop runtime file is missing: ${filePath}`);
    }

    let source = readFileSync(filePath, "utf8");
    source = replaceOnceOrAlreadyPatched(source, {
      filePath,
      marker: WAYLAND_MARKER,
      before: "...process.env,\n                XDG_RUNTIME_DIR: runtimeDir,\n                ...(outerWayland ? { WAYLAND_DISPLAY: outerWayland } : {}),",
      after: `...(() => { const env = { ...process.env }; delete env.WAYLAND_DISPLAY; return env; })(),\n                XDG_RUNTIME_DIR: runtimeDir,\n                /* ${WAYLAND_MARKER} */`,
      bundleBefore: "...process.env,\n        XDG_RUNTIME_DIR: runtimeDir,\n        ...outerWayland ? { WAYLAND_DISPLAY: outerWayland } : {},",
      bundleAfter: `...(() => { const env = { ...process.env }; delete env.WAYLAND_DISPLAY; return env; })(),\n        XDG_RUNTIME_DIR: runtimeDir,\n        /* ${WAYLAND_MARKER} */`,
    });
    source = replaceOnceOrAlreadyPatched(source, {
      filePath,
      marker: MODE_MARKER,
      before: 'if (existing.state === "ready" && existing.mode !== "host-fallback") {',
      after: `/* ${MODE_MARKER} */
        if (options.allowHostFallback === true) {
            if (existing.state === "ready" && existing.mode === "host-fallback") return existing;
            if (this.active) await this.stop();
            this.active = false;
            this.state = "ready";
            this.mode = "host-fallback";
            this.owner = "agent";
            this.viewerVisible = false;
            this.fallbackReason = "Physical desktop observation mode selected explicitly.";
            this.writeIndicator("waiting");
            if (options.indicator !== false) this.ensureIndicator();
            return this.snapshot();
        }
        if (existing.state === "ready" && existing.mode !== "host-fallback") {`,
      bundleBefore: 'if (existing.state === "ready" && existing.mode !== "host-fallback") {',
      bundleAfter: `/* ${MODE_MARKER} */
      if (options.allowHostFallback === true) {
        if (existing.state === "ready" && existing.mode === "host-fallback") return existing;
        if (this.active) await this.stop();
        this.active = false;
        this.state = "ready";
        this.mode = "host-fallback";
        this.owner = "agent";
        this.viewerVisible = false;
        this.fallbackReason = "Physical desktop observation mode selected explicitly.";
        this.writeIndicator("waiting");
        if (options.indicator !== false) this.ensureIndicator();
        return this.snapshot();
      }
      if (existing.state === "ready" && existing.mode !== "host-fallback") {`,
    });
    source = replaceOnceOrAlreadyPatched(source, {
      filePath,
      marker: "DEVSPACE RESTORE PHYSICAL OBSERVATION MODE",
      before: "this.indicatorState = parsed.state;",
      after: `this.indicatorState = parsed.state;\n            /* DEVSPACE RESTORE PHYSICAL OBSERVATION MODE */\n            if (parsed.sessionState === "ready" && parsed.mode === "host-fallback") {\n                this.active = false;\n                this.state = "ready";\n                this.mode = "host-fallback";\n                this.owner = "agent";\n                this.viewerVisible = false;\n                this.fallbackReason = "Physical desktop observation mode is enabled.";\n            }`,
      bundleBefore: "this.indicatorState = parsed.state;",
      bundleAfter: `this.indicatorState = parsed.state;\n      /* DEVSPACE RESTORE PHYSICAL OBSERVATION MODE */\n      if (parsed.sessionState === "ready" && parsed.mode === "host-fallback") {\n        this.active = false;\n        this.state = "ready";\n        this.mode = "host-fallback";\n        this.owner = "agent";\n        this.viewerVisible = false;\n        this.fallbackReason = "Physical desktop observation mode is enabled.";\n      }`,
    });
    source = replaceTextOnceOrAlreadyPatched(
      source,
      "if (this.active) await this.stop();",
      "/* DEVSPACE STOP PERSISTED ISOLATED SESSION */\n            if (this.active || this.readSessionMetadata()) await this.stop();",
      "DEVSPACE STOP PERSISTED ISOLATED SESSION",
      filePath,
    );

    if (filePath.endsWith("hot-modules.mjs")) {
      source = replaceTextOnceOrAlreadyPatched(
        source,
        "Allow the legacy live-desktop path if the isolated compositor cannot start. Defaults to false for safe concurrent use.",
        DESCRIPTION,
        DESCRIPTION_MARKER,
        filePath,
      );
    }

    writeFileSync(filePath, source);
  }

  const toolPath = resolve(rootDir, "dist/modules/desktop-agent.js");

  if (!existsSync(toolPath)) {
    throw new Error(`Expected installed DevSpace desktop tool module is missing: ${toolPath}`);
  }

  let toolSource = readFileSync(toolPath, "utf8");
  toolSource = replaceTextOnceOrAlreadyPatched(
    toolSource,
    "Allow the legacy live-desktop path if the isolated compositor cannot start. Defaults to false for safe concurrent use.",
    DESCRIPTION,
    DESCRIPTION_MARKER,
    toolPath,
  );
  writeFileSync(toolPath, toolSource);

  return { patched: sessionFiles.map((path) => path), toolModule: toolPath };
}

function replaceOnceOrAlreadyPatched(source, options) {
  if (source.includes(options.marker)) return source;
  const before = source.includes(options.before) ? options.before : options.bundleBefore;
  const after = source.includes(options.before) ? options.after : options.bundleAfter;

  if (!before || !after || !source.includes(before)) {
    throw new Error(`Could not locate the expected desktop runtime code in ${options.filePath} (${options.marker}).`);
  }

  return source.replace(before, after);
}

function replaceTextOnceOrAlreadyPatched(source, before, after, marker, filePath) {
  if (source.includes(marker)) return source;

  if (!source.includes(before)) {
    throw new Error(`Could not locate the expected desktop tool description in ${filePath}.`);
  }

  return source.replace(before, after);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = repairDesktopRuntime();
  process.stdout.write(`Repaired DevSpace desktop runtime in ${result.patched.length} session modules and the tool description.\n`);
}
