import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { applicationAdapterMetadata } from "./application-integrations.js";
import type { ServerConfig } from "./config.js";
import type { DevSpaceModuleHealth } from "./modules/types.js";

type Upstream = {
  name: string;
  url: URL;
  enabled: boolean;
};

export type UpstreamMcpReachabilityStatus = "ready" | "unavailable" | "disabled";

export interface UpstreamMcpStatus {
  server: string;
  status: UpstreamMcpReachabilityStatus;
  error?: string;
}

function configuredUpstreams(config: ServerConfig): Upstream[] {
  return config.upstreamMcpServers.flatMap((entry) => {
    try {
      const url = new URL(entry.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported protocol");
      return [{ name: entry.name, url, enabled: entry.enabled !== false }];
    } catch {
      return [];
    }
  });
}

async function withClient<T>(
  upstream: Upstream,
  action: (client: Client) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const client = new Client({ name: "devspace-upstream-bridge", version: "1.0.0" });
  const requestInit = options.timeoutMs
    ? { signal: AbortSignal.timeout(options.timeoutMs) }
    : undefined;
  const transport = new StreamableHTTPClientTransport(
    upstream.url,
    requestInit ? { requestInit } : undefined,
  );
  try {
    await client.connect(transport);
    return await action(client);
  } finally {
    await transport.close().catch(() => undefined);
  }
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export async function getUpstreamMcpStatuses(
  config: ServerConfig,
  timeoutMs = 1_000,
): Promise<UpstreamMcpStatus[]> {
  const upstreams = configuredUpstreams(config);
  return Promise.all(upstreams.map(async (upstream) => {
    if (!upstream.enabled) return { server: upstream.name, status: "disabled" as const };
    try {
      await withClient(upstream, (client) => client.ping(), { timeoutMs });
      return { server: upstream.name, status: "ready" as const };
    } catch (error) {
      return {
        server: upstream.name,
        status: "unavailable" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

export function summarizeUpstreamMcpHealth(
  statuses: readonly UpstreamMcpStatus[],
): DevSpaceModuleHealth {
  const unavailable = statuses.filter((status) => status.status === "unavailable").length;
  const ready = statuses.filter((status) => status.status === "ready").length;
  const disabled = statuses.filter((status) => status.status === "disabled").length;
  const detail = statuses.length === 0
    ? "No upstream MCP servers are configured."
    : `${ready} ready, ${unavailable} unavailable, ${disabled} disabled.`;

  return {
    status: unavailable > 0 ? "degraded" : "ready",
    detail,
    capabilities: statuses.map((status) => ({
      id: status.server,
      status: status.status,
      detail: status.status === "ready"
        ? "Reachable."
        : status.status === "disabled"
          ? "Disabled by configuration."
          : "Configured upstream MCP server is not reachable.",
      ...applicationAdapterMetadata(status.server, status.server),
      ...(status.error ? { error: status.error } : {}),
    })),
  };
}

export function registerUpstreamMcpTools(server: McpServer, config: ServerConfig): void {
  const upstreams = configuredUpstreams(config);
  const names = upstreams.map((upstream) => upstream.name);

  server.registerTool(
    "list_upstream_mcp_tools",
    {
      title: "List external MCP tools",
      description: "List the tools available from configured local MCP servers. Offline servers are reported without failing the gateway.",
      inputSchema: { server: z.string().optional().describe("Optional configured server name.") },
    },
    async ({ server: requestedName }) => {
      const selected = requestedName ? upstreams.filter((upstream) => upstream.name === requestedName) : upstreams;
      const results = await Promise.all(selected.map(async (upstream) => {
        if (!upstream.enabled) return { server: upstream.name, status: "disabled" as const, tools: [] };
        try {
          const response = await withClient(upstream, (client) => client.listTools());
          return { server: upstream.name, status: "ready" as const, tools: response.tools };
        } catch (error) {
          return { server: upstream.name, status: "unavailable" as const, tools: [], error: error instanceof Error ? error.message : String(error) };
        }
      }));
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    },
  );

  server.registerTool(
    "call_upstream_mcp_tool",
    {
      title: "Call an external MCP tool",
      description: "Call one tool from a configured local MCP server. Use list_upstream_mcp_tools first to discover its exact tool name and arguments.",
      inputSchema: {
        server: z.string().describe(`Configured server name: ${names.join(", ") || "none"}.`),
        toolName: z.string().describe("Exact tool name returned by list_upstream_mcp_tools."),
        arguments: z.record(z.string(), z.unknown()).default({}).describe("Arguments for the upstream tool."),
      },
    },
    async ({ server: serverName, toolName, arguments: args }) => {
      const upstream = upstreams.find((candidate) => candidate.name === serverName);
      if (!upstream) return errorResult(`Unknown upstream MCP server: ${serverName}.`);
      if (!upstream.enabled) return errorResult(`${serverName} is disabled in DevSpace configuration.`);
      try {
        const result = await withClient(upstream, (client) => client.callTool({ name: toolName, arguments: args }));
        if (!("content" in result)) {
          return { content: [{ type: "text" as const, text: JSON.stringify(result.toolResult) }] };
        }
        return result as CallToolResult;
      } catch (error) {
        return errorResult(`${serverName} is unavailable. Start its application and try again. ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.registerTool(
    "get_upstream_mcp_status",
    {
      title: "Check external MCP status",
      description: "Check whether configured local MCP servers are enabled and reachable.",
    },
    async () => {
      const statuses = await getUpstreamMcpStatuses(config);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(statuses.map(({ server, status }) => ({ server, status }))),
        }],
      };
    },
  );
}
