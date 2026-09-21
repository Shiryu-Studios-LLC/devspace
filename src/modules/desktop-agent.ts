import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import * as z from "zod/v4";
import type { ServerConfig } from "../config.js";
import { assertAllowedPath } from "../roots.js";
import {
  DesktopAgentClient,
  DesktopAgentClientError,
} from "../desktop-agent-client.js";
import type {
  DesktopActivityTimeline,
  DesktopAgentStatus,
  DesktopAudioGraph,
  DesktopAudioRuntimeSnapshot,
  DesktopCapabilityStatus,
  DesktopPermissionStatus,
  DesktopDeviceInfo,
  DesktopDisplayInfo,
  DesktopNetworkSnapshot,
  DesktopVirtualDesktopSnapshot,
  DesktopNotificationInfo,
  DesktopLogReadResult,
  DesktopLogSource,
  DesktopTraceCorrelation,
  DesktopProcessInfo,
  DesktopScreenCapture,
  DesktopClipboardReadResult,
  DesktopClipboardWriteResult,
  DesktopAccessibilitySnapshot,
  DesktopFilesystemWatchInfo,
  DesktopWindowInfo,
} from "../desktop-agent-protocol.js";

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const inputAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const desktopInputOutputSchema = {
  status: z.enum(["ready", "error"]),
  result: z.string(),
  input: z.object({
    type: z.enum(["mouse-move", "mouse-click", "mouse-scroll", "type-text", "key-chord"]),
    completed: z.boolean(),
    completedAt: z.string(),
  }).optional(),
};

