import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repairUpstreamMcpRuntime } from "./repair-upstream-mcp-stdio.mjs";

const WAYLAND_MARKER = "DEVSPACE KWIN SOCKET ENV FIX";
const MODE_MARKER = "DEVSPACE PERSISTENT PHYSICAL OBSERVATION MODE";
const DESCRIPTION_MARKER = "Select the physical KDE desktop for observation and direct interaction";
const DESCRIPTION = `${DESCRIPTION_MARKER}; this selection persists across service restarts. When omitted, DevSpace uses the saved mode; set false to choose the isolated desktop. Mouse and keyboard events use KDE's XDG Desktop Portal after its permission is granted.`;
const PHYSICAL_CONTROL_MARKER = "DEVSPACE PORTAL AUTHORIZED PHYSICAL CONTROL";

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
            this.fallbackReason = "Physical KDE desktop interaction mode selected explicitly.";
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
        this.fallbackReason = "Physical KDE desktop interaction mode selected explicitly.";
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
      after: `this.indicatorState = parsed.state;\n            /* DEVSPACE RESTORE PHYSICAL OBSERVATION MODE */\n            if (parsed.sessionState === "ready" && parsed.mode === "host-fallback") {\n                this.active = false;\n                this.state = "ready";\n                this.mode = "host-fallback";\n                this.owner = "agent";\n                this.viewerVisible = false;\n                this.fallbackReason = "Physical KDE desktop interaction mode is enabled.";\n            }`,
      bundleBefore: "this.indicatorState = parsed.state;",
      bundleAfter: `this.indicatorState = parsed.state;\n      /* DEVSPACE RESTORE PHYSICAL OBSERVATION MODE */\n      if (parsed.sessionState === "ready" && parsed.mode === "host-fallback") {\n        this.active = false;\n        this.state = "ready";\n        this.mode = "host-fallback";\n        this.owner = "agent";\n        this.viewerVisible = false;\n        this.fallbackReason = "Physical KDE desktop interaction mode is enabled.";\n      }`,
    });
    source = patchPersistentPhysicalSelection(source, filePath);
    source = patchPersistedPhysicalDefault(source, filePath);
    source = patchStopPreservesPhysicalSelection(source, filePath);
    source = replaceTextOnceOrAlreadyPatched(
      source,
      "if (this.active) await this.stop();",
      "/* DEVSPACE STOP PERSISTED ISOLATED SESSION */\n            if (this.active || this.readSessionMetadata()) await this.stop();",
      "DEVSPACE STOP PERSISTED ISOLATED SESSION",
      filePath,
    );

    if (filePath.endsWith("hot-modules.mjs")) {
      source = patchPhysicalDesktopDescription(source, filePath);
      source = patchSelectedDesktopClientRouting(source, filePath);
    }

    writeFileSync(filePath, source);
  }

  const toolPath = resolve(rootDir, "dist/modules/desktop-agent.js");

  if (!existsSync(toolPath)) {
    throw new Error(`Expected installed DevSpace desktop tool module is missing: ${toolPath}`);
  }

  let toolSource = readFileSync(toolPath, "utf8");
  toolSource = patchPhysicalDesktopDescription(toolSource, toolPath);
  toolSource = patchSelectedDesktopClientRouting(toolSource, toolPath);
  toolSource = patchPhysicalControlTool(toolSource, toolPath);
  toolSource = patchHostAgentClientTimeout(toolSource, toolPath);
  writeFileSync(toolPath, toolSource);

  const runtimePaths = [resolve(rootDir, "dist/computer-use-session.js"), resolve(rootDir, "dist/hot-modules.mjs")];
  for (const filePath of runtimePaths) {
    let source = readFileSync(filePath, "utf8");
    if (filePath.endsWith("hot-modules.mjs")) source = patchPhysicalControlTool(source, filePath);
    source = patchPhysicalInputRouting(source, filePath);
    if (filePath.endsWith("hot-modules.mjs")) source = patchHostAgentClientTimeout(source, filePath);
    writeFileSync(filePath, source);
  }
  const daemonPath = resolve(rootDir, "dist/desktop-agent-daemon.js");
  writeFileSync(daemonPath, patchPhysicalDaemonProvider(readFileSync(daemonPath, "utf8"), daemonPath));
  const inputPath = resolve(rootDir, "dist/desktop-input-eis.js");
  writeFileSync(inputPath, patchPhysicalHelperPath(readFileSync(inputPath, "utf8"), inputPath));
  const helperPath = resolve(rootDir, "dist/bin/devspace-xdg-portal-input.py");
  mkdirSync(dirname(helperPath), { recursive: true });
  copyFileSync(resolve(root, "scripts/devspace-xdg-portal-input.py"), helperPath);
  const accessibilityHelperPath = resolve(rootDir, "dist/bin/devspace-accessibility-helper.py");
  if (!existsSync(accessibilityHelperPath)) throw new Error(`Expected installed accessibility helper is missing: ${accessibilityHelperPath}`);
  writeFileSync(accessibilityHelperPath, patchAccessibilityRegistryFallback(readFileSync(accessibilityHelperPath, "utf8"), accessibilityHelperPath));

  const upstreamModules = repairUpstreamMcpRuntime(rootDir);
  return { patched: [...sessionFiles, ...runtimePaths, daemonPath, inputPath, helperPath, accessibilityHelperPath, ...upstreamModules], toolModule: toolPath };
}

