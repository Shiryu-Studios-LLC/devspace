#!/usr/bin/env node
import { loadConfig } from "./config.js";
import {
  DesktopAgentDaemon,
  writeDesktopAgentLog,
} from "./desktop-agent-daemon.js";
import {
  DesktopAgentAlreadyRunningError,
  desktopAgentPaths,
} from "./desktop-agent-lifecycle.js";

const config = loadConfig();
const paths = desktopAgentPaths(config.stateDir);
let shuttingDown = false;
const daemon = new DesktopAgentDaemon({
  stateDir: config.stateDir,
  permissions: config.desktopPermissions,
  onClosed: () => {
    if (!shuttingDown) process.exit(0);
  },
});

const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void daemon.close().finally(() => process.exit(0));
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await daemon.start();
} catch (error) {
  if (error instanceof DesktopAgentAlreadyRunningError) process.exit(0);
  writeDesktopAgentLog(paths, "error", "desktop_agent_start_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