export function registerDesktopAgentTools(server: McpServer, config: ServerConfig): void {
  const client = new DesktopAgentClient({ stateDir: config.stateDir });

  registerAppTool(
    server,
    "desktop_agent_status",
    {
      title: "Desktop Agent Status",
      description:
        "Check the isolated DevSpace desktop agent without starting it. Returns unavailable when it is not running.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "stopping", "unavailable", "error"]),
        result: z.string(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const status = await client.status();
        if (!status) return statusResponse("unavailable", "Desktop agent is not running.");
        return statusResponse(status.state, describeStatus(status), status);
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_agent_capabilities",
    {
      title: "Desktop Agent Capabilities",
      description:
        "Start the isolated desktop agent if needed and report its current capability states. This does not enable screen capture, input control, or other permissions.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        capabilities: z.array(z.object({
          id: z.string(),
          state: z.enum(["ready", "unavailable", "disabled", "not_implemented"]),
          detail: z.string().optional(),
        })).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const status = await client.ensureReady();
        const capabilities = await client.capabilities();
        const result = formatCapabilities(status, capabilities);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, capabilities },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_agent_permissions",
    {
      title: "Desktop Agent Permissions",
      description:
        "Start the isolated desktop agent if needed and report its effective per-capability permission policy. This is read-only and does not change permissions.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        permissions: z.array(z.object({
          id: z.string(),
          granted: z.boolean(),
          defaultGranted: z.boolean(),
        })).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const permissions = await client.permissions();
        const result = formatPermissions(permissions);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, permissions },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_list_windows",
    {
      title: "List Desktop Windows",
      description:
        "List currently known KDE/KWin windows from the isolated desktop agent, including application identity, process identity, geometry, desktop membership, and window state. Read-only.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        windows: z.array(z.object({
          id: z.string(),
          uuid: z.string(),
          title: z.string(),
          pid: z.number().int().optional(),
          processName: z.string().optional(),
          executable: z.string().optional(),
          applicationId: z.string().optional(),
          desktopFile: z.string().optional(),
          resourceClass: z.string().optional(),
          resourceName: z.string().optional(),
          role: z.string().optional(),
          clientMachine: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
          minimized: z.boolean(),
          fullscreen: z.boolean(),
          maximizedHorizontal: z.boolean(),
          maximizedVertical: z.boolean(),
          keepAbove: z.boolean(),
          keepBelow: z.boolean(),
          skipTaskbar: z.boolean(),
          skipPager: z.boolean(),
          skipSwitcher: z.boolean(),
          noBorder: z.boolean(),
          excludeFromCapture: z.boolean(),
          desktops: z.array(z.string()),
          activities: z.array(z.string()),
        })).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const windows = await client.windows();
        const result = formatWindowSummary(windows);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, windows },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_list_displays",
    {
      title: "List Desktop Displays",
      description:
        "List KDE/KScreen displays from the isolated desktop agent, including layout, current mode, refresh rate, scale, rotation, brightness, physical size, priority, and active/primary status. Read-only.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        displays: z.array(z.object({
          id: z.number().int(),
          name: z.string(),
          connected: z.boolean(),
          enabled: z.boolean(),
          active: z.boolean(),
          primary: z.boolean(),
          priority: z.number().int(),
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
          scale: z.number(),
          rotation: z.number().int(),
          brightness: z.number().optional(),
          ddcCiAllowed: z.boolean().optional(),
          physicalWidthMm: z.number().optional(),
          physicalHeightMm: z.number().optional(),
          currentModeId: z.string().optional(),
          currentMode: z.object({
            id: z.string(),
            name: z.string(),
            width: z.number(),
            height: z.number(),
            refreshRate: z.number().optional(),
          }).optional(),
          preferredModeIds: z.array(z.string()),
          modes: z.array(z.object({
            id: z.string(),
            name: z.string(),
            width: z.number(),
            height: z.number(),
            refreshRate: z.number().optional(),
          })),
          clones: z.array(z.number().int()),
          replicationSource: z.number().int().optional(),
          connectorType: z.number().int().optional(),
        })).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const displays = await client.displays();
        const result = formatDisplaySummary(displays);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, displays },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_list_processes",
    {
      title: "List Desktop Processes",
      description:
        "List Linux processes visible to the isolated desktop agent, including PID/parent/UID, process state, executable when readable, thread and memory basics, and associated desktop windows. Command-line arguments and environment variables are intentionally excluded.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        processes: z.array(z.object({
          pid: z.number().int(),
          ppid: z.number().int(),
          uid: z.number().int().optional(),
          sameUser: z.boolean().optional(),
          name: z.string(),
          state: z.string(),
          executable: z.string().optional(),
          threads: z.number().int().optional(),
          residentMemoryBytes: z.number().int().nonnegative().optional(),
          virtualMemoryBytes: z.number().int().nonnegative().optional(),
          windowIds: z.array(z.string()),
          windowCount: z.number().int().nonnegative(),
          hasWindow: z.boolean(),
        })).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const processes = await client.processes();
        const result = formatProcessSummary(processes);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, processes },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_capture_screen",
    {
      title: "Capture Desktop Screen",
      description:
        "Capture a KDE/Wayland workspace, screen, active screen, window, active window, or rectangular area through the isolated Desktop Agent. The PNG is returned once as MCP image content and the private temporary capture file is deleted immediately afterward.",
      inputSchema: {
        target: z.enum(["workspace", "active-screen", "screen", "active-window", "window", "area"]),
        screen: z.string().min(1).optional(),
        windowId: z.string().min(1).optional(),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        includeCursor: z.boolean().optional(),
        includeDecoration: z.boolean().optional(),
        includeShadow: z.boolean().optional(),
        nativeResolution: z.boolean().optional(),
        hideCallerWindows: z.boolean().optional(),
      },
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        capture: z.object({
          mimeType: z.literal("image/png"),
          target: z.enum(["workspace", "active-screen", "screen", "active-window", "window", "area"]),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          scale: z.number().positive(),
          capturedAt: z.string(),
          screen: z.string().optional(),
          windowId: z.string().optional(),
          x: z.number().int().optional(),
          y: z.number().int().optional(),
          bytes: z.number().int().positive(),
        }).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async (input) => {
      let capture: DesktopScreenCapture | undefined;
      let capturePath: string | undefined;
      try {
        capture = await client.captureScreen(input);
        capturePath = validatePrivateCapturePath(config.stateDir, capture.path);
        const info = await stat(capturePath);
        const maxBytes = 64 * 1024 * 1024;
        if (!info.isFile() || info.size <= 0 || info.size > maxBytes) {
          throw new Error(`Desktop screenshot PNG has invalid size: ${info.size}.`);
        }
        const data = await readFile(capturePath);
        const metadata = {
          mimeType: capture.mimeType,
          target: capture.target,
          width: capture.width,
          height: capture.height,
          scale: capture.scale,
          capturedAt: capture.capturedAt,
          ...(capture.screen ? { screen: capture.screen } : {}),
          ...(capture.windowId ? { windowId: capture.windowId } : {}),
          ...(capture.x === undefined ? {} : { x: capture.x }),
          ...(capture.y === undefined ? {} : { y: capture.y }),
          bytes: data.byteLength,
        };
        const result = formatScreenCaptureSummary(metadata);
        return {
          content: [
            { type: "text" as const, text: result },
            { type: "image" as const, data: data.toString("base64"), mimeType: "image/png" as const },
          ],
          structuredContent: { status: "ready" as const, result, capture: metadata },
        };
      } catch (error) {
        return clientErrorResponse(error);
      } finally {
        if (capturePath) await rm(capturePath, { force: true }).catch(() => undefined);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_clipboard_read",
    {
      title: "Read Desktop Clipboard",
      description:
        "Read the current Wayland text clipboard through the isolated Desktop Agent. Only text MIME types are returned and payloads are bounded to 1 MiB.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        clipboard: z.object({
          available: z.boolean(),
          text: z.string().optional(),
          mimeType: z.string().optional(),
          bytes: z.number().int().nonnegative().optional(),
          readAt: z.string(),
        }).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const clipboard = await client.readClipboard();
        const result = formatClipboardReadSummary(clipboard);
        return {
          content: [{ type: "text" as const, text: clipboard.available ? `${result}\n\n${clipboard.text ?? ""}` : result }],
          structuredContent: { status: "ready" as const, result, clipboard },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_clipboard_write",
    {
      title: "Write Desktop Clipboard",
      description:
        "Replace the current Wayland clipboard with UTF-8 text through the isolated Desktop Agent. Payloads are bounded to 1 MiB.",
      inputSchema: {
        text: z.string().max(1024 * 1024),
      },
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        clipboard: z.object({
          bytes: z.number().int().nonnegative(),
          mimeType: z.string(),
          writtenAt: z.string(),
        }).optional(),
      },
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ text }) => {
      try {
        const clipboard = await client.writeClipboard(text);
        const result = formatClipboardWriteSummary(clipboard);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, clipboard },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_accessibility_snapshot",
    {
      title: "Desktop Accessibility Snapshot",
      description:
        "Read a bounded AT-SPI semantic accessibility tree from the Linux desktop. Returns structural labels, roles, states, bounds, interfaces, and available action metadata; it does not read editable/text contents and does not execute actions.",
      inputSchema: {
        application: z.string().min(1).optional(),
        maxDepth: z.number().int().min(0).max(8).optional(),
        maxNodes: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        snapshot: z.object({
          generatedAt: z.string(),
          applicationCount: z.number().int().nonnegative(),
          nodeCount: z.number().int().nonnegative(),
          truncated: z.boolean(),
          maxDepth: z.number().int().nonnegative(),
          maxNodes: z.number().int().positive(),
          nodes: z.array(z.object({
            id: z.string(),
            parentId: z.string().optional(),
            depth: z.number().int().nonnegative(),
            application: z.string(),
            accessibleId: z.string(),
            processId: z.number().int().nonnegative(),
            name: z.string(),
            description: z.string(),
            role: z.string(),
            localizedRole: z.string(),
            childCount: z.number().int().nonnegative(),
            states: z.array(z.string()),
            interfaces: z.array(z.string()),
            actions: z.array(z.object({
              index: z.number().int().nonnegative(),
              name: z.string(),
              description: z.string(),
              keyBinding: z.string(),
            })),
            bounds: z.object({
              x: z.number().int(),
              y: z.number().int(),
              width: z.number().int(),
              height: z.number().int(),
            }).optional(),
            attributes: z.record(z.string(), z.string()).optional(),
          })),
        }).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async ({ application, maxDepth, maxNodes }) => {
      try {
        const snapshot = await client.accessibilitySnapshot({ application, maxDepth, maxNodes });
        const result = formatAccessibilitySummary(snapshot);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, snapshot },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_accessibility_action",
    {
      title: "Desktop Accessibility Action",
      description:
        "Invoke one semantic AT-SPI action on a node from a recent desktop_accessibility_snapshot. The target is resolved by pid-based semantic path and must still match the expected role/name (and accessible ID when supplied), so stale targets fail instead of acting on a different control.",
      inputSchema: {
        nodeId: z.string().regex(/^pid-\d+(?:\.\d+)*$/),
        actionIndex: z.number().int().min(0).max(63),
        expectedRole: z.string().min(1),
        expectedName: z.string(),
        expectedAccessibleId: z.string().min(1).optional(),
      },
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        action: z.object({
          performed: z.boolean(),
          nodeId: z.string(),
          actionIndex: z.number().int().nonnegative(),
          actionName: z.string(),
          performedAt: z.string(),
        }).optional(),
      },
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const action = await client.accessibilityAction(input);
        const result = formatAccessibilityActionSummary(action);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, action },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_mouse_move",
    {
      title: "Move Desktop Mouse",
      description: "Move the Wayland pointer through DevSpace's validated user-scoped input provider. Relative coordinates are limited to ±32768; absolute coordinates are limited to 0..100000.",
      inputSchema: {
        mode: z.enum(["relative", "absolute"]),
        x: z.number().int(),
        y: z.number().int(),
      },
      outputSchema: desktopInputOutputSchema,
      _meta: {},
      annotations: inputAnnotations,
    },
    async ({ mode, x, y }) => {
      try {
        const input = await client.input({ type: "mouse-move", mode, x, y });
        const result = formatInputSummary(input);
        return { content: [{ type: "text" as const, text: result }], structuredContent: { status: "ready" as const, result, input } };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_mouse_click",
    {
      title: "Click Desktop Mouse",
      description: "Click the left, right, or middle mouse button through DevSpace's validated user-scoped Wayland input provider.",
      inputSchema: {
        button: z.enum(["left", "right", "middle"]),
        count: z.number().int().min(1).max(10).optional(),
        nextDelayMs: z.number().int().min(0).max(1000).optional(),
      },
      outputSchema: desktopInputOutputSchema,
      _meta: {},
      annotations: inputAnnotations,
    },
    async ({ button, count, nextDelayMs }) => {
      try {
        const input = await client.input({ type: "mouse-click", button, count, nextDelayMs });
        const result = formatInputSummary(input);
        return { content: [{ type: "text" as const, text: result }], structuredContent: { status: "ready" as const, result, input } };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_mouse_scroll",
    {
      title: "Scroll Desktop Mouse",
      description: "Scroll the Wayland pointer wheel through DevSpace's validated input provider. Values are bounded to -120..120 per axis.",
      inputSchema: {
        x: z.number().int().min(-120).max(120).optional(),
        y: z.number().int().min(-120).max(120),
      },
      outputSchema: desktopInputOutputSchema,
      _meta: {},
      annotations: inputAnnotations,
    },
    async ({ x, y }) => {
      try {
        const input = await client.input({ type: "mouse-scroll", x, y });
        const result = formatInputSummary(input);
        return { content: [{ type: "text" as const, text: result }], structuredContent: { status: "ready" as const, result, input } };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_type_text",
    {
      title: "Type Desktop Text",
      description: "Type literal text into the currently focused desktop control through DevSpace's validated input provider. Text is limited to 16384 characters and is passed directly to ydotool without shell interpretation.",
      inputSchema: {
        text: z.string().max(16_384),
        keyDelayMs: z.number().int().min(0).max(1000).optional(),
        keyHoldMs: z.number().int().min(0).max(1000).optional(),
      },
      outputSchema: desktopInputOutputSchema,
      _meta: {},
      annotations: inputAnnotations,
    },
    async ({ text, keyDelayMs, keyHoldMs }) => {
      try {
        const input = await client.input({ type: "type-text", text, keyDelayMs, keyHoldMs });
        const result = formatInputSummary(input);
        return { content: [{ type: "text" as const, text: result }], structuredContent: { status: "ready" as const, result, input } };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_key_chord",
    {
      title: "Press Desktop Key Chord",
      description: "Press and release one named keyboard key with optional Ctrl/Shift/Alt/Meta modifiers through the validated Wayland input provider.",
      inputSchema: {
        key: z.enum(["a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t","u","v","w","x","y","z","0","1","2","3","4","5","6","7","8","9","enter","escape","tab","backspace","space","delete","insert","left","right","up","down","home","end","pageup","pagedown","f1","f2","f3","f4","f5","f6","f7","f8","f9","f10","f11","f12"]),
        modifiers: z.array(z.enum(["ctrl", "shift", "alt", "meta"])).max(4).optional(),
        keyDelayMs: z.number().int().min(0).max(1000).optional(),
      },
      outputSchema: desktopInputOutputSchema,
      _meta: {},
      annotations: inputAnnotations,
    },
    async ({ key, modifiers, keyDelayMs }) => {
      try {
        const input = await client.input({ type: "key-chord", key, modifiers, keyDelayMs });
        const result = formatInputSummary(input);
        return { content: [{ type: "text" as const, text: result }], structuredContent: { status: "ready" as const, result, input } };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_recent_activity",
    {
      title: "Recent Desktop Activity",
      description:
        "Read the isolated desktop agent's bounded in-memory activity timeline for recent process, window, display, virtual-desktop, PipeWire audio, hardware-device, network-state, and desktop-notification changes. The cursor is monotonically increasing while the agent is running, so callers can remember a cursor before an action and compare later events. No keystrokes, screenshots, packet contents, command-line arguments, environment contents, raw hardware serials, or Bluetooth addresses are recorded.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        cursor: z.number().int().nonnegative().optional(),
        events: z.array(z.object({
          sequence: z.number().int().positive(),
          timestamp: z.string(),
          type: z.enum([
            "process.started",
            "process.stopped",
            "window.created",
            "window.closed",
            "window.changed",
            "window.focused",
            "filesystem.created",
            "filesystem.changed",
            "filesystem.deleted",
            "display.connected",
            "display.disconnected",
            "display.changed",
            "audio.stream.started",
            "audio.stream.stopped",
            "audio.stream.changed",
            "audio.route.created",
            "audio.route.removed",
            "audio.route.changed",
            "device.connected",
            "device.disconnected",
            "device.changed",
            "network.interface.changed",
            "network.route.changed",
            "network.dns.changed",
            "network.listener.opened",
            "network.listener.closed",
            "network.tunnel.started",
            "network.tunnel.stopped",
            "notification.created",
            "notification.closed",
            "virtual-desktop.created",
            "virtual-desktop.removed",
            "virtual-desktop.changed",
            "virtual-desktop.current.changed",
          ]),
          sourceModule: z.enum(["processes", "windows", "accessibility", "filesystem", "displays", "audio", "devices", "network", "notifications", "virtual-desktops"]),
          entityId: z.string(),
          correlationId: z.string(),
          applicationId: z.string().optional(),
          pid: z.number().int().optional(),
          title: z.string().optional(),
          summary: z.string(),
        })).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const activity = await client.recentActivity();
        const result = formatActivitySummary(activity);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: {
            status: "ready" as const,
            result,
            cursor: activity.cursor,
            events: activity.events,
          },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_audio_graph",
    {
      title: "Desktop Audio Graph",
      description:
        "Read the current PipeWire audio graph from the isolated desktop agent: audio devices/endpoints, application streams, channel ports, and routing links. Read-only; this does not change routes, volume, mute, or devices.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        graph: z.object({
          generatedAt: z.string(),
          nodes: z.array(z.object({
            id: z.number().int(),
            name: z.string(),
            mediaClass: z.string(),
            state: z.string().optional(),
            nick: z.string().optional(),
            description: z.string().optional(),
            applicationName: z.string().optional(),
            applicationBinary: z.string().optional(),
            pid: z.number().int().optional(),
            clientId: z.number().int().optional(),
            deviceId: z.number().int().optional(),
            mediaName: z.string().optional(),
            targetObject: z.string().optional(),
            sampleRate: z.number().int().optional(),
            latency: z.string().optional(),
            volume: z.number().optional(),
            mute: z.boolean().optional(),
            channelVolumes: z.array(z.number()).optional(),
            channelMap: z.array(z.string()).optional(),
            softMute: z.boolean().optional(),
            softVolumes: z.array(z.number()).optional(),
            monitorMute: z.boolean().optional(),
            monitorVolumes: z.array(z.number()).optional(),
            audioFormat: z.string().optional(),
            channels: z.number().int().optional(),
            streamLive: z.boolean().optional(),
            corked: z.boolean().optional(),
            processLatencyQuantum: z.number().optional(),
            processLatencyRate: z.number().int().optional(),
            processLatencyNs: z.number().int().optional(),
            isStream: z.boolean(),
            isSink: z.boolean(),
            isSource: z.boolean(),
          })),
          ports: z.array(z.object({
            id: z.number().int(),
            nodeId: z.number().int(),
            name: z.string(),
            direction: z.enum(["in", "out"]),
            alias: z.string().optional(),
            channel: z.string().optional(),
          })),
          links: z.array(z.object({
            id: z.number().int(),
            state: z.string(),
            outputNodeId: z.number().int(),
            outputPortId: z.number().int(),
            inputNodeId: z.number().int(),
            inputPortId: z.number().int(),
            outputNodeName: z.string(),
            inputNodeName: z.string(),
            outputPortName: z.string().optional(),
            inputPortName: z.string().optional(),
          })),
        }).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const graph = await client.audioGraph();
        const result = formatAudioSummary(graph);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, graph },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_audio_runtime",
    {
      title: "Desktop Audio Runtime",
      description:
        "Sample PipeWire runtime scheduling telemetry on demand using pw-top. Returns node quantum/rate, wait/busy timing, error/xrun counts, and active audio format without capturing audio samples or changing routes/devices.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        runtime: z.object({
          generatedAt: z.string(),
          samplingIterations: z.number().int(),
          nodes: z.array(z.object({
            id: z.number().int(),
            stateCode: z.string(),
            running: z.boolean(),
            quantum: z.number().int(),
            rate: z.number().int(),
            waitUsec: z.number().optional(),
            busyUsec: z.number().optional(),
            waitRatio: z.number().optional(),
            busyRatio: z.number().optional(),
            errors: z.number().int(),
            audioFormat: z.string().optional(),
            channels: z.number().int().optional(),
            formatRate: z.number().int().optional(),
            name: z.string(),
          })),
        }).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const runtime = await client.audioRuntime();
        const result = formatAudioRuntimeSummary(runtime);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, runtime },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_list_devices",
    {
      title: "List Desktop Devices",
      description:
        "List read-only Linux hardware/device inventory from the isolated desktop agent, including USB, PCI/PCIe, block storage, and Bluetooth devices. Raw serial numbers and Bluetooth addresses are intentionally excluded.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        devices: z.array(z.object({
          id: z.string(),
          subsystem: z.enum(["usb", "pci", "block", "bluetooth"]),
          category: z.string(),
          name: z.string(),
          vendor: z.string().optional(),
          model: z.string().optional(),
          vendorId: z.string().optional(),
          productId: z.string().optional(),
          classCode: z.string().optional(),
          driver: z.string().optional(),
          path: z.string().optional(),
          transport: z.string().optional(),
          speed: z.string().optional(),
          connected: z.boolean(),
          hotplug: z.boolean().optional(),
          removable: z.boolean().optional(),
          paired: z.boolean().optional(),
          sizeBytes: z.number().int().nonnegative().optional(),
          parentId: z.string().optional(),
          mountpoints: z.array(z.string()),
        })).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const devices = await client.devices();
        const result = formatDeviceSummary(devices);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, devices },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_network_snapshot",
    {
      title: "Desktop Network Snapshot",
      description:
        "Read the current Linux network state from the isolated desktop agent: interfaces/addresses, routes, DNS servers, listening TCP/UDP sockets, and whether Cloudflare Tunnel is running. Read-only; no packet capture or traffic contents are collected.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        network: z.object({
          generatedAt: z.string(),
          interfaces: z.array(z.object({
            index: z.number().int(),
            name: z.string(),
            kind: z.string(),
            linkType: z.string().optional(),
            operState: z.string(),
            mtu: z.number().int().optional(),
            up: z.boolean(),
            lowerUp: z.boolean(),
            loopback: z.boolean(),
            addresses: z.array(z.object({
              family: z.enum(["ipv4", "ipv6"]),
              address: z.string(),
              prefixLength: z.number().int(),
              scope: z.string().optional(),
              dynamic: z.boolean().optional(),
            })),
          })),
          routes: z.array(z.object({
            family: z.enum(["ipv4", "ipv6"]),
            destination: z.string(),
            gateway: z.string().optional(),
            interfaceName: z.string().optional(),
            table: z.union([z.string(), z.number()]).optional(),
            protocol: z.string().optional(),
            scope: z.string().optional(),
            preferredSource: z.string().optional(),
            metric: z.number().int().optional(),
            type: z.string().optional(),
            linkDown: z.boolean(),
          })),
          dnsServers: z.array(z.object({
            interfaceName: z.string().optional(),
            address: z.string(),
          })),
          listeners: z.array(z.object({
            protocol: z.enum(["tcp", "udp"]),
            address: z.string(),
            port: z.number().int().nonnegative(),
            interfaceName: z.string().optional(),
            processName: z.string().optional(),
            pid: z.number().int().optional(),
          })),
          cloudflareTunnel: z.object({
            running: z.boolean(),
            pids: z.array(z.number().int()),
          }),
        }).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const network = await client.networkSnapshot();
        const result = formatNetworkSummary(network);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, network },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_virtual_desktops",
    {
      title: "Desktop Virtual Desktops",
      description:
        "Read KDE virtual desktop state from the isolated desktop agent, including desktop IDs/names/order and which desktop is current. Read-only; this does not switch, create, rename, or remove desktops.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        virtualDesktops: z.object({
          generatedAt: z.string(),
          currentId: z.string(),
          count: z.number().int().nonnegative(),
          rows: z.number().int().positive(),
          navigationWrappingAround: z.boolean(),
          desktops: z.array(z.object({
            position: z.number().int().nonnegative(),
            id: z.string(),
            name: z.string(),
            current: z.boolean(),
          })),
        }).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const virtualDesktops = await client.virtualDesktops();
        const result = formatVirtualDesktopSummary(virtualDesktops);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, virtualDesktops },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_log_sources",
    {
      title: "Desktop Log Sources",
      description:
        "List recent Linux user-journal sources known to the isolated desktop agent without reading their message contents. Sources are represented by opaque IDs for explicit bounded reads.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        sources: z.array(z.object({
          id: z.string(),
          kind: z.literal("journal"),
          label: z.string(),
          selector: z.string(),
          lastSeen: z.string().optional(),
          sampledEntries: z.number().int().nonnegative(),
        })).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const sources = await client.logSources();
        const result = formatLogSourceSummary(sources);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, sources },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_read_logs",
    {
      title: "Read Desktop Logs",
      description:
        "Read a bounded number of messages from one explicit opaque log source returned by desktop_log_sources. Optional query performs case-insensitive message filtering. This cannot read arbitrary filesystem paths.",
      inputSchema: {
        sourceId: z.string().min(1),
        lines: z.number().int().min(1).max(500).optional(),
        query: z.string().min(1).max(256).optional(),
      },
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        logs: z.object({
          sourceId: z.string(),
          generatedAt: z.string(),
          query: z.string().optional(),
          entries: z.array(z.object({
            timestamp: z.string(),
            priority: z.number().int().optional(),
            unit: z.string().optional(),
            identifier: z.string().optional(),
            processName: z.string().optional(),
            pid: z.number().int().optional(),
            message: z.string(),
          })),
        }).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async ({ sourceId, lines, query }) => {
      try {
        const logs = await client.readLogs(sourceId, { lines, query });
        const result = formatLogReadSummary(logs);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, logs },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_recent_notifications",
    {
      title: "Recent Desktop Notifications",
      description:
        "Read notifications passively observed by the isolated desktop agent since it started. Results are bounded and in memory only. This does not dismiss notifications, invoke actions, or capture notification image payloads.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        notifications: z.array(z.object({
          id: z.string(),
          notificationId: z.number().int().optional(),
          replacesId: z.number().int().optional(),
          appName: z.string(),
          summary: z.string(),
          body: z.string(),
          pid: z.number().int().optional(),
          desktopEntry: z.string().optional(),
          category: z.string().optional(),
          urgency: z.number().int().optional(),
          actions: z.array(z.object({ id: z.string(), label: z.string() })),
          expireTimeoutMs: z.number().int(),
          createdAt: z.string(),
          closedAt: z.string().optional(),
          closeReason: z.number().int().optional(),
        })).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const notifications = await client.notifications();
        const result = formatNotificationSummary(notifications);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, notifications },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_dismiss_notification",
    {
      title: "Dismiss Desktop Notification",
      description:
        "Dismiss one still-open notification that this Desktop Agent actually observed. The id must come from desktop_recent_notifications; arbitrary Plasma notification IDs are not accepted.",
      inputSchema: {
        id: z.string().min(1).max(512),
      },
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        control: z.object({
          type: z.literal("dismiss"),
          id: z.string(),
          notificationId: z.number().int().nonnegative(),
          completed: z.boolean(),
          completedAt: z.string(),
        }).optional(),
      },
      _meta: {},
      annotations: inputAnnotations,
    },
    async ({ id }) => {
      try {
        const control = await client.notificationControl({ type: "dismiss", id });
        const result = `Dismissed observed notification ${control.id}.`;
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, control },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_invoke_notification_action",
    {
      title: "Invoke Desktop Notification Action",
      description:
        "Invoke one action button advertised by a still-open notification that this Desktop Agent observed. Both the notification id and actionId must come from desktop_recent_notifications.",
      inputSchema: {
        id: z.string().min(1).max(512),
        actionId: z.string().min(1).max(256),
      },
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        control: z.object({
          type: z.literal("invoke-action"),
          id: z.string(),
          notificationId: z.number().int().nonnegative(),
          actionId: z.string(),
          completed: z.boolean(),
          completedAt: z.string(),
        }).optional(),
      },
      _meta: {},
      annotations: inputAnnotations,
    },
    async ({ id, actionId }) => {
      try {
        const control = await client.notificationControl({ type: "invoke-action", id, actionId });
        const result = `Invoked notification action ${JSON.stringify(control.actionId)} for ${control.id}.`;
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, control },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_list_filesystem_watches",
    {
      title: "List Desktop Filesystem Watches",
      description:
        "List active explicit filesystem watchers. Watches are limited to configured DevSpace allowed roots and report path metadata only; file contents are never read.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        watches: z.array(filesystemWatchSchema()).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async () => {
      try {
        const watches = await client.filesystemWatches();
        const result = `${watches.length} active filesystem watch${watches.length === 1 ? "" : "es"}.`;
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, watches },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_watch_filesystem",
    {
      title: "Watch Filesystem Path",
      description:
        "Start an explicit metadata-only filesystem watcher for an existing path inside configured DevSpace allowed roots. Recursive watching is opt-in. Create/change/delete events are added to the bounded desktop activity timeline; file contents are never read.",
      inputSchema: {
        path: z.string().min(1),
        recursive: z.boolean().optional(),
      },
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        watch: filesystemWatchSchema().optional(),
      },
      _meta: {},
      annotations: inputAnnotations,
    },
    async ({ path, recursive }) => {
      try {
        const safePath = assertAllowedPath(path, config.allowedRoots);
        const watch = await client.startFilesystemWatch(safePath, recursive ?? false);
        const result = `Watching ${watch.path}${watch.recursive ? " recursively" : ""}; watch id ${watch.id}.`;
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, watch },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_unwatch_filesystem",
    {
      title: "Stop Filesystem Watch",
      description: "Stop one active filesystem watcher by the id returned from desktop_watch_filesystem or desktop_list_filesystem_watches.",
      inputSchema: {
        id: z.string().min(1).max(128),
      },
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        watch: filesystemWatchSchema().optional(),
      },
      _meta: {},
      annotations: inputAnnotations,
    },
    async ({ id }) => {
      try {
        const watch = await client.stopFilesystemWatch(id);
        const result = `Stopped filesystem watch ${watch.id} for ${watch.path}.`;
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, watch },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_trace_correlation",
    {
      title: "Desktop Trace Correlation",
      description:
        "Correlate one desktop activity correlation ID with recent bounded activity events and, for pid:<pid> IDs, recent Linux user-journal messages from that same PID. Optional query filters only the log-message portion. No unrelated journal sources or arbitrary file paths are read.",
      inputSchema: {
        correlationId: z.string().min(1).max(256),
        lines: z.number().int().min(1).max(500).optional(),
        query: z.string().min(1).max(256).optional(),
      },
      outputSchema: {
        status: z.enum(["ready", "error"]),
        result: z.string(),
        trace: z.object({
          correlationId: z.string(),
          generatedAt: z.string(),
          events: z.array(z.object({
            sequence: z.number().int(),
            timestamp: z.string(),
            type: z.string(),
            sourceModule: z.string(),
            entityId: z.string(),
            correlationId: z.string(),
            applicationId: z.string().optional(),
            pid: z.number().int().optional(),
            title: z.string().optional(),
            summary: z.string(),
          })),
          logs: z.object({
            sourceId: z.string(),
            generatedAt: z.string(),
            query: z.string().optional(),
            entries: z.array(z.object({
              timestamp: z.string(),
              priority: z.number().int().optional(),
              unit: z.string().optional(),
              identifier: z.string().optional(),
              processName: z.string().optional(),
              pid: z.number().int().optional(),
              message: z.string(),
            })),
          }).optional(),
        }).optional(),
      },
      _meta: {},
      annotations: readAnnotations,
    },
    async ({ correlationId, lines, query }) => {
      try {
        const trace = await client.traceCorrelation(correlationId, { lines, query });
        const result = formatTraceSummary(trace);
        return {
          content: [{ type: "text" as const, text: result }],
          structuredContent: { status: "ready" as const, result, trace },
        };
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );

  registerAppTool(
    server,
    "desktop_agent_stop",
    {
      title: "Stop Desktop Agent",
      description:
        "Stop the isolated DevSpace desktop agent. DevSpace core remains running.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["stopping", "unavailable", "error"]),
        result: z.string(),
      },
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const status = await client.stop();
        if (!status) return statusResponse("unavailable", "Desktop agent is not running.");
        return statusResponse("stopping", "Desktop agent is stopping.", status);
      } catch (error) {
        return clientErrorResponse(error);
      }
    },
  );
}