function patchPersistentPhysicalSelection(source, filePath) {
  const marker = "DEVSPACE PERSISTENT PHYSICAL MODE SELECTION";
  if (source.includes(marker)) return source;

  const bundled = filePath.endsWith("hot-modules.mjs");
  const join = bundled ? "join4" : "join";
  const readFile = bundled ? "readFileSync3" : "readFileSync";
  const writeFile = "writeFileSync";
  const remove = bundled ? "rmSync3" : "rmSync";
  const chmod = bundled ? "chmodSync3" : "chmodSync";
  const exists = bundled ? "existsSync4" : "existsSync";
  const helperIndent = bundled ? "  " : "    ";
  const methods = `${helperIndent}/* ${marker} */\n${helperIndent}persistPhysicalSelection(enabled) {\n${helperIndent}    const path = ${join}(this.computerStateDir, "desktop-selection.json");\n${helperIndent}    if (!enabled) { ${remove}(path, { force: true }); return; }\n${helperIndent}    ensurePrivateDirectory(this.computerStateDir);\n${helperIndent}    ${writeFile}(path, JSON.stringify({ version: 1, mode: "host-fallback", updatedAt: new Date().toISOString() }) + "\\n", { mode: 0o600 });\n${helperIndent}    if (process.platform !== "win32") ${chmod}(path, 0o600);\n${helperIndent}}\n${helperIndent}hasPersistedPhysicalSelection() {\n${helperIndent}    try {\n${helperIndent}        const path = ${join}(this.computerStateDir, "desktop-selection.json");\n${helperIndent}        const parsed = JSON.parse(${readFile}(path, "utf8"));\n${helperIndent}        return parsed?.version === 1 && parsed?.mode === "host-fallback";\n${helperIndent}    } catch { return false; }\n${helperIndent}}\n`;
  const indicatorAnchor = bundled ? "  writeIndicator(state) {" : "    writeIndicator(state) {";
  if (!source.includes(indicatorAnchor)) throw new Error(`Could not locate computer-use persistence boundary in ${filePath}.`);
  source = source.replace(indicatorAnchor, `${methods}${indicatorAnchor}`);

  const physicalBranch = /(^[ \t]*)if \(options\.allowHostFallback === true\) \{\n([ \t]*)if \(existing\.state === "ready" && existing\.mode === "host-fallback"\) return existing;/m;
  if (!physicalBranch.test(source)) throw new Error(`Could not locate physical mode selection in ${filePath}.`);
  source = source.replace(physicalBranch, (_match, branchIndent, nestedIndent) =>
    `${branchIndent}if (options.allowHostFallback === true) {\n${nestedIndent}this.persistPhysicalSelection(true);\n${nestedIndent}if (existing.state === "ready" && existing.mode === "host-fallback") return existing;`,
  );

  const isolatedBranch = bundled
    ? '      if (existing.state === "ready" && existing.mode !== "host-fallback") {'
    : '        if (existing.state === "ready" && existing.mode !== "host-fallback") {';
  const isolatedBranchAfter = bundled
    ? '      this.persistPhysicalSelection(false);\n      if (existing.state === "ready" && existing.mode !== "host-fallback") {'
    : '        this.persistPhysicalSelection(false);\n        if (existing.state === "ready" && existing.mode !== "host-fallback") {';
  if (!source.includes(isolatedBranch)) throw new Error(`Could not locate isolated mode selection in ${filePath}.`);
  source = source.replace(isolatedBranch, isolatedBranchAfter);

  const stopStart = bundled ? "  async stop() {\n" : "    async stop() {\n";
  const stopAfter = bundled
    ? '  async stop() {\n    if (this.mode === "host-fallback") this.persistPhysicalSelection(false);\n'
    : '    async stop() {\n        if (this.mode === "host-fallback") this.persistPhysicalSelection(false);\n';
  if (!source.includes(stopStart)) throw new Error(`Could not locate computer-use stop in ${filePath}.`);
  source = source.replace(stopStart, stopAfter);

  const refreshAnchor = bundled
    ? '    if (this.mode === "host-fallback" && this.state === "ready") return this.snapshot();'
    : '        if (this.mode === "host-fallback" && this.state === "ready")\n            return this.snapshot();';
  const refreshReplacement = bundled
    ? `    if (this.hasPersistedPhysicalSelection()) {\n      this.active = false;\n      this.state = "ready";\n      this.mode = "host-fallback";\n      this.owner = "agent";\n      this.viewerVisible = false;\n      this.fallbackReason = "Physical KDE desktop interaction mode is enabled.";\n      return this.snapshot();\n    }`
    : `        if (this.hasPersistedPhysicalSelection()) {\n            this.active = false;\n            this.state = "ready";\n            this.mode = "host-fallback";\n            this.owner = "agent";\n            this.viewerVisible = false;\n            this.fallbackReason = "Physical KDE desktop interaction mode is enabled.";\n            return this.snapshot();\n        }`;
  if (!source.includes(refreshAnchor)) throw new Error(`Could not locate computer-use refresh in ${filePath}.`);
  source = source.replace(refreshAnchor, refreshReplacement);

  const restorePhysicalCondition = 'parsed.sessionState === "ready" && parsed.mode === "host-fallback"';
  source = source.replaceAll(restorePhysicalCondition, `${restorePhysicalCondition} && this.hasPersistedPhysicalSelection()`);
  if (!source.includes(exists)) throw new Error(`Expected filesystem access is unavailable in ${filePath}.`);
  return source;
}

function patchPersistedPhysicalDefault(source, filePath) {
  const marker = "DEVSPACE PHYSICAL MODE FOLLOWS PERSISTED SELECTION";
  if (source.includes(marker)) return source;
  const branch = /(^[ \t]*)if \(options\.allowHostFallback === true\) \{/m;
  if (!branch.test(source)) throw new Error(`Could not locate computer-use mode selection in ${filePath}.`);
  return source.replace(branch, (_match, indent) =>
    `${indent}/* ${marker} */\n${indent}if (options.allowHostFallback === true || (options.allowHostFallback === undefined && this.hasPersistedPhysicalSelection())) {`,
  );
}

function patchStopPreservesPhysicalSelection(source, filePath) {
  const marker = "DEVSPACE STOP PRESERVES PHYSICAL SELECTION";
  if (source.includes(marker)) return source;
  const start = source.indexOf("async start(options");
  const stop = source.indexOf("async stop()", start);
  if (start < 0 || stop < 0) throw new Error(`Could not locate computer-use stop in ${filePath}.`);
  const stopEnd = source.indexOf("async ", stop + 1);
  const methodEnd = stopEnd < 0 ? source.length : stopEnd;
  let method = source.slice(stop, methodEnd);
  const prefix = source.slice(0, stop);
  const indentation = prefix.match(/(?:^|\n)([ \t]*)$/)?.[1] ?? "";
  const clear = "if (this.mode === \"host-fallback\") this.persistPhysicalSelection(false);";
  method = method.replace("async stop()", "async stop(options = {})");
  if (method.includes(clear)) {
    method = method.replace(clear, `/* ${marker} */\n${indentation}    if (options.clearPhysicalSelection === true && this.mode === "host-fallback") this.persistPhysicalSelection(false);`);
  } else {
    method = method.replace("async stop(options = {}) {", `async stop(options = {}) {\n${indentation}    /* ${marker} */\n${indentation}    if (options.clearPhysicalSelection === true && this.mode === "host-fallback") this.persistPhysicalSelection(false);`);
  }
  return source.slice(0, stop) + method + source.slice(methodEnd);
}

function patchAccessibilityRegistryFallback(source, filePath) {
  const marker = "DEVSPACE KDE AT-SPI REGISTRY FALLBACK";
  if (source.includes(marker)) return source;
  const importAnchor = "import argparse\n";
  if (!source.includes(importAnchor)) throw new Error(`Could not locate accessibility helper imports in ${filePath}.`);
  source = source.replace(importAnchor, `${importAnchor}import os\nimport shutil\nimport subprocess\nimport time\n`);
  const functionAnchor = "def snapshot(args):\n    desktop = Atspi.get_desktop(0)";
  if (!source.includes(functionAnchor)) throw new Error(`Could not locate accessibility snapshot entry in ${filePath}.`);
  const helper = `def ensure_atspi_registry():
    try:
        import dbus
        session_bus = dbus.SessionBus()
        address = dbus.Interface(
            session_bus.get_object("org.a11y.Bus", "/org/a11y/bus"),
            "org.a11y.Bus",
        ).GetAddress()
        accessibility_bus = dbus.bus.BusConnection(str(address))
        try:
            accessibility_bus.get_name_owner("org.a11y.atspi.Registry")
            return
        except dbus.DBusException:
            pass
        registry = shutil.which("at-spi2-registryd") or "/usr/lib/at-spi2-registryd"
        if not os.path.isfile(registry):
            raise RuntimeError("The AT-SPI registry executable is unavailable.")
        subprocess.Popen(
            [registry],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                accessibility_bus.get_name_owner("org.a11y.atspi.Registry")
                return
            except dbus.DBusException:
                time.sleep(0.05)
        raise RuntimeError("The AT-SPI registry did not become ready.")
    except Exception as exc:
        raise RuntimeError(f"Could not start the KDE AT-SPI accessibility registry: {exc}") from exc


# ${marker}
`;
  source = source.replace(functionAnchor, `${helper}def snapshot(args):\n    ensure_atspi_registry()\n    desktop = Atspi.get_desktop(0)`);
  const actionAnchor = "def perform_action(args):\n";
  if (!source.includes(actionAnchor)) throw new Error(`Could not locate accessibility action entry in ${filePath}.`);
  return source.replace(actionAnchor, `${actionAnchor}    ensure_atspi_registry()\n`);
}

function patchPhysicalControlTool(source, filePath) {
  const schemaPattern = /^(\s*)(allowHostFallback: z\d*\.boolean\(\)\.optional\(\)\.describe\()"[^\n]*"\),?$/m;
  if (!schemaPattern.test(source)) throw new Error(`Could not locate physical desktop selection in ${filePath}.`);
  source = source.replace(schemaPattern, `$1$2"${DESCRIPTION}"),`);
  source = source.replace(/^\s*\/\* DEVSPACE PORTAL AUTHORIZED PHYSICAL CONTROL \*\/\n\s*allowHostControl: z\d*\.boolean\(\)\.optional\(\)\.describe\([^\n]*\),?\n/gm, "");
  source = source.replace(/^\s*allowHostControl: input\.allowHostControl === true,?\n/gm, "");
  source = source.replaceAll('title: "Start Isolated Computer Use"', 'title: "Select Desktop Interaction Mode"');
  source = source.replaceAll(
    'description: "Start a nested KDE/Wayland desktop dedicated to DevSpace Computer Use. Apps, screenshots, accessibility, clipboard, mouse, and keyboard operations then target that isolated desktop so the user can keep using their normal desktop. Windowed sessions can start visible or minimized in the background and can be shown/hidden later without stopping the work. True headless mode has no attachable viewer. If isolation cannot start, host fallback is allowed only when requested.",',
    'description: "Start a nested isolated KDE/Wayland desktop, or select the physical KDE desktop. Physical mode captures and interacts with the live desktop through supported KDE interfaces; mouse and keyboard events require XDG Desktop Portal permission. Input is never sent before permission is granted.",',
  );
  source = source.replaceAll(
    'description: "Start a nested isolated KDE/Wayland desktop, or select the physical KDE desktop for observation. Set allowHostFallback true for physical observation; set allowHostControl true as well to enable mouse and keyboard through KDE XDG Desktop Portal consent. Input defaults to the isolated desktop.",',
    'description: "Start a nested isolated KDE/Wayland desktop, or select the physical KDE desktop. Physical mode captures and interacts with the live desktop through supported KDE interfaces; mouse and keyboard events require XDG Desktop Portal permission. Input is never sent before permission is granted.",',
  );
  source = source.replaceAll("Move the pointer inside DevSpace's isolated Computer Use desktop. If needed, a headless isolated desktop is started automatically; this action never injects pointer input into the user's physical KDE desktop.", "Move the pointer in the selected Computer Use desktop. Physical desktop mode sends input through KDE's XDG Desktop Portal after permission is granted; isolated mode keeps input inside its nested desktop.");
  source = source.replaceAll("Click inside DevSpace's isolated Computer Use desktop. If needed, a headless isolated desktop is started automatically; this action never clicks the user's physical KDE desktop.", "Click in the selected Computer Use desktop. Physical desktop mode sends input through KDE's XDG Desktop Portal after permission is granted; isolated mode keeps input inside its nested desktop.");
  source = source.replaceAll("Scroll inside DevSpace's isolated Computer Use desktop. If needed, a headless isolated desktop is started automatically.", "Scroll in the selected Computer Use desktop. Physical desktop mode sends input through KDE's XDG Desktop Portal after permission is granted; isolated mode keeps input inside its nested desktop.");
  source = source.replaceAll("Type literal text into the focused control inside DevSpace's isolated Computer Use desktop. If needed, a headless isolated desktop is started automatically; host-desktop text injection is not used.", "Type literal text into the focused control in the selected Computer Use desktop. Physical desktop mode sends input through KDE's XDG Desktop Portal after permission is granted; isolated mode keeps input inside its nested desktop.");
  source = source.replaceAll("Press and release one named keyboard key with optional Ctrl/Shift/Alt/Meta modifiers inside DevSpace's isolated Computer Use desktop. If needed, a headless isolated desktop is started automatically.", "Press and release one named key in the selected Computer Use desktop. Physical desktop mode sends input through KDE's XDG Desktop Portal after permission is granted; isolated mode keeps input inside its nested desktop.");
  source = source.replaceAll("Capture a KDE/Wayland workspace, screen, active screen, window, active window, or rectangular area through the isolated Desktop Agent.", "Capture a KDE/Wayland workspace, screen, active screen, window, active window, or rectangular area through the currently selected Desktop Agent.");
  source = source.replaceAll("allowHostFallback: input.allowHostFallback ?? false,", "allowHostFallback: input.allowHostFallback,");
  const stopStart = source.indexOf('"computer_use_stop"');
  const stopEnd = source.indexOf('"agent_desktop_stop"', stopStart);
  if (stopStart >= 0 && stopEnd > stopStart) {
    const block = source.slice(stopStart, stopEnd).replace("computerUse.stop()", "computerUse.stop({ clearPhysicalSelection: true })");
    source = source.slice(0, stopStart) + block + source.slice(stopEnd);
    source = source.replaceAll("Stop Isolated Computer Use", "Stop Computer Use and clear the selected desktop mode");
  }
  return source;
}

function patchPhysicalDesktopDescription(source, filePath) {
  if (source.includes(DESCRIPTION_MARKER)) return source;
  const legacy = "Allow the legacy live-desktop path if the isolated compositor cannot start. Defaults to false for safe concurrent use.";
  const previous = "Select the physical KDE desktop for read-only observation. This selection persists until stopped or switched to isolated mode. Mouse and keyboard actions still use the isolated desktop.";
  if (source.includes(legacy)) return source.replace(legacy, DESCRIPTION);
  if (source.includes(previous)) return source.replace(previous, DESCRIPTION);
  throw new Error(`Could not locate physical desktop mode description in ${filePath}.`);
}

function patchSelectedDesktopClientRouting(source, filePath) {
  const marker = "DEVSPACE ROUTE DESKTOP TOOLS THROUGH SELECTED MODE";
  if (source.includes(marker)) return source;
  const before = "const interactionClient = await computerUse.interactionClient();";
  if (!source.includes(before)) throw new Error(`Could not locate desktop interaction client routing in ${filePath}.`);
  source = source.replaceAll(before, `/* ${marker} */\n        const interactionClient = await computerUse.desktopClient();`);
  source = source.replaceAll(
    "through the isolated Desktop Agent. Only text MIME types are returned",
    "through the selected Desktop Agent. Physical desktop mode uses the user's KDE session; isolated mode uses the nested desktop. Only text MIME types are returned",
  );
  source = source.replaceAll(
    "through the isolated Desktop Agent. Payloads are bounded",
    "through the selected Desktop Agent. Physical desktop mode uses the user's KDE session; isolated mode uses the nested desktop. Payloads are bounded",
  );
  return source;
}

function patchPhysicalInputRouting(source, filePath) {
  if (source.includes(PHYSICAL_CONTROL_MARKER)) {
    const methodStart = source.indexOf("async agentInput");
    const methodEnd = source.indexOf("takeUserControl(", methodStart);
    const markerPos = source.indexOf(PHYSICAL_CONTROL_MARKER, methodStart);
    if (methodStart >= 0 && markerPos > methodStart && markerPos < methodEnd) {
      source = source.replace(/if \(!this\.hostControlEnabled\) throw new Error\("Physical desktop input is disabled\. Start with allowHostFallback and allowHostControl explicitly enabled\."\);\n\s*/g, "");
      source = source.replace(/\s*this\.hostControlEnabled = options\.allowHostControl === true;\n/g, "\n");
      source = source.replace(/await this\.ensureIsolatedForInteraction\(\);\n\s*await this\.ensureIsolatedForInteraction\(\);/g, "await this.ensureIsolatedForInteraction();");
      return source;
    }
    source = source.replace(new RegExp(`\\s*/\\* ${PHYSICAL_CONTROL_MARKER} \\*/[\\s\\S]*?await this\\.ensureIsolatedForInteraction\\(\\);\\n`), "\n");
    source = source.replace(/await this\.ensureIsolatedForInteraction\(\);\n\s*await this\.ensureIsolatedForInteraction\(\);/, "await this.ensureIsolatedForInteraction();");
  }
  const before = "    async agentInput(request) {\n        await this.ensureIsolatedForInteraction();";
  const bundleBefore = "  async agentInput(request2) {\n    await this.ensureIsolatedForInteraction();";
  const hostBlock = `/* ${PHYSICAL_CONTROL_MARKER} */\n        const status = await this.refresh();\n        if (status.state === "ready" && status.mode === "host-fallback") {\n            if (this.owner !== "agent") throw new ComputerUseUserControlError();\n            this.writeIndicator("controlling");\n            try { return await this.hostClient.input(request); }\n            finally { this.writeIndicator("active"); }\n        }\n        await this.ensureIsolatedForInteraction();`;
  const needle = source.includes(before) ? before : bundleBefore;
  if (!source.includes(needle)) throw new Error(`Could not locate computer-use input routing in ${filePath}.`);
  const indent = source.includes(before) ? "        " : "    ";
  const parameter = source.includes(before) ? "request" : "request2";
  const indentedBlock = hostBlock
    .replaceAll("request", parameter)
    .split("\n")
    .map((line, index) => index === 0 ? line : `${indent}${line.trimStart()}`)
    .join("\n");
  const oldCall = `${indent}await this.ensureIsolatedForInteraction();`;
  const replacement = `${indent}${indentedBlock}`;
  const methodStart = source.indexOf("async agentInput");
  const methodEnd = source.indexOf("takeUserControl(", methodStart);
  if (methodStart < 0 || methodEnd < 0) throw new Error(`Could not isolate computer-use input method in ${filePath}.`);
  const method = source.slice(methodStart, methodEnd);
  if (!method.includes(oldCall)) throw new Error(`Could not locate isolated input route in ${filePath}.`);
  source = source.slice(0, methodStart) + method.replace(oldCall, replacement) + source.slice(methodEnd);
  const select = "DEVSPACE PHYSICAL MODE FOLLOWS PERSISTED SELECTION";
  const startIndex = source.indexOf("async start(options");
  const index = source.indexOf(select, startIndex);
  if (index < 0 && source.indexOf("if (options.allowHostFallback === true) {", startIndex) < 0) {
    throw new Error(`Could not locate physical desktop selection in ${filePath}.`);
  }
  return source.replace(/\s*this\.hostControlEnabled = options\.allowHostControl === true;\n/g, "\n");
}

function patchHostAgentClientTimeout(source, filePath) {
  const marker = "DEVSPACE PORTAL CONSENT REQUEST TIMEOUT";
  const before = "const hostClient = new DesktopAgentClient({ stateDir: config.stateDir });";
  const after = `/* ${marker} */\n    const hostClient = new DesktopAgentClient({ stateDir: config.stateDir, requestTimeoutMs: 150_000 });`;
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Could not locate physical desktop agent client timeout in ${filePath}.`);
  return source.replace(before, after);
}

function patchPhysicalDaemonProvider(source, filePath) {
  const before = "        this.inputProvider = options.input ?? createYdotoolInputProvider({ now: options.now });";
  const after = `        /* ${PHYSICAL_CONTROL_MARKER} */\n        const physicalAgent = !this.paths.stateDir.includes("/computer-use/");\n        process.env.DEVSPACE_PHYSICAL_INPUT = physicalAgent ? "1" : "0";\n        this.inputProvider = options.input ?? createYdotoolInputProvider({\n            now: options.now,\n            timeoutMs: physicalAgent ? 150_000 : undefined,\n            ...(physicalAgent ? { runYdotool: async () => { throw new Error("Physical desktop input requires the approved KDE XDG RemoteDesktop portal; global input fallback is disabled."); } } : {}),\n        });`;
  if (source.includes(PHYSICAL_CONTROL_MARKER)) {
    const old = `        /* ${PHYSICAL_CONTROL_MARKER} */\n        const physicalAgent = !this.paths.stateDir.includes("/computer-use/");\n        process.env.DEVSPACE_PHYSICAL_INPUT = physicalAgent ? "1" : "0";\n        this.inputProvider = options.input ?? createYdotoolInputProvider({ now: options.now, timeoutMs: physicalAgent ? 150_000 : undefined });`;
    return source.includes(old) ? source.replace(old, after) : source;
  }
  if (!source.includes(before)) throw new Error(`Could not locate desktop input provider setup in ${filePath}.`);
  return source.replace(before, after);
}

function patchPhysicalHelperPath(source, filePath) {
  if (source.includes(PHYSICAL_CONTROL_MARKER)) return source;
  const before = 'export function defaultEisInputHelperPath() {\n    const built = fileURLToPath(new URL("./bin/devspace-eis-input-helper.py", import.meta.url));';
  if (!source.includes(before)) throw new Error(`Could not locate default EIS helper path in ${filePath}.`);
  return source.replace(before, `export function defaultEisInputHelperPath() {\n    /* ${PHYSICAL_CONTROL_MARKER} */\n    if (process.env.DEVSPACE_PHYSICAL_INPUT === "1") {\n        const portal = fileURLToPath(new URL("./bin/devspace-xdg-portal-input.py", import.meta.url));\n        return existsSync(portal) ? portal : undefined;\n    }\n    const built = fileURLToPath(new URL("./bin/devspace-eis-input-helper.py", import.meta.url));`);
}

function replaceOnceOrAlreadyPatched(source, options) {
  if (source.includes(options.marker)) return source;
  const bundled = options.filePath.endsWith("hot-modules.mjs");
  const before = bundled ? options.bundleBefore : options.before;
  const after = bundled ? options.bundleAfter : options.after;

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
  process.stdout.write(`Repaired DevSpace desktop runtime (${result.patched.length} runtime modules) and the desktop tool description.\n`);
}
