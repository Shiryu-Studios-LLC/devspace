import assert from "node:assert/strict";
import test from "node:test";
import { createYdotoolInputProvider } from "./desktop-input-ydotool.js";

test("ydotool input provider maps only validated high-level actions", async () => {
  const calls: Array<{ args: string[]; socket?: string }> = [];
  const input = createYdotoolInputProvider({
    socketPath: "/run/user/1000/.ydotool_socket",
    now: () => Date.parse("2026-09-20T12:00:00.000Z"),
    runYdotool: async (args, options) => {
      calls.push({ args, socket: options.env.YDOTOOL_SOCKET });
    },
  });

  await input({ type: "mouse-move", mode: "relative", x: 12, y: -4 });
  await input({ type: "mouse-click", button: "right", count: 2, nextDelayMs: 60 });
  await input({ type: "mouse-scroll", x: 1, y: -3 });
  await input({ type: "type-text", text: "literal $HOME; $(echo nope)", keyDelayMs: 5, keyHoldMs: 6 });
  const chord = await input({ type: "key-chord", key: "l", modifiers: ["ctrl", "shift"], keyDelayMs: 7 });

  assert.deepEqual(calls[0]?.args, ["mousemove", "--xpos", "12", "--ypos", "-4"]);
  assert.deepEqual(calls[1]?.args, ["click", "--repeat=2", "--next-delay=60", "0xC1"]);
  assert.deepEqual(calls[2]?.args, ["mousemove", "--wheel", "--xpos", "1", "--ypos", "-3"]);
  assert.deepEqual(calls[3]?.args, ["type", "--key-delay=5", "--key-hold=6", "--escape=0", "literal $HOME; $(echo nope)"]);
  assert.deepEqual(calls[4]?.args, ["key", "--key-delay=7", "29:1", "42:1", "38:1", "38:0", "42:0", "29:0"]);
  assert.equal(calls.every((call) => call.socket === "/run/user/1000/.ydotool_socket"), true);
  assert.equal(chord.completed, true);
  assert.equal(chord.completedAt, "2026-09-20T12:00:00.000Z");
});

test("ydotool input provider rejects unsafe bounds before execution", async () => {
  let calls = 0;
  const input = createYdotoolInputProvider({
    runYdotool: async () => {
      calls += 1;
    },
  });
  await assert.rejects(() => input({ type: "mouse-move", mode: "absolute", x: -1, y: 10 }), /outside the absolute bounds/);
  await assert.rejects(() => input({ type: "mouse-click", button: "left", count: 11 }), /between 1 and 10/);
  await assert.rejects(() => input({ type: "mouse-scroll", y: 121 }), /between -120 and 120/);
  await assert.rejects(() => input({ type: "type-text", text: "x".repeat(16_385) }), /at most 16384/);
  assert.equal(calls, 0);
});