function statusResponse(
  status: "ready" | "stopping" | "unavailable",
  result: string,
  agent?: DesktopAgentStatus,
) {
  return {
    content: [{ type: "text" as const, text: result }],
    structuredContent: { status, result, ...(agent ? { agent } : {}) },
  };
}

function clientErrorResponse(error: unknown) {
  const clientError = error instanceof DesktopAgentClientError
    ? error
    : new DesktopAgentClientError(
        "DESKTOP_AGENT_ERROR",
        error instanceof Error ? error.message : String(error),
      );
  const result = `${clientError.code}: ${clientError.message}`;
  return {
    content: [{ type: "text" as const, text: result }],
    structuredContent: { status: "error" as const, result },
    isError: true,
  };
}

function validatePrivateCapturePath(stateDir: string, path: string): string {
  const captureDir = resolve(stateDir, "desktop-agent", "captures");
  const candidate = resolve(path);
  const relativePath = relative(captureDir, candidate);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Desktop agent returned a screenshot path outside its private capture directory.");
  }
  return candidate;
}

function formatScreenCaptureSummary(capture: {
  target: string;
  width: number;
  height: number;
  scale: number;
  bytes: number;
}): string {
  return `Captured ${capture.target} as ${capture.width}×${capture.height} PNG at scale ${capture.scale}; ${capture.bytes} byte(s).`;
}

