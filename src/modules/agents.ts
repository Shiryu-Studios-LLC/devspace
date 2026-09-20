import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "../config.js";
import { createLocalAgentClient } from "../local-agent-client.js";
import { toAgentErrorPayload } from "../local-agent-errors.js";
import type { LocalAgentRecord } from "../local-agent-store.js";
import {
  AGENT_EXEC_TOOL_ANNOTATIONS,
  logToolCall,
  resultOutputSchema,
  textBlock,
  workspaceIdDescription,
} from "../tool-support.js";
import type { WorkspaceRegistry } from "../workspaces.js";

const localAgentRecordOutputSchema = z.object({
  id: z.string(),
  workspaceId: z.string().optional(),
  workspaceRoot: z.string(),
  profileName: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  providerSessionId: z.string().optional(),
  status: z.enum(["starting", "running", "idle", "error", "stopped"]),
  latestResponse: z.string().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  errorRetryable: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function formatLocalAgentRecord(record: LocalAgentRecord): string {
  const target = record.profileName || record.provider;
  const details = [
    `Agent ${record.id}`,
    `target ${target}`,
    `provider ${record.provider}`,
    `status ${record.status}`,
  ];
  if (record.model) details.push(`model ${record.model}`);
  if (record.effort) details.push(`effort ${record.effort}`);
  if (record.latestResponse) details.push(`response: ${record.latestResponse}`);
  if (record.error) details.push(`error: ${record.error}`);
  return details.join("; ");
}

function localAgentErrorResponse(error: Parameters<typeof toAgentErrorPayload>[0]) {
  const payload = toAgentErrorPayload(error);
  const result = `${payload.code}: ${payload.message}`;
  return {
    content: [textBlock(result)],
    structuredContent: { result },
    isError: true,
  };
}

export function registerAgentTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
): void {
  const localAgentClient = createLocalAgentClient(config);
  const agentScope = (workspaceId: string) => {
    const workspace = workspaces.getWorkspace(workspaceId);
    return {
      workspace,
      scope: { workspaceId: workspace.id, workspaceRoot: workspace.root },
    };
  };

  registerAppTool(
    server,
    "agent_spawn",
    {
      title: "Spawn local agent",
      description:
        "Start a bounded local subagent in an open workspace using an enabled provider or named agent profile. Defaults to read-only access; request writeMode=allowed or full_access only when the delegated task needs to modify the workspace.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        target: z.string().min(1).describe("Enabled provider id or named agent profile."),
        prompt: z.string().min(1).describe("Bounded task brief for the subagent."),
        model: z.string().min(1).optional(),
        effort: z.string().min(1).optional(),
        writeMode: z.enum(["read_only", "allowed", "full_access"]).optional(),
      },
      outputSchema: resultOutputSchema({
        agent: localAgentRecordOutputSchema.optional(),
      }),
      _meta: {},
      annotations: AGENT_EXEC_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, target, prompt, model, effort, writeMode }) => {
      const startedAt = performance.now();
      const { workspace } = agentScope(workspaceId);
      const response = await localAgentClient.start({
        target,
        prompt,
        workspaceRoot: workspace.root,
        workspaceId: workspace.id,
        model,
        effort,
        writeMode: writeMode ?? "read_only",
      });
      if (response.isErr()) {
        logToolCall(config, {
          tool: "agent_spawn",
          workspaceId,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: response.error.message,
        });
        return localAgentErrorResponse(response.error);
      }
      const result = formatLocalAgentRecord(response.value);
      logToolCall(config, {
        tool: "agent_spawn",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        structuredContent: { result, agent: response.value },
      };
    },
  );

  registerAppTool(
    server,
    "agent_status",
    {
      title: "Local agent status",
      description:
        "Inspect one local subagent in an open workspace, including status, latest response, and error details.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        agentId: z.string().min(1),
      },
      outputSchema: resultOutputSchema({
        agent: localAgentRecordOutputSchema.optional(),
      }),
      _meta: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId, agentId }) => {
      const { scope } = agentScope(workspaceId);
      const response = await localAgentClient.get(agentId, scope);
      if (response.isErr()) return localAgentErrorResponse(response.error);
      const result = formatLocalAgentRecord(response.value);
      return {
        content: [textBlock(result)],
        structuredContent: { result, agent: response.value },
      };
    },
  );

  registerAppTool(
    server,
    "agent_list",
    {
      title: "List local agents",
      description: "List local subagent sessions scoped to an open workspace.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({
        agents: z.array(localAgentRecordOutputSchema).optional(),
      }),
      _meta: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId }) => {
      const { scope } = agentScope(workspaceId);
      const response = await localAgentClient.list(scope);
      if (response.isErr()) return localAgentErrorResponse(response.error);
      const result = response.value.length > 0
        ? response.value.map(formatLocalAgentRecord).join("\n")
        : "No local agents found for this workspace.";
      return {
        content: [textBlock(result)],
        structuredContent: { result, agents: response.value },
      };
    },
  );

  registerAppTool(
    server,
    "agent_continue",
    {
      title: "Continue local agent",
      description:
        "Continue an existing local subagent with a follow-up prompt. Defaults to read-only access for the new turn unless a write mode is explicitly requested.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        agentId: z.string().min(1),
        prompt: z.string().min(1),
        model: z.string().min(1).optional(),
        effort: z.string().min(1).optional(),
        writeMode: z.enum(["read_only", "allowed", "full_access"]).optional(),
      },
      outputSchema: resultOutputSchema({
        agent: localAgentRecordOutputSchema.optional(),
      }),
      _meta: {},
      annotations: AGENT_EXEC_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, agentId, prompt, model, effort, writeMode }) => {
      const { scope } = agentScope(workspaceId);
      const response = await localAgentClient.continue(agentId, prompt, {
        model,
        effort,
        writeMode: writeMode ?? "read_only",
      }, scope);
      if (response.isErr()) return localAgentErrorResponse(response.error);
      const result = formatLocalAgentRecord(response.value);
      return {
        content: [textBlock(result)],
        structuredContent: { result, agent: response.value },
      };
    },
  );

  registerAppTool(
    server,
    "agent_wait",
    {
      title: "Wait for local agent",
      description:
        "Wait briefly for a local subagent turn to leave starting/running state, then return its latest record. The maximum wait is 30 seconds.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        agentId: z.string().min(1),
        maxWaitSeconds: z.number().min(0).max(30).optional(),
      },
      outputSchema: resultOutputSchema({
        agent: localAgentRecordOutputSchema.optional(),
      }),
      _meta: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId, agentId, maxWaitSeconds }) => {
      const { scope } = agentScope(workspaceId);
      const deadline = Date.now() + Math.round((maxWaitSeconds ?? 15) * 1_000);
      let response = await localAgentClient.get(agentId, scope);
      while (
        response.isOk()
        && (response.value.status === "starting" || response.value.status === "running")
        && Date.now() < deadline
      ) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        response = await localAgentClient.get(agentId, scope);
      }
      if (response.isErr()) return localAgentErrorResponse(response.error);
      const result = formatLocalAgentRecord(response.value);
      return {
        content: [textBlock(result)],
        structuredContent: { result, agent: response.value },
      };
    },
  );
}
