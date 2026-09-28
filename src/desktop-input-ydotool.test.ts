import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createYdotoolInputProvider, unixSocketRegistered } from "./desktop-input-ydotool.js";

test("input provider routes all desktop input through compositor-scoped EIS when available", async () => {
  const calls: Array<{ args: string[]; socket?: string }> = [];
  const eisCalls: Array<{ type: string; [key: string]: unknown }> = [];
  const input = createYdotoolInputProvider({
    socketPath: "/run/user/1000/.ydotool_socket",
    now: () => Date.parse("2026-09-20T12:00:00.000Z"),
    runYdotool: async (args, options) => {
      calls.push({ args, socket: options.env.YDOTOOL_SOCKET });
    },
    runEisInput: async (request) => {
      eisCalls.push({ ...request });
    },
  });

  await input({ type: "mouse-move", mode: "relative", x: 12, y: -4 });
  await input({ type: "mouse-move", mode: "absolute", x: 850, y: 510 });
  await input({ type: "mouse-click", button: "right", count: 2, nextDelayMs: 60 });
  await input({ type: "mouse-scroll", x: 1, y: -3 });
  await input({ type: "type-text", text: "literal $HOME; $(echo nope)", keyDelayMs: 5, keyHoldMs: 6 });
  const chord = await input({ type: "key-chord", key: "l", modifiers: ["ctrl", "shift"], keyDelayMs: 7 });

  assert.deepEqual(eisCalls, [
    { type: "mouse-move", mode: "relative", x: 12, y: -4 },
    { type: "mouse-move", mode: "absolute", x: 850, y: 510 },
    { type: "mouse-click", button: "right", count: 2, nextDelayMs: 60 },
    { type: "mouse-scroll", x: 1, y: -3 },
    { type: "type-text", text: "literal $HOME; $(echo nope)", keyDelayMs: 5, keyHoldMs: 6 },
    { type: "key-chord", key: "l", modifiers: ["ctrl", "shift"], keyDelayMs: 7 },
  ]);
  assert.deepEqual(calls, []);
  assert.equal(chord.completed, true);
  assert.equal(chord.completedAt, "2026-09-20T12:00:00.000Z");
});

test("ydotool availability rejects stale socket paths absent from the kernel socket table", () => {
  const directory = mkdtempSync(join(tmpdir(), "devspace-ydotool-test-"));
  const procNetUnix = join(directory, "unix");
  try {
    writeFileSync(
      procNetUnix,
      "Num RefCount Protocol Flags Type St Inode Path\n" +
        "0000000000000000: 00000002 00000000 00000000 0002 03 12345 /run/user/1000/.ydotool_socket\n",
      "utf8",
    );
    assert.equal(unixSocketRegistered("/run/user/1000/.ydotool_socket", procNetUnix), true);
    assert.equal(unixSocketRegistered("/run/user/1000/.stale_ydotool_socket", procNetUnix), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ydotool input provider rejects unsafe bounds before execution", async () => {
  let calls = 0;
  let eisCalls = 0;
  const input = createYdotoolInputProvider({
    runYdotool: async () => {
      calls += 1;
    },
    runEisInput: async () => {
      eisCalls += 1;
    },
  });
  await assert.rejects(() => input({ type: "mouse-move", mode: "absolute", x: -1, y: 10 }), /outside the absolute bounds/);
  await assert.rejects(() => input({ type: "mouse-click", button: "left", count: 11 }), /between 1 and 10/);
  await assert.rejects(() => input({ type: "mouse-scroll", y: 121 }), /between -120 and 120/);
  await assert.rejects(() => input({ type: "type-text", text: "x".repeat(16_385) }), /at most 16384/);
  assert.equal(calls, 0);
  assert.equal(eisCalls, 0);
});