function describeStatus(status: DesktopAgentStatus): string {
  return [
    `Desktop agent ${status.state}`,
    `pid ${status.pid}`,
    `platform ${status.platform}`,
    `session ${status.sessionType}`,
    `protocol ${status.protocolVersion}`,
  ].join("; ");
}

function filesystemWatchSchema() {
  return z.object({
    id: z.string(),
    path: z.string(),
    recursive: z.boolean(),
    startedAt: z.string(),
    eventCount: z.number().int().nonnegative(),
    lastEventAt: z.string().optional(),
    state: z.enum(["ready", "failed"]),
    error: z.string().optional(),
  });
}

function formatAccessibilitySummary(snapshot: DesktopAccessibilitySnapshot): string {
  const focused = snapshot.nodes.filter((node) => node.states.includes("focused"));
  const actionable = snapshot.nodes.filter((node) => node.actions.length > 0);
  return `AT-SPI snapshot: ${snapshot.applicationCount} application(s), ${snapshot.nodeCount} node(s), ${focused.length} focused node(s), ${actionable.length} node(s) with semantic actions${snapshot.truncated ? "; truncated by requested bounds" : ""}.`;
}

function formatAccessibilityActionSummary(action: { performed: boolean; actionName: string; nodeId: string }): string {
  return `${action.performed ? "Performed" : "AT-SPI declined"} semantic action ${JSON.stringify(action.actionName)} on ${action.nodeId}.`;
}

