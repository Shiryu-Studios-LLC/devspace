import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "../config.js";
import type { ReviewCheckpointManager } from "../review-checkpoints.js";
import {
  contentText,
  logToolCall,
  resultOutputSchema,
  textBlock,
  toolWidgetDescriptorMeta,
  workspaceIdDescription,
} from "../tool-support.js";
import type { WorkspaceRegistry } from "../workspaces.js";

export function registerReviewTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReviewCheckpointManager,
): void {
  registerAppTool(
    server,
    "show_changes",
    {
      title: "Show changes",
      description:
        "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "show_changes"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const review = await reviewCheckpoints.reviewChanges({
        workspaceId,
        root: workspace.root,
        markReviewed: true,
      });

      const content = [textBlock(review.result)];
      logToolCall(config, {
        tool: "show_changes",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: "show_changes",
          card: {
            workspaceId,
            summary: review.summary,
            files: review.files,
            payload: {
              patch: review.patch,
            },
          },
        },
        structuredContent: {
          result: contentText(content),
        },
      };
    },
  );
}
