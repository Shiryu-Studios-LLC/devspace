import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "../config.js";
import {
  DesktopAgentClient,
  DesktopAgentClientError,
} from "../desktop-agent-client.js";
import type {
  DesktopAgentStatus,
  DesktopCapabilityStatus,
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

function formatCapabilities(
  status: DesktopAgentStatus,
  capabilities: DesktopCapabilityStatus[],
): string {
  const details = capabilities.map((capability) =>
    `${capability.id}=${capability.state}${capability.detail ? ` (${capability.detail})` : ""}`
  ).join(", ");
  return `${describeStatus(status)}; capabilities: ${details}`;
}