function formatInputSummary(input: { type: string; completed: boolean }): string {
  return `${input.completed ? "Completed" : "Did not complete"} desktop input action ${input.type}.`;
}

function formatClipboardReadSummary(clipboard: DesktopClipboardReadResult): string {
  if (!clipboard.available) return "Wayland clipboard does not currently contain a supported text format.";
  return `Read ${clipboard.bytes ?? 0} clipboard byte(s) as ${clipboard.mimeType ?? "text"}.`;
}

function formatClipboardWriteSummary(clipboard: DesktopClipboardWriteResult): string {
  return `Wrote ${clipboard.bytes} clipboard byte(s) as ${clipboard.mimeType}.`;
}

function formatNotificationSummary(notifications: DesktopNotificationInfo[]): string {
  const open = notifications.filter((notification) => !notification.closedAt).length;
  return `Desktop agent observed ${notifications.length} notification(s) since startup; ${open} currently not marked closed.`;
}

function formatTraceSummary(trace: DesktopTraceCorrelation): string {
  return `Trace ${trace.correlationId}: ${trace.events.length} activity event(s), ${trace.logs?.entries.length ?? 0} correlated journal entr${trace.logs?.entries.length === 1 ? "y" : "ies"}.`;
}

function formatLogReadSummary(logs: DesktopLogReadResult): string {
  return `Read ${logs.entries.length} log entr${logs.entries.length === 1 ? "y" : "ies"} from ${logs.sourceId}${logs.query ? ` matching ${JSON.stringify(logs.query)}` : ""}.`;
}

