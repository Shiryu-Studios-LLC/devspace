import assert from "node:assert/strict";
import test from "node:test";
import {
  createAtspiAccessibilityActionProvider,
  createAtspiAccessibilityProvider,
} from "./desktop-accessibility-atspi.js";

test("AT-SPI provider bounds traversal arguments and decodes normalized output", async () => {
  let receivedArgs: string[] = [];
  const provider = createAtspiAccessibilityProvider({
    runHelper: async (args) => {
      receivedArgs = args;
      return {
        stdout: `${JSON.stringify({
          generatedAt: "2026-09-20T12:00:00.000Z",
          applicationCount: 1,
          nodeCount: 1,
          truncated: false,
          maxDepth: 3,
          maxNodes: 120,
          nodes: [{
            id: "app-0",
            depth: 0,
            application: "Example",
            accessibleId: "org.example.App",
            processId: 123,
            name: "Example",
            description: "",
            role: "application",
            localizedRole: "application",
            childCount: 0,
            states: ["enabled", "visible"],
            interfaces: ["Accessible", "Application"],
            actions: [],
            bounds: { x: 0, y: 0, width: 800, height: 600 },
          }],
        })}\n`,
      };
    },
  });

  const snapshot = await provider({ application: "Example", maxDepth: 3, maxNodes: 120 });
  assert.deepEqual(receivedArgs, [
    "snapshot",
    "--max-depth",
    "3",
    "--max-nodes",
    "120",
    "--application",
    "Example",
  ]);
  assert.equal(snapshot.applicationCount, 1);
  assert.equal(snapshot.nodes[0]?.accessibleId, "org.example.App");
});

test("AT-SPI action provider maps guarded semantic action arguments", async () => {
  let receivedArgs: string[] = [];
  const provider = createAtspiAccessibilityActionProvider({
    runHelper: async (args) => {
      receivedArgs = args;
      return {
        stdout: `${JSON.stringify({
          performed: true,
          nodeId: "pid-123.0",
          actionIndex: 0,
          actionName: "click",
          performedAt: "2026-09-20T12:00:00.000Z",
        })}\n`,
      };
    },
  });
  const result = await provider({
    nodeId: "pid-123.0",
    actionIndex: 0,
    expectedRole: "push button",
    expectedName: "OK",
    expectedAccessibleId: "ok-button",
  });
  assert.deepEqual(receivedArgs, [
    "action",
    "--node-id",
    "pid-123.0",
    "--action-index",
    "0",
    "--expected-role",
    "push button",
    "--expected-name",
    "OK",
    "--expected-accessible-id",
    "ok-button",
  ]);
  assert.equal(result.performed, true);
});

test("AT-SPI provider rejects out-of-range traversal bounds before helper execution", async () => {
  let calls = 0;
  const provider = createAtspiAccessibilityProvider({
    runHelper: async () => {
      calls += 1;
      return { stdout: "{}" };
    },
  });
  await assert.rejects(() => provider({ maxDepth: 9 }), /maxDepth/);
  await assert.rejects(() => provider({ maxNodes: 501 }), /maxNodes/);
  assert.equal(calls, 0);
});
