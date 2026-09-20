import { unwatchFile, watch, watchFile, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { DevSpaceModule } from "./types.js";

export interface HotModuleBundleWatcherOptions {
  bundlePath: string;
  onModules: (modules: readonly DevSpaceModule[]) => void | Promise<void>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  debounceMs?: number;
}

export async function loadHotReloadableModules(
  bundlePath: string,
  revision: string | number = Date.now(),
): Promise<readonly DevSpaceModule[]> {
  const url = pathToFileURL(bundlePath);
  url.searchParams.set("devspace_hot_revision", String(revision));
  const loaded = await import(url.href) as { hotReloadableModules?: unknown };
  if (!Array.isArray(loaded.hotReloadableModules)) {
    throw new Error("Hot module bundle does not export hotReloadableModules.");
  }
  for (const module of loaded.hotReloadableModules) {
    if (!isDevSpaceModule(module)) {
      throw new Error("Hot module bundle exported an invalid module definition.");
    }
  }
  return loaded.hotReloadableModules;
}

export function watchHotModuleBundle(options: HotModuleBundleWatcherOptions): () => void {
  const intervalMs = options.intervalMs ?? 250;
  const debounceMs = options.debounceMs ?? 100;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let revision = 0;
  let reloading = false;
  let pending = false;

  const reload = async () => {
    timer = undefined;
    if (closed) return;
    if (reloading) {
      pending = true;
      return;
    }
    reloading = true;
    try {
      const modules = await loadHotReloadableModules(options.bundlePath, `${Date.now()}-${revision += 1}`);
      await options.onModules(modules);
    } catch (error) {
      options.onError?.(error);
    } finally {
      reloading = false;
      if (pending && !closed) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void reload(); }, debounceMs);
    timer.unref();
  };

  watchFile(options.bundlePath, { interval: intervalMs, persistent: false }, (current, previous) => {
    if (
      current.mtimeMs === previous.mtimeMs
      && current.ctimeMs === previous.ctimeMs
      && current.size === previous.size
      && current.ino === previous.ino
    ) return;
    schedule();
  });

  let nativeWatcher: FSWatcher | undefined;
  try {
    const targetName = basename(options.bundlePath);
    nativeWatcher = watch(dirname(options.bundlePath), { persistent: false }, (_eventType, filename) => {
      if (filename === null || filename.toString() === targetName) schedule();
    });
    nativeWatcher.on("error", (error) => options.onError?.(error));
  } catch (error) {
    options.onError?.(error);
  }

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    nativeWatcher?.close();
    unwatchFile(options.bundlePath);
  };
}

function isDevSpaceModule(value: unknown): value is DevSpaceModule {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { id?: unknown; register?: unknown; enabled?: unknown };
  return typeof record.id === "string"
    && record.id.length > 0
    && typeof record.register === "function"
    && (record.enabled === undefined || typeof record.enabled === "function");
}