function formatLogSourceSummary(sources: DesktopLogSource[]): string {
  return `Desktop agent found ${sources.length} recent Linux user-journal source(s) available for explicit bounded reads.`;
}

function formatVirtualDesktopSummary(snapshot: DesktopVirtualDesktopSnapshot): string {
  const current = snapshot.desktops.find((desktop) => desktop.current);
  return `KDE virtual desktops: ${snapshot.count} desktop(s), ${snapshot.rows} row(s), current ${current?.name ?? snapshot.currentId}.`;
}

function formatNetworkSummary(network: DesktopNetworkSnapshot): string {
  const upInterfaces = network.interfaces.filter((networkInterface) => networkInterface.up && !networkInterface.loopback);
  const addressed = upInterfaces.filter((networkInterface) => networkInterface.addresses.length > 0);
  return `Network snapshot: ${network.interfaces.length} interface(s), ${addressed.length} active/addressed, ${network.routes.length} route(s), ${network.dnsServers.length} DNS server(s), ${network.listeners.length} listening socket(s), Cloudflare Tunnel ${network.cloudflareTunnel.running ? "running" : "not running"}.`;
}

function formatPermissions(permissions: DesktopPermissionStatus[]): string {
  const granted = permissions.filter((permission) => permission.granted).length;
  const denied = permissions.length - granted;
  return `Desktop permission policy: ${granted} granted, ${denied} denied, ${permissions.length} total.`;
}

