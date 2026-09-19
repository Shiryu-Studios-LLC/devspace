import assert from "node:assert/strict";
import { devSpaceAdminCtlPath, runDevSpaceAdminCtl } from "./devspace-admin-tools.js";

assert.equal(devSpaceAdminCtlPath({}, "win32"), "C:\\Program Files\\Shiryu Studios\\DevSpaceAdmin\\devspace-adminctl.exe");
assert.equal(devSpaceAdminCtlPath({}, "linux"), "/usr/local/bin/devspace-adminctl");
assert.equal(devSpaceAdminCtlPath({}, "darwin"), "/usr/local/bin/devspace-adminctl");
assert.equal(devSpaceAdminCtlPath({ DEVSPACE_ADMIN_CTL: " /custom/client " }, "linux"), "/custom/client");
const result = await runDevSpaceAdminCtl(["-e", "process.stdout.write(process.env.ADMIN_TEST_VALUE ?? '')"], {
  ...process.env, DEVSPACE_ADMIN_CTL: process.execPath, ADMIN_TEST_VALUE: "bridge environment passed",
});
assert.equal(result.ok, true);
assert.equal(result.stdout, "bridge environment passed");
const failed = await runDevSpaceAdminCtl(["-e", "process.exit(7)"], { ...process.env, DEVSPACE_ADMIN_CTL: process.execPath });
assert.equal(failed.ok, false);
assert.equal(failed.exitCode, 7);
console.log("Admin bridge checks passed.");
