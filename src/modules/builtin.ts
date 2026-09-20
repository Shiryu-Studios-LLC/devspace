import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "../artifact-tools.js";
import { registerDevSpaceAdminTools } from "../devspace-admin-tools.js";
import { registerGitTools } from "../git-tools.js";
import { registerLocalWindowsTools } from "../local-windows-tools.js";
import { registerUpstreamMcpTools } from "../upstream-mcp.js";
import type { DevSpaceModule } from "./types.js";

export const upstreamMcpModule: DevSpaceModule = {
  id: "upstream-mcp",
  register: ({ server, config }) => registerUpstreamMcpTools(server, config),
};

export const gitModule: DevSpaceModule = {
  id: "git",
  register: ({ server, config, workspaces }) => registerGitTools(server, config, workspaces),
};

export const adminModule: DevSpaceModule = {
  id: "admin",
  register: ({ server, config }) => registerDevSpaceAdminTools(server, config),
};

export const windowsDesktopModule: DevSpaceModule = {
  id: "desktop-windows",
  enabled: () => process.platform === "win32",
  register: ({ server, config, workspaces }) => registerLocalWindowsTools(server, config, workspaces),
};

export const artifactModule: DevSpaceModule = {
  id: "artifacts",
  enabled: ({ config }) => config.artifactsEnabled && isArtifactDownloadSupportedPlatform(),
  register: ({ server, config, workspaces, incomingArtifactAdapters }) =>
    registerArtifactTools(server, {
      config,
      workspaces,
      incomingArtifactAdapters,
    }),
};

export const lateBuiltinModules: readonly DevSpaceModule[] = [
  gitModule,
  adminModule,
  windowsDesktopModule,
  artifactModule,
];