function formatDeviceSummary(devices: DesktopDeviceInfo[]): string {
  const counts = new Map<string, number>();
  for (const device of devices) counts.set(device.subsystem, (counts.get(device.subsystem) ?? 0) + 1);
  const summary = ["usb", "pci", "block", "bluetooth"]
    .map((subsystem) => `${subsystem}=${counts.get(subsystem) ?? 0}`)
    .join(", ");
  return `Desktop agent sees ${devices.length} hardware/device record(s): ${summary}.`;
}

function formatAudioSummary(graph: DesktopAudioGraph): string {
  const streams = graph.nodes.filter((node) => node.isStream);
  const sinks = graph.nodes.filter((node) => node.isSink);
  const sources = graph.nodes.filter((node) => node.isSource);
  return `PipeWire audio graph: ${graph.nodes.length} audio node(s), ${streams.length} stream(s), ${sinks.length} sink(s), ${sources.length} source(s), ${graph.links.length} route link(s).`;
}

function formatAudioRuntimeSummary(runtime: DesktopAudioRuntimeSnapshot): string {
  const running = runtime.nodes.filter((node) => node.running);
  const withErrors = runtime.nodes.filter((node) => node.errors > 0);
  const timed = runtime.nodes.filter((node) => node.waitUsec !== undefined || node.busyUsec !== undefined);
  return `PipeWire runtime: ${runtime.nodes.length} node(s), ${running.length} running, ${timed.length} with timing samples, ${withErrors.length} with nonzero error/xrun counts.`;
}

