import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadHotReloadableModules, watchHotModuleBundle } from "./hot-loader.js";

test("hot module bundle loads fresh code and watches replacements", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "devspace-hot-modules-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundlePath = join(dir, "hot-modules.mjs");
  writeFileSync(bundlePath, 'export const hotReloadableModules=[{id:"one",register(){}}];\n');

  assert.deepEqual((await loadHotReloadableModules(bundlePath, "initial")).map((module) => module.id), ["one"]);

  const seen: string[][] = [];
  const stop = watchHotModuleBundle({
    bundlePath,
    intervalMs: 20,
    debounceMs: 10,
    onModules: (modules) => {
      seen.push(modules.map((module) => module.id));
    },
  });
  t.after(stop);

  writeFileSync(bundlePath, 'export const hotReloadableModules=[{id:"two",register(){}}];\n');
  await waitFor(() => seen.some((ids) => ids[0] === "two"));
});

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition did not become true before timeout");
}
