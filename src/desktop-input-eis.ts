import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DesktopInputRequest } from "./desktop-agent-protocol.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_PYTHON = "/usr/bin/python3";
const STDERR_TAIL_LIMIT = 4_096;

export type EisInputRequest = DesktopInputRequest;

interface PendingRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface EisInputClientOptions {
  helperPath?: string;
  pythonPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface HelperResponse {
  id?: unknown;
  ok?: unknown;
  error?: unknown;
}

export function kwinEisInputAvailable(
  helperPath = defaultEisInputHelperPath(),
  pythonPath = DEFAULT_PYTHON,
): boolean {
  return process.platform === "linux"
    && Boolean(helperPath && existsSync(helperPath))
    && existsSync(pythonPath)
    && Boolean(process.env.DBUS_SESSION_BUS_ADDRESS)
    && Boolean(process.env.WAYLAND_DISPLAY);
}

export class KWinEisInputClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = "";
  private stderrTail = "";
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly options: EisInputClientOptions = {}) {}

  async perform(request: EisInputRequest): Promise<void> {
    switch (request.type) {
      case "mouse-move":
        await this.send({
          command: request.mode === "absolute" ? "move-absolute" : "move-relative",
          x: request.x,
          y: request.y,
        });
        return;
      case "mouse-click":
        await this.send({
          command: "click",
          button: request.button,
          count: request.count ?? 1,
          nextDelayMs: request.nextDelayMs ?? 40,
        });
        return;
      case "mouse-scroll":
        await this.send({ command: "scroll", x: request.x ?? 0, y: request.y });
        return;
      case "type-text":
        await this.send({
          command: "type-text",
          text: request.text,
          keyDelayMs: request.keyDelayMs ?? 20,
          keyHoldMs: request.keyHoldMs ?? 20,
        });
        return;
      case "key-chord":
        await this.send({
          command: "key-chord",
          key: request.key,
          modifiers: request.modifiers ?? [],
          keyDelayMs: request.keyDelayMs ?? 20,
        });
        return;
    }
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 500);
    timer.unref();
  }

  private async send(payload: Record<string, unknown>): Promise<void> {
    const child = this.ensureChild();
    const id = this.nextRequestId++;
    const line = `${JSON.stringify({ id, ...payload })}\n`;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.resetChild();
        reject(new Error(`KWin EIS input helper timed out after ${this.timeoutMs()} ms.`));
      }, this.timeoutMs());
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });

      child.stdin.write(line, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
        this.resetChild();
      });
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;

    const helperPath = this.options.helperPath ?? defaultEisInputHelperPath();
    const pythonPath = this.options.pythonPath ?? DEFAULT_PYTHON;
    if (!helperPath || !existsSync(helperPath)) {
      throw new Error("KWin EIS input helper is unavailable.");
    }
    if (!existsSync(pythonPath)) {
      throw new Error(`Python interpreter is unavailable: ${pythonPath}`);
    }

    const child = spawn(pythonPath, [helperPath, "serve"], {
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stdoutBuffer = "";
    this.stderrTail = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
    });
    child.once("error", (error) => {
      if (this.child === child) this.child = undefined;
      this.rejectAll(error);
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      if (this.pending.size === 0) return;
      const detail = this.stderrTail.trim();
      const suffix = detail ? `: ${detail}` : "";
      this.rejectAll(new Error(
        `KWin EIS input helper exited (${signal ?? code ?? "unknown"})${suffix}`,
      ));
    });
    return child;
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let response: HelperResponse;
      try {
        response = JSON.parse(line) as HelperResponse;
      } catch {
        continue;
      }
      if (!Number.isSafeInteger(response.id)) continue; // readiness/status message
      const id = Number(response.id);
      const pending = this.pending.get(id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (response.ok === true) {
        pending.resolve();
      } else {
        const message = typeof response.error === "string"
          ? response.error
          : "KWin EIS input helper rejected the request.";
        pending.reject(new Error(message));
        this.resetChild();
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private resetChild(): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin.destroy();
    child.kill("SIGTERM");
  }

  private timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }
}

export function defaultEisInputHelperPath(): string | undefined {
  const built = fileURLToPath(new URL("./bin/devspace-eis-input-helper.py", import.meta.url));
  if (existsSync(built)) return built;
  const source = fileURLToPath(new URL("../native/devspace-eis-input-helper.py", import.meta.url));
  return existsSync(source) ? source : undefined;
}