function formatActivitySummary(activity: DesktopActivityTimeline): string {
  if (activity.events.length === 0) {
    return `Desktop activity cursor ${activity.cursor}; no recent changes are buffered.`;
  }
  const first = activity.events[0]!;
  const last = activity.events[activity.events.length - 1]!;
  return `Desktop activity cursor ${activity.cursor}; ${activity.events.length} recent event(s), sequences ${first.sequence}-${last.sequence}.`;
}

function formatProcessSummary(processes: DesktopProcessInfo[]): string {
  const userProcesses = processes.filter((processInfo) => processInfo.sameUser === true);
  const withWindows = processes.filter((processInfo) => processInfo.hasWindow);
  return `Desktop agent sees ${processes.length} process(es), ${userProcesses.length} owned by the desktop user, ${withWindows.length} associated with desktop windows.`;
}

function formatDisplaySummary(displays: DesktopDisplayInfo[]): string {
  const enabled = displays.filter((display) => display.enabled && display.connected);
  const active = enabled.find((display) => display.active);
  const primary = enabled.find((display) => display.primary);
  return [
    `Desktop agent sees ${displays.length} display(s), ${enabled.length} enabled`,
    active ? `active ${active.name}` : undefined,
    primary ? `primary ${primary.name}` : undefined,
  ].filter(Boolean).join("; ");
}

function formatWindowSummary(windows: DesktopWindowInfo[]): string {
  const visible = windows.filter((window) => !window.skipTaskbar);
  const applications = new Set(
    visible.map((window) => window.applicationId || window.processName || window.resourceClass || window.title)
      .filter((value): value is string => Boolean(value)),
  );
  return `Desktop agent sees ${windows.length} window(s), ${visible.length} taskbar-visible, across ${applications.size} application identity/identities.`;
}

function formatCapabilities(
  status: DesktopAgentStatus,
  capabilities: DesktopCapabilityStatus[],
): string {
  const details = capabilities.map((capability) =>
    `${capability.id}=${capability.state}${capability.detail ? ` (${capability.detail})` : ""}`
  ).join(", ");
  return `${describeStatus(status)}; capabilities: ${details}`;
}
