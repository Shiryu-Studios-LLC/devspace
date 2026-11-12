import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as z from "zod/v4";
import { isJsonNumber, isJsonString } from "./json-value.js";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import { resultOutputSchema, textBlock } from "./tool-surfaces/shared.js";

const execFileAsync = promisify(execFile);
const ADMINCTL = "/usr/local/bin/devspace-adminctl";
const ADMIN_TIMEOUT_MS = 180_000;
const ADMIN_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

interface AdminResult {
  result: string;
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

/** Use the installed, socket-activated Admin broker; never run a shell here. */
export async function invokeDevspaceAdmin(
  argv: string[],
  executable = ADMINCTL,
): Promise<AdminResult> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, argv, {
      timeout: ADMIN_TIMEOUT_MS,
      maxBuffer: ADMIN_MAX_OUTPUT_BYTES,
      encoding: "utf8",
    });

    return {
      ok: true,
      exit_code: 0,
      stdout,
      stderr,
      error: null,
      result: stdout.trim() || "DevSpace Admin completed successfully.",
    };
  } catch (caught) {
    // SAFETY: execFile's rejection carries the subprocess exit status and captured streams.
    const error = caught as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };

    const stdout = isJsonString(error.stdout) ? error.stdout : "";
    const stderr = isJsonString(error.stderr) ? error.stderr : "";
    const message = error instanceof Error ? error.message : String(caught);
    const exitCode = isJsonNumber(error.code) ? error.code : null;

    return {
      ok: false,
      exit_code: exitCode,
      stdout,
      stderr,
      error: message,
      result: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || message,
    };
  }
}

function adminToolResponse(response: AdminResult) {
  return {
    content: [textBlock(response.result)],
    structuredContent: {
      result: response.result,
      ok: response.ok,
      exit_code: response.exit_code,
      stdout: response.stdout,
      stderr: response.stderr,
      error: response.error,
    },
    isError: !response.ok,
  };
}

const outputSchema = resultOutputSchema({
  ok: z.boolean(),
  exit_code: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  error: z.string().nullable(),
});

/** The enclosing /mcp endpoint already enforces DevSpace OAuth or Cloudflare Access. */
export function registerDevspaceAdminTools(server: McpRegistrationTarget): void {
  server.registerTool(
    "devspace_admin_status",
    {
      title: "DevSpace Admin status",
      description: "Report the installed Admin broker's platform, elevation and enabled capabilities.",
      inputSchema: {},
      outputSchema,
      annotations: { readOnlyHint: true },
    },
    async () => adminToolResponse(await invokeDevspaceAdmin(["status"])),
  );

  server.registerTool(
    "devspace_admin_call",
    {
      title: "DevSpace Admin",
      description:
        "Perform an elevated operation through the existing DevSpace Admin broker. " +
        "Actions: exec {file,args}, install_package {id}, service {name,operation}, " +
        "reboot {delay_seconds}, driver_install {inf or path}, driver_delete {published_name}. " +
        "The broker enforces its own capabilities and uses the existing privileged Unix socket.",
      inputSchema: {
        action: z.enum([
          "exec", "install_package", "service", "reboot", "driver_install", "driver_delete",
        ]),
        args: z.record(z.string(), z.unknown()).optional(),
      },
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ action, args }) => adminToolResponse(
      await invokeDevspaceAdmin(["call", action, JSON.stringify(args ?? {})]),
    ),
  );
}
