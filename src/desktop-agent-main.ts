#!/usr/bin/env node
import { loadConfig } from "./config.js";
import {
  DesktopAgentDaemon,
  writeDesktopAgentLog,
} from "./desktop-agent-daemon.js";
import { watchDesktopPermissionPolicy } from "./desktop-permission-watcher.js";
import {
  DesktopAgentAlreadyRunningError,
  desktopAgentPaths,
} from "./desktop-agent-lifecycle.js";
import { devspaceConfigPath } from "./user-config.js";

const config = loadConfig();
const paths = desktopAgentPaths(config.stateDir);
let shuttingDown = false;
let stopPermissionWatcher: (() => void) | undefined;
const daemon = new DesktopAgentDaemon({
  stateDir: config.stateDir,
  permissions: config.desktopPermissions,
  allowedRoots: config.allowedRoots,
  onClosed: () => {
    stopPermissionWatcher?.();
    if (!shuttingDown) process.exit(0);
  },
});

const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopPermissionWatcher?.();
  void daemon.close().finally(() => process.exit(0));
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await daemon.start();
  stopPermissionWatcher = watchDesktopPermissionPolicy({
    configPath: devspaceConfigPath(),
    loadPolicy: () => loadConfig().desktopPermissions,
    applyPolicy: (permissions) => {
      daemon.updatePermissions(permissions);
      writeDesktopAgentLog(paths, "info", "desktop_permissions_reloaded", {});
    },
    onError: (error) => {
      writeDesktopAgentLog(paths, "warn", "desktop_permissions_reload_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
} catch (error) {
  if (error instanceof DesktopAgentAlreadyRunningError) process.exit(0);
  writeDesktopAgentLog(paths, "error", "desktop_agent_start_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
