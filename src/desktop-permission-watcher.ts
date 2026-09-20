import { unwatchFile, watchFile } from "node:fs";
import type { DesktopPermissionPolicy } from "./desktop-permissions.js";

export interface DesktopPermissionWatcherOptions {
  configPath: string;
  loadPolicy: () => DesktopPermissionPolicy;
  applyPolicy: (policy: DesktopPermissionPolicy) => void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  debounceMs?: number;
}

export function watchDesktopPermissionPolicy(options: DesktopPermissionWatcherOptions): () => void {
  const intervalMs = options.intervalMs ?? 200;
  const debounceMs = options.debounceMs ?? 75;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const apply = () => {
    timer = undefined;
    if (closed) return;
    try {
      options.applyPolicy(options.loadPolicy());
    } catch (error) {
      options.onError?.(error);
    }
  };

  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(apply, debounceMs);
    timer.unref();
  };

  watchFile(options.configPath, { interval: intervalMs, persistent: false }, (current, previous) => {
    if (
      current.mtimeMs === previous.mtimeMs
      && current.ctimeMs === previous.ctimeMs
      && current.size === previous.size
    ) return;
    schedule();
  });
  schedule();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    unwatchFile(options.configPath);
  };
}
