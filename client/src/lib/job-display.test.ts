import assert from "node:assert/strict";
import test from "node:test";
import { jobDisplayStatus, jobStatusDetail, systemTypeLabel } from "./job-display";

test("system type labels include Synology jobs", () => {
  assert.equal(systemTypeLabel("SYNOLOGY"), "Synology");
  assert.equal(systemTypeLabel("PBS"), "Proxmox Backup Server");
  assert.equal(systemTypeLabel("UNKNOWN"), "Unknown");
});

test("job display status is based on observed job data instead of enabled state", () => {
  assert.equal(jobDisplayStatus({ enabled: true }), "UNKNOWN");
  assert.equal(jobStatusDetail({ enabled: true }), "No runs yet");
  assert.equal(jobDisplayStatus({ enabled: true, latestEventStatus: "OK" }), "OK");
  assert.equal(jobDisplayStatus({ enabled: true, latestRunStatus: "FAIL", latestEventStatus: "OK" }), "FAIL");
  assert.equal(jobDisplayStatus({ enabled: false, latestRunStatus: "OK" }), "DISABLED");
});
