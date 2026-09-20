import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveDesktopPermissionPolicy,
  type StoredDesktopPermissionPolicy,
} from "./desktop-permissions.js";
import { watchDesktopPermissionPolicy } from "./desktop-permission-watcher.js";

test("desktop permission watcher hot-reloads config changes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "devspace-permission-watch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ desktopPermissions: { windows: true } }));

  const applied: boolean[] = [];
  let errors = 0;
  const stop = watchDesktopPermissionPolicy({
    configPath,
    intervalMs: 20,
    debounceMs: 10,
    loadPolicy: () => {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
        desktopPermissions?: StoredDesktopPermissionPolicy;
      };
      return resolveDesktopPermissionPolicy(parsed.desktopPermissions);
    },
    applyPolicy: (policy) => applied.push(policy.windows),
    onError: () => { errors += 1; },
  });
  t.after(stop);

  await waitFor(() => applied.at(-1) === true);

  writeFileSync(configPath, JSON.stringify({ desktopPermissions: { windows: false } }));
  await waitFor(() => applied.at(-1) === false);

  writeFileSync(configPath, "{");
  await waitFor(() => errors === 1);
  assert.equal(applied.at(-1), false);

  writeFileSync(configPath, JSON.stringify({ desktopPermissions: { windows: true } }));
  await waitFor(() => applied.at(-1) === true);
});

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition did not become true before timeout");
}
