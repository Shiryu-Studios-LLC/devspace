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
          sourceModule: z.enum(["processes", "windows", "displays", "audio", "devices", "network", "notifications", "virtual-desktops"]),
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

function describeStatus(status: DesktopAgentStatus): string {
  return [
    `Desktop agent ${status.state}`,
    `pid ${status.pid}`,
    `platform ${status.platform}`,
    `session ${status.sessionType}`,
    `protocol ${status.protocolVersion}`,
  ].join("; ");
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
