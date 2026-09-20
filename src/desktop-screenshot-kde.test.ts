import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { createKdeScreenCaptureProvider } from "./desktop-screenshot-kde.js";

test("KDE screenshot provider writes private captures and maps area options", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-screen-capture-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let helperArgs: string[] = [];
  const capture = createKdeScreenCaptureProvider(stateDir, {
    helperPath: "/test/devspace-screenshot-helper",
    now: () => Date.parse("2026-09-20T12:00:00.000Z"),
    runHelper: async (args) => {
      helperArgs = [...args];
      await writeFile(args[1]!, Buffer.from([0x89, 0x50, 0x4e, 0x47]), { mode: 0o666 });
      return { stdout: JSON.stringify({ width: 320, height: 180, scale: 1.25 }) };
    },
  });

  const result = await capture({
    target: "area",
    x: 10,
    y: 20,
    width: 320,
    height: 180,
    includeCursor: true,
    nativeResolution: false,
  });

  assert.equal(result.target, "area");
  assert.equal(result.width, 320);
  assert.equal(result.height, 180);
  assert.equal(result.scale, 1.25);
  assert.equal(result.x, 10);
  assert.equal(result.y, 20);
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.capturedAt, "2026-09-20T12:00:00.000Z");
  assert.equal(relative(join(stateDir, "captures"), result.path).startsWith(".."), false);
  const output = await stat(result.path);
  assert.equal(output.mode & 0o777, 0o600);
  assert.deepEqual(
    helperArgs.filter((arg) => !arg.endsWith(".png")),
    ["area", "10", "20", "320", "180", "--include-cursor=true", "--native-resolution=false"],
  );
});

test("KDE screenshot provider validates target-specific input before helper execution", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-screen-capture-invalid-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let calls = 0;
  const capture = createKdeScreenCaptureProvider(stateDir, {
    helperPath: "/test/devspace-screenshot-helper",
    runHelper: async () => {
      calls += 1;
      return { stdout: "{}" };
    },
  });

  await assert.rejects(
    () => capture({ target: "window" }),
    /requires a window ID/,
  );
  await assert.rejects(
    () => capture({ target: "area", x: 0, y: 0, width: 0, height: 10 }),
    /positive width\/height/,
  );
  assert.equal(calls, 0);
});
