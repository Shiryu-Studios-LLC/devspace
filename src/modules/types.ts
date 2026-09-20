import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "../config.js";
import type { IncomingArtifactAdapter } from "../incoming-artifacts.js";
import type { LocalAgentProviderStatus } from "../local-agent-catalog.js";
import type { ProcessSessionManager } from "../process-sessions.js";
import type { ReviewCheckpointManager } from "../review-checkpoints.js";
import type { WorkspaceRegistry } from "../workspaces.js";

export type DevSpaceModuleStatus =
  | "ready"
  | "degraded"
  | "unavailable"
  | "disabled"
  | "failed"
  | "restarting";

export interface DevSpaceModuleContext {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  reviewCheckpoints: ReviewCheckpointManager;
  processSessions: ProcessSessionManager;
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[];
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[];
}

export interface DevSpaceModule {
  id: string;
  enabled?(context: DevSpaceModuleContext): boolean;
  register(context: DevSpaceModuleContext): void;
}

export interface DevSpaceModuleState {
  id: string;
  status: DevSpaceModuleStatus;
  error?: string;
}
