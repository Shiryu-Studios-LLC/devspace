import { execFileSync } from "node:child_process";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { logEvent } from "./logger.js";
import type { CommandResult } from "./git-tools.js";
const DEFAULT_ADMIN_CTL = "C:\\Program Files\\Shiryu Studios\\DevSpaceAdmin\\devspace-adminctl.exe";
const ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
export function devSpaceAdminCtlPath(env: NodeJS.ProcessEnv = process.env): string { return env.DEVSPACE_ADMIN_CTL?.trim() || DEFAULT_ADMIN_CTL; }
export function runDevSpaceAdminCtl(args: string[], env: NodeJS.ProcessEnv = process.env): CommandResult { try { const stdout = execFileSync(devSpaceAdminCtlPath(env), args, { encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }); return { ok: true, stdout, stderr: "", exitCode: 0 }; } catch (error: unknown) { const failure = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; status?: number }; return { ok: false, stdout: typeof failure.stdout === "string" ? failure.stdout : failure.stdout?.toString() ?? "", stderr: typeof failure.stderr === "string" ? failure.stderr : failure.stderr?.toString() ?? "", exitCode: typeof failure.status === "number" ? failure.status : null, error: error instanceof Error ? error.message : String(error) }; } }
function meta(config: ServerConfig) { return config.widgets === "full" ? { _meta: { ui: { resourceUri: WORKSPACE_APP_URI, visibility: ["model"] } } } : { _meta: {} }; }
function schema() { return { result: z.string(), ok: z.boolean(), exitCode: z.number().nullable(), stdout: z.string(), stderr: z.string(), error: z.string().nullable() }; }
function response(result: CommandResult) { const text = JSON.stringify(result, null, 2); return { content: [{ type: "text" as const, text }], structuredContent: { result: text, ok: result.ok, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, error: result.error ?? null }, isError: result.ok ? undefined : true }; }
function log(config: ServerConfig, tool: string, startedAt: number, result: CommandResult, fields: Record<string, unknown> = {}) { if (config.logging.toolCalls) logEvent(config.logging, result.ok ? "info" : "warn", "tool_call", { tool, ...fields, success: result.ok, durationMs: Math.round(performance.now() - startedAt) }); }
export function registerDevSpaceAdminTools(server: McpServer, config: ServerConfig): void {
  registerAppTool(server, "devspace_admin_status", { title: "DevSpace Admin Status", description: "Run the installed Shiryu DevSpace Admin status check.", inputSchema: {}, outputSchema: schema(), ...meta(config), annotations: ANNOTATIONS }, async () => { const startedAt = performance.now(); const result = runDevSpaceAdminCtl(["status"]); log(config, "devspace_admin_status", startedAt, result); return response(result); });
  registerAppTool(server, "devspace_admin_call", { title: "DevSpace Admin Call", description: "Call an installed Shiryu DevSpace Admin action. This generic elevated bridge should only be used for intentional admin actions.", inputSchema: { action: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/, "action contains unsupported characters."), args: z.record(z.string(), z.unknown()).optional() }, outputSchema: schema(), ...meta(config), annotations: ANNOTATIONS }, async ({ action, args }) => { const startedAt = performance.now(); const result = runDevSpaceAdminCtl(["call", action, JSON.stringify(args ?? {})]); log(config, "devspace_admin_call", startedAt, result, { action }); return response(result); });
}
