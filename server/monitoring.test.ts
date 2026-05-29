import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:password@localhost:5432/protectiveshell_test";

const { monitoringInternals } = await import("./monitoring");

test("Proxmox classification separates unreachable failures from incomplete health data", () => {
  assert.deepEqual(
    monitoringInternals.classifyProxmoxCheckResult({
      monitoring_error: "SSH_TIMEOUT",
      overall_status: "UNKNOWN",
    }),
    { failed: true, incompleteHealthData: false },
  );

  assert.deepEqual(
    monitoringInternals.classifyProxmoxCheckResult({
      monitoring_error: null,
      overall_status: "UNKNOWN",
    }),
    { failed: false, incompleteHealthData: true },
  );

  assert.deepEqual(
    monitoringInternals.classifyProxmoxCheckResult({
      monitoring_error: null,
      overall_status: "OK",
    }),
    { failed: false, incompleteHealthData: false },
  );
});
