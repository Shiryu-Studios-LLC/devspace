import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { logEvent } from "./logger.js";
import type { CommandResult } from "./git-tools.js";
const DEFAULT_ADMIN_CTL = "C:\\Program Files\\Shiryu Studios\\DevSpaceAdmin\\devspace-adminctl.exe";
const ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
export function devSpaceAdminCtlPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return env.DEVSPACE_ADMIN_CTL?.trim() || (platform === "win32" ? DEFAULT_ADMIN_CTL : "/usr/local/bin/devspace-adminctl");
}
export function runDevSpaceAdminCtl(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(devSpaceAdminCtlPath(env), args, { env, encoding: "utf8", windowsHide: true,
      timeout: 3_630_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout, stderr, exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
        ...(error ? { error: error.message } : {}) });
    });
  });
}
function meta(config: ServerConfig) { return config.widgets === "full" ? { _meta: { ui: { resourceUri: WORKSPACE_APP_URI, visibility: ["model"] } } } : { _meta: {} }; }
function schema() { return { result: z.string(), ok: z.boolean(), exitCode: z.number().nullable(), stdout: z.string(), stderr: z.string(), error: z.string().nullable() }; }
function response(result: CommandResult) { const text = JSON.stringify(result, null, 2); return { content: [{ type: "text" as const, text }], structuredContent: { result: text, ok: result.ok, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, error: result.error ?? null }, isError: result.ok ? undefined : true }; }
function log(config: ServerConfig, tool: string, startedAt: number, result: CommandResult, fields: Record<string, unknown> = {}) { if (config.logging.toolCalls) logEvent(config.logging, result.ok ? "info" : "warn", "tool_call", { tool, ...fields, success: result.ok, durationMs: Math.round(performance.now() - startedAt) }); }
export function registerDevSpaceAdminTools(server: McpServer, config: ServerConfig): void {
  if (process.env.DEVSPACE_ADMIN_TOOLS === "0" ||
      (process.env.DEVSPACE_ADMIN_TOOLS !== "1" && !existsSync(devSpaceAdminCtlPath()))) return;
  registerAppTool(server, "devspace_admin_status", { title: "DevSpace Admin Status", description: "Report the installed admin broker's platform, elevation, and enabled capabilities.", inputSchema: {}, outputSchema: schema(), ...meta(config), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async () => { const startedAt = performance.now(); const result = await runDevSpaceAdminCtl(["status"]); log(config, "devspace_admin_status", startedAt, result); return response(result); });
  registerAppTool(server, "devspace_admin_call", { title: "DevSpace Admin Call", description: "Perform an intentional elevated action through the local admin broker. Actions: exec {file,args} (absolute executable path on Unix), install_package {id} (native package ID; absolute .pkg on macOS), service {name,operation: start|stop|restart|query}, reboot {delay_seconds}, driver_install {inf on Windows, path on Unix}, driver_delete {published_name}. Check devspace_admin_status for platform capabilities first. Unix driver operations load/unload native kernel modules, subject to OS approvals.", inputSchema: { action: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/, "action contains unsupported characters."), args: z.record(z.string(), z.unknown()).optional() }, outputSchema: schema(), ...meta(config), annotations: ANNOTATIONS }, async ({ action, args }) => { const startedAt = performance.now(); const result = await runDevSpaceAdminCtl(["call", action, JSON.stringify(args ?? {})]); log(config, "devspace_admin_call", startedAt, result, { action }); return response(result); });
}
