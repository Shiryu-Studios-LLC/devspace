import assert from "node:assert/strict";
import test from "node:test";
import { DevSpaceModuleRegistry } from "./registry.js";
import type { DevSpaceModuleContext } from "./types.js";

const context = {} as DevSpaceModuleContext;

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
