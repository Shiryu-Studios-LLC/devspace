import assert from "node:assert/strict";
import test from "node:test";
import { DevSpaceModuleRegistry } from "./registry.js";
import type { DevSpaceModuleContext } from "./types.js";

const context = { server: {} } as unknown as DevSpaceModuleContext;

test("secondary modules report ready after successful registration", () => {
  const registry = new DevSpaceModuleRegistry();
  let registered = false;

  const state = registry.register(
    {
      id: "ready-module",
      register: () => {
        registered = true;
      },
    },
    context,
  );

  assert.equal(registered, true);
  assert.deepEqual(state, { id: "ready-module", status: "ready" });
  assert.deepEqual(registry.list(), [state]);
});

test("disabled secondary modules do not register", () => {
  const registry = new DevSpaceModuleRegistry();
  let registered = false;

  const state = registry.register(
    {
      id: "disabled-module",
      enabled: () => false,
      register: () => {
        registered = true;
      },
    },
    context,
  );

  assert.equal(registered, false);
  assert.deepEqual(state, { id: "disabled-module", status: "disabled" });
});

test("dynamic module health enriches unified status without replacing registration state", async () => {
  const registry = new DevSpaceModuleRegistry();
  const registered = registry.register(
    {
      id: "upstream-mcp",
      register: () => undefined,
      health: async () => ({
        status: "degraded",
        detail: "0 ready, 1 unavailable, 1 disabled.",
        capabilities: [
          { id: "unity", status: "unavailable", detail: "Not reachable." },
          { id: "blockbench", status: "disabled", detail: "Disabled by configuration." },
        ],
      }),
    },
    context,
  );

  assert.deepEqual(registered, { id: "upstream-mcp", status: "ready" });
  assert.deepEqual(registry.list(), [registered]);
  assert.deepEqual(await registry.inspect(), [{
    id: "upstream-mcp",
    status: "degraded",
    detail: "0 ready, 1 unavailable, 1 disabled.",
    capabilities: [
      { id: "unity", status: "unavailable", detail: "Not reachable." },
      { id: "blockbench", status: "disabled", detail: "Disabled by configuration." },
    ],
  }]);
  assert.deepEqual(registry.list(), [registered]);
});

test("dynamic health failures degrade only the affected module", async () => {
  const registry = new DevSpaceModuleRegistry();
  registry.register({
    id: "broken-health",
    register: () => undefined,
    health: async () => {
      throw new Error("probe failed");
    },
  }, context);
  registry.register({ id: "healthy", register: () => undefined }, context);

  assert.deepEqual(await registry.inspect(), [
    { id: "broken-health", status: "degraded", error: "Health check failed: probe failed" },
    { id: "healthy", status: "ready" },
  ]);
});

test("hot reload replaces tracked module registrations in place", () => {
  const registry = new DevSpaceModuleRegistry();
  const active = new Set<string>();
  const server = {
    registerTool(name: string) {
      active.add(name);
      return {
        remove() {
          active.delete(name);
        },
      };
    },
  };
  const reloadContext = { server } as unknown as DevSpaceModuleContext;

  registry.register({
    id: "hot",
    register: ({ server: tracked }) => {
      tracked.registerTool("old_tool", { inputSchema: {} }, async () => ({ content: [] }));
    },
  }, reloadContext);
  assert.deepEqual([...active], ["old_tool"]);

  registry.reload({
    id: "hot",
    register: ({ server: tracked }) => {
      tracked.registerTool("new_tool", { inputSchema: {} }, async () => ({ content: [] }));
    },
  }, reloadContext);
  assert.deepEqual([...active], ["new_tool"]);
  assert.deepEqual(registry.get("hot"), { id: "hot", status: "ready" });

  assert.equal(registry.remove("hot"), true);
  assert.deepEqual([...active], []);
  assert.equal(registry.get("hot"), undefined);
});

test("a failed secondary module does not take down the registry", () => {
  const registry = new DevSpaceModuleRegistry();
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const failed = registry.register(
      {
        id: "failed-module",
        register: () => {
          throw new Error("boom");
        },
      },
      context,
    );
    const healthy = registry.register(
      {
        id: "healthy-module",
        register: () => undefined,
      },
      context,
    );

    assert.deepEqual(failed, { id: "failed-module", status: "failed", error: "boom" });
    assert.deepEqual(healthy, { id: "healthy-module", status: "ready" });
    assert.deepEqual(registry.list(), [failed, healthy]);
  } finally {
    console.error = originalError;
  }
});
