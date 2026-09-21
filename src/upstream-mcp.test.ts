import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUpstreamMcpHealth } from "./upstream-mcp.js";

test("upstream health stays ready when configured servers are ready or disabled", () => {
  assert.deepEqual(summarizeUpstreamMcpHealth([
    { server: "unity", status: "ready" },
    { server: "blockbench", status: "disabled" },
  ]), {
    status: "ready",
    detail: "1 ready, 0 unavailable, 1 disabled.",
    capabilities: [
      {
        id: "unity",
        status: "ready",
        detail: "Reachable.",
        application: "Unity",
        optional: true,
        sourceKind: "application-adapter",
        sourcePriority: "secondary",
      },
      {
        id: "blockbench",
        status: "disabled",
        detail: "Disabled by configuration.",
        application: "Blockbench",
        optional: true,
        sourceKind: "application-adapter",
        sourcePriority: "secondary",
      },
    ],
  });
});

test("one unavailable upstream degrades only the upstream bridge module", () => {
  assert.deepEqual(summarizeUpstreamMcpHealth([
    { server: "unity", status: "unavailable", error: "connection refused" },
    { server: "unreal", status: "ready" },
    { server: "blockbench", status: "disabled" },
  ]), {
    status: "degraded",
    detail: "1 ready, 1 unavailable, 1 disabled.",
    capabilities: [
      {
        id: "unity",
        status: "unavailable",
        detail: "Configured upstream MCP server is not reachable.",
        application: "Unity",
        optional: true,
        sourceKind: "application-adapter",
        sourcePriority: "secondary",
        error: "connection refused",
      },
      {
        id: "unreal",
        status: "ready",
        detail: "Reachable.",
        application: "Unreal",
        optional: true,
        sourceKind: "application-adapter",
        sourcePriority: "secondary",
      },
      {
        id: "blockbench",
        status: "disabled",
        detail: "Disabled by configuration.",
        application: "Blockbench",
        optional: true,
        sourceKind: "application-adapter",
        sourcePriority: "secondary",
      },
    ],
  });
});

test("no configured upstreams is a healthy empty capability set", () => {
  assert.deepEqual(summarizeUpstreamMcpHealth([]), {
    status: "ready",
    detail: "No upstream MCP servers are configured.",
    capabilities: [],
  });
});
