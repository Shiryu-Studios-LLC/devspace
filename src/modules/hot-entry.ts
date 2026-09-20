import { registerAgentTools } from "./agents.js";
import { lateBuiltinModules, upstreamMcpModule } from "./builtin.js";
import { registerFilesystemSearchTools } from "./filesystem-search.js";
import { registerFilesystemTools } from "./filesystem.js";
import { registerCodexProcessTools } from "./process.js";
import { registerReviewTools } from "./reviews.js";
import { registerShellTools } from "./shell.js";
import type { DevSpaceModule } from "./types.js";
import { registerWorkspaceTools } from "./workspace.js";

const workspaceModule: DevSpaceModule = {
  id: "workspace",
  register: ({ server, config, workspaces, reviewCheckpoints, resolveLocalAgentProviders }) =>
    registerWorkspaceTools(
      server,
      config,
      workspaces,
      reviewCheckpoints,
      resolveLocalAgentProviders,
    ),
};

const agentsModule: DevSpaceModule = {
  id: "agents",
  enabled: ({ config }) => config.subagents.enabled,
  register: ({ server, config, workspaces }) => registerAgentTools(server, config, workspaces),
};

const filesystemModule: DevSpaceModule = {
  id: "filesystem",
  register: ({ server, config, workspaces }) => registerFilesystemTools(server, config, workspaces),
};

const reviewsModule: DevSpaceModule = {
  id: "reviews",
  enabled: ({ config }) => config.widgets === "changes",
  register: ({ server, config, workspaces, reviewCheckpoints }) =>
    registerReviewTools(server, config, workspaces, reviewCheckpoints),
};

const filesystemSearchModule: DevSpaceModule = {
  id: "filesystem-search",
  enabled: ({ config }) => config.toolMode === "full",
  register: ({ server, config, workspaces }) => registerFilesystemSearchTools(server, config, workspaces),
};

const shellModule: DevSpaceModule = {
  id: "shell",
  enabled: ({ config }) => config.toolMode !== "codex",
  register: ({ server, config, workspaces }) => registerShellTools(server, config, workspaces),
};

const processModule: DevSpaceModule = {
  id: "process",
  enabled: ({ config }) => config.toolMode === "codex",
  register: ({ server, config, workspaces, processSessions }) =>
    registerCodexProcessTools(server, config, workspaces, processSessions),
};

export const hotReloadableModules: readonly DevSpaceModule[] = [
  upstreamMcpModule,
  workspaceModule,
  agentsModule,
  filesystemModule,
  reviewsModule,
  filesystemSearchModule,
  shellModule,
  processModule,
  ...lateBuiltinModules,
];
