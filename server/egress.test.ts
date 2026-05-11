import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:password@localhost:5432/protectiveshell_test";

const { assertMonitoredTargetAllowed, isAllowedByConfiguredCidrs, isBlockedTargetAddress } =
  await import("./egress");

test("egress guard blocks loopback and link-local targets", async () => {
  assert.equal(isBlockedTargetAddress("127.0.0.1"), true);
  assert.equal(isBlockedTargetAddress("169.254.169.254"), true);
  assert.equal(isBlockedTargetAddress("192.168.1.10"), false);

  await assert.rejects(assertMonitoredTargetAllowed("127.0.0.1"), /blocked address/);
  await assert.rejects(assertMonitoredTargetAllowed("metadata.google.internal"), /blocked/);
});

test("egress allowlist restricts monitored target CIDRs when configured", () => {
  const previous = process.env.MONITORED_TARGET_ALLOW_CIDRS;
  process.env.MONITORED_TARGET_ALLOW_CIDRS = "192.168.1.0/24,10.0.0.0/8";
  try {
    assert.equal(isAllowedByConfiguredCidrs("192.168.1.20"), true);
    assert.equal(isAllowedByConfiguredCidrs("192.168.2.20"), false);
    assert.equal(isAllowedByConfiguredCidrs("10.5.0.1"), true);
  } finally {
    if (previous === undefined) {
      delete process.env.MONITORED_TARGET_ALLOW_CIDRS;
    } else {
      process.env.MONITORED_TARGET_ALLOW_CIDRS = previous;
    }
  }
});
