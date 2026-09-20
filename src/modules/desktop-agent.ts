import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "../config.js";
import {
  DesktopAgentClient,
  DesktopAgentClientError,
} from "../desktop-agent-client.js";
import type {
  DesktopActivityTimeline,
  DesktopAgentStatus,
  DesktopAudioGraph,
  DesktopCapabilityStatus,
  DesktopDisplayInfo,
  DesktopProcessInfo,
  DesktopWindowInfo,
} from "../desktop-agent-protocol.js";

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
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
    "desktop_recent_activity",
    {
      title: "Recent Desktop Activity",
      description:
        "Read the isolated desktop agent's bounded in-memory activity timeline for recent process, window, and display changes. The cursor is monotonically increasing while the agent is running, so callers can remember a cursor before an action and compare later events. No keystrokes, screenshots, command-line arguments, or environment contents are recorded.",
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
            "display.connected",
            "display.disconnected",
            "display.changed",
          ]),
          sourceModule: z.enum(["processes", "windows", "displays"]),
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

function describeStatus(status: DesktopAgentStatus): string {
  return [
    `Desktop agent ${status.state}`,
    `pid ${status.pid}`,
    `platform ${status.platform}`,
    `session ${status.sessionType}`,
    `protocol ${status.protocolVersion}`,
  ].join("; ");
}

function formatAudioSummary(graph: DesktopAudioGraph): string {
  const streams = graph.nodes.filter((node) => node.isStream);
  const sinks = graph.nodes.filter((node) => node.isSink);
  const sources = graph.nodes.filter((node) => node.isSource);
  return `PipeWire audio graph: ${graph.nodes.length} audio node(s), ${streams.length} stream(s), ${sinks.length} sink(s), ${sources.length} source(s), ${graph.links.length} route link(s).`;
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
