import { spawn } from "node:child_process";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";

const WINDOWS_SHELL_MAX_BUFFER = 10 * 1024 * 1024;

interface ShellFailure extends Error {
  stdout?: string;
  stderr?: string;
}

async function runWindowsShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const shell = resolveShellCommand(command, "win32", process.env);
  const child = spawn(shell.executable, shell.args, {
    cwd,
    windowsHide: true,
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  let bufferedBytes = 0;
  let overflow: Error | undefined;

  const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    if (overflow) return;
    const text = chunk.toString("utf8");
    bufferedBytes += Buffer.byteLength(text);
    if (bufferedBytes > WINDOWS_SHELL_MAX_BUFFER) {
      overflow = new Error(`Shell output exceeded ${WINDOWS_SHELL_MAX_BUFFER} bytes.`);
      terminateProcessTree(child, "SIGTERM", false);
      return;
    }
    if (stream === "stdout") stdout += text;
    else stderr += text;
  };

  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
  child.stdin.end();

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let closeFallback: NodeJS.Timeout | undefined;

    const fail = (error: ShellFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (closeFallback) clearTimeout(closeFallback);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM", false);
      closeFallback = setTimeout(() => {
        fail(new Error(`Shell command timed out after ${timeoutMs}ms.`));
      }, 2_000);
    }, timeoutMs);

    child.once("error", (error) => fail(error));
    child.once("close", (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      if (overflow) return fail(overflow);
      if (timedOut) return fail(new Error(`Shell command timed out after ${timeoutMs}ms.`));
      if (code !== 0) {
        return fail(new Error(
          `Shell command exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`,
        ));
      }
      settled = true;
      if (closeFallback) clearTimeout(closeFallback);
      resolve({ stdout, stderr });
    });
  });
}

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
  const tool = createReadTool(context.cwd);

  return runTool((params) => tool.execute("read_file", params), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createWriteTool(context.cwd);

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createEditTool(context.cwd);

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function grepFilesTool(input: GrepToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createGrepTool(context.cwd);

  return runTool((params) => tool.execute("grep_files", params), input, context);
}

export async function findFilesTool(input: FindToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createFindTool(context.cwd);

  return runTool((params) => tool.execute("find_files", params), input, context);
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createLsTool(context.cwd);

  return runTool((params) => tool.execute("list_directory", params), input, context);
}

export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);

  const windowsWorkspace = process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(context.cwd);
  if (windowsWorkspace) {
    try {
      const result = await runWindowsShell(input.command, context.cwd, timeout * 1000);
      const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      return { content: [{ type: "text", text: text || "Command completed successfully." }] };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
      const stdout = typeof failure.stdout === "string" ? failure.stdout : failure.stdout?.toString() ?? "";
      const stderr = typeof failure.stderr === "string" ? failure.stderr : failure.stderr?.toString() ?? "";
      const message = [stdout, stderr, error instanceof Error ? error.message : String(error)]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  const tool = createBashTool(context.cwd);
  return runTool((params) => tool.execute("run_shell", params), {
    command: input.command,
    timeout,
  }, context);
}
