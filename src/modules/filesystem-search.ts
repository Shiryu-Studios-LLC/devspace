import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "../config.js";
import {
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
} from "../pi-tools.js";
import {
  contentText,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textSummary,
  toolNames,
  toolWidgetDescriptorMeta,
  workspaceIdDescription,
} from "../tool-support.js";
import type { WorkspaceRegistry } from "../workspaces.js";

export function registerFilesystemSearchTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
): void {
  registerAppTool(
    server,
    toolNames.grep,
    {
      title: "Grep",
      description:
        "Search file contents in a workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        pattern: z.string().describe("Search pattern."),
        path: z
          .string()
          .optional()
          .describe("Optional path or glob scope relative to the workspace root."),
        include: z.string().optional().describe("Optional include glob."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "search"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      if (input.path) workspaces.resolvePath(workspace, input.path);
      const response = await grepFilesTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const summary = {
        pattern: input.pattern,
        scope: input.path ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.grep,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.grep,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.glob,
    {
      title: "Glob",
      description:
        "Find files by glob pattern in a workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        pattern: z.string().describe("File glob pattern."),
        path: z
          .string()
          .optional()
          .describe("Optional path scope relative to the workspace root."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "search"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      if (input.path) workspaces.resolvePath(workspace, input.path);
      const response = await findFilesTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const summary = {
        pattern: input.pattern,
        scope: input.path ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.glob,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.glob,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.ls,
    {
      title: "Ls",
      description:
        "List a directory in a workspace. Use this for directory inspection before reading files.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        path: z
          .string()
          .describe("Directory path to list, relative to the workspace root."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "directory"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await listDirectoryTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const summary = textSummary(response.content);
      logToolCall(config, {
        tool: toolNames.ls,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.ls,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );
}
