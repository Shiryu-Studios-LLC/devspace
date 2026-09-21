import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationAdapterMetadata,
  applicationIntegrations,
  genericAwarenessMetadata,
} from "./application-integrations.js";

test("named application integrations are optional secondary enhancements", () => {
  const byId = new Map(applicationIntegrations.map((integration) => [integration.id, integration]));
  for (const id of [
    "unity",
    "unreal",
    "blockbench",
    "steamvr",
    "obs",
    "shiryu-audio",
    "shiryugen",
    "browser",
  ]) {
    const integration = byId.get(id);
    assert.ok(integration, `${id} should be declared in the integration catalog`);
    assert.equal(integration.optional, true);
    assert.equal(integration.enabledByDefault, true);
    assert.equal(integration.sourceKind, "application-adapter");
    assert.equal(integration.sourcePriority, "secondary");
  }
});

test("generic desktop awareness remains the primary source", () => {
  assert.deepEqual(genericAwarenessMetadata, {
    sourceKind: "generic",
    sourcePriority: "primary",
  });
});

test("unknown custom integrations still default to optional secondary adapters", () => {
  assert.deepEqual(applicationAdapterMetadata("custom-mcp", "Custom MCP"), {
    application: "Custom MCP",
    optional: true,
    sourceKind: "application-adapter",
    sourcePriority: "secondary",
  });
});
