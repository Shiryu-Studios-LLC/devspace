import assert from "node:assert/strict";
import test from "node:test";
import { invokeDevspaceAdmin } from "./devspace-admin.js";

test("Admin broker wrapper preserves successful stdout without a shell", async () => {
  const response = await invokeDevspaceAdmin(
    ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "value;echo unsafe"],
    process.execPath,
  );

  assert.equal(response.ok, true);
  assert.equal(response.exit_code, 0);
  assert.equal(response.stderr, "");
  assert.deepEqual(JSON.parse(response.stdout), ["value;echo unsafe"]);
});

test("Admin broker wrapper surfaces command failures", async () => {
  const response = await invokeDevspaceAdmin(
    ["-e", "process.stderr.write('not allowed');process.exit(7)"],
    process.execPath,
  );

  assert.equal(response.ok, false);
  assert.equal(response.exit_code, 7);
  assert.equal(response.stderr, "not allowed");
  assert.match(response.result, /not allowed/);
});

test("Admin broker wrapper returns an actionable error when unavailable", async () => {
  const response = await invokeDevspaceAdmin(["status"], "/nonexistent/devspace-adminctl");

  assert.equal(response.ok, false);
  assert.equal(response.exit_code, null);
  assert.match(response.result, /ENOENT/);
});
