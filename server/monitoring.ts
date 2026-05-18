import { and, eq, sql } from "drizzle-orm";
import { pollBackupTarget } from "./backupPoller";
import { collectProxmoxHealth } from "./proxmoxCollector";
import { db } from "./db";
import { backupTargets, incidents, proxmoxHosts } from "@shared/schema";
import { storage } from "./storage";
import { assertMonitoredTargetAllowed } from "./egress";

export async function runProxmoxHostCheck(hostId: number) {
  const host = await storage.getProxmoxHost(hostId);
  if (!host) {
    return undefined;
  }

  const timeoutSeconds = await numericSetting("SSH_TIMEOUT", 20);
  let result: Awaited<ReturnType<typeof collectProxmoxHealth>> | undefined;
  let connectHost: string | undefined;
  try {
    const allowedAddresses = await assertMonitoredTargetAllowed(host.host);
    connectHost = allowedAddresses[0];
  } catch (err) {
    result = {
      overall_status: "UNKNOWN",
      storage_type: "UNKNOWN",
      components: {
        smart: { status: "UNKNOWN", disks: [], disks_total: 0, disks_warning: 0, disks_failed: 0 },
        meta: { hostname: "" },
      },
      monitoring_error: err instanceof Error ? `EGRESS_BLOCKED: ${err.message}` : "EGRESS_BLOCKED",
    };
  }
  result ??= await collectProxmoxHealth({
    host: host.host,
    connectHost,
    port: host.port,
    username: host.username,
    password: host.password,
    hostKeyFingerprint: host.hostKeyFingerprint,
    allowInsecureHostKey: host.allowInsecureHostKey,
    timeoutSeconds,
  });

  const checkedAt = new Date();
  const check = await storage.createProxmoxCheck({
    hostId,
    checkedAt,
    overallStatus: result.overall_status,
    storageType: result.storage_type,
    payloadJson: result.components,
    monitoringError: result.monitoring_error,
  });

  const failed = result.monitoring_error !== null || result.overall_status === "UNKNOWN";
  const consecutiveFailures = failed ? host.consecutiveFailures + 1 : 0;
  await storage.updateProxmoxHost(hostId, {
    lastCheckAt: checkedAt,
    lastStatus: result.overall_status,
    lastStatusDetails: result,
    consecutiveFailures,
  });

  if (!failed) {
    await resolveOperationalIncidents("PROXMOX", hostId, `proxmox:${hostId}:unreachable`);
  }

  if (failed) {
    const threshold = await numericSetting("CONSECUTIVE_FAILURE_THRESHOLD", 3);
    if (consecutiveFailures >= threshold) {
      await upsertOperationalIncident({
        sourceType: "PROXMOX",
        sourceId: hostId,
        severity: "CRIT",
        title: `${host.name} unreachable`,
        details: `${result.monitoring_error || "SSH health check failed"} after ${consecutiveFailures} consecutive attempt(s).`,
        sourceFingerprint: `proxmox:${hostId}:unreachable`,
      });
    }
  } else if (result.overall_status === "WARN" || result.overall_status === "CRIT") {
    await upsertOperationalIncident({
      sourceType: "PROXMOX",
      sourceId: hostId,
      severity: result.overall_status === "CRIT" ? "CRIT" : "WARN",
      title: `${host.name} health is ${result.overall_status}`,
      details: summarizeHealthDetails(result),
      sourceFingerprint: `proxmox:${hostId}:health`,
    });
  } else if (result.overall_status === "OK") {
    await resolveOperationalIncidents("PROXMOX", hostId, `proxmox:${hostId}:`);
  }

  return check;
}

export async function pollBackupTargetAndPersist(targetId: number) {
  const target = await storage.getBackupTarget(targetId);
  if (!target) {
    return undefined;
  }

  let result: Awaited<ReturnType<typeof pollBackupTarget>> | undefined;
  let connectHost: string | undefined;
  try {
    const allowedAddresses = await assertMonitoredTargetAllowed(target.host);
    connectHost = allowedAddresses[0];
  } catch (err) {
    const message = err instanceof Error ? err.message : "Target host is blocked";
    result = {
      totalBytes: null,
      usedBytes: null,
      datastoresJson: null,
      pollStatus: "ERROR",
      pollError: `EGRESS_BLOCKED: ${message}`,
    };
  }
  result ??= await pollBackupTarget({
    type: target.type as "SYNOLOGY" | "PBS",
    host: target.host,
    connectHost,
    port: target.port,
    username: target.username,
    password: target.password,
    tlsFingerprint: target.tlsFingerprint,
    allowInsecureTls: target.allowInsecureTls,
  });

  const updateData: Parameters<typeof storage.updateBackupTarget>[1] = {
    lastPolledAt: new Date(),
    pollStatus: result.pollStatus,
    pollError: result.pollError,
  };

  if (result.pollStatus === "OK" && result.totalBytes && result.usedBytes) {
    updateData.totalBytes = result.totalBytes;
    updateData.usedBytes = result.usedBytes;
    updateData.datastoresJson = result.datastoresJson;
  }

  await storage.updateBackupTarget(targetId, updateData);

  if (result.pollStatus !== "ERROR") {
    await resolveOperationalIncidents("MONITOR", targetId, `backup-target:${targetId}:poll-error`);
  }

  if (result.pollStatus === "ERROR") {
    await upsertOperationalIncident({
      sourceType: "MONITOR",
      sourceId: targetId,
      severity: "CRIT",
      title: `${target.name} capacity poll failed`,
      details: result.pollError || "Backup target capacity could not be retrieved.",
      sourceFingerprint: `backup-target:${targetId}:poll-error`,
    });
  } else if (result.totalBytes && result.usedBytes) {
    const usagePercent = capacityPercent(result.usedBytes, result.totalBytes);
    if (usagePercent >= 90) {
      await upsertOperationalIncident({
        sourceType: "MONITOR",
        sourceId: targetId,
        severity: usagePercent >= 95 ? "CRIT" : "WARN",
        title: `${target.name} storage usage is ${usagePercent}%`,
        details: `Backup target ${target.name} is using ${usagePercent}% of available capacity.`,
        sourceFingerprint: `backup-target:${targetId}:capacity`,
      });
    } else {
      await resolveOperationalIncidents("MONITOR", targetId, `backup-target:${targetId}:`);
    }
  }

  const [updated] = await db
    .select()
    .from(backupTargets)
    .where(eq(backupTargets.id, targetId));
  return updated;
}

export async function listEnabledProxmoxHostIds(): Promise<number[]> {
  const rows = await db
    .select({ id: proxmoxHosts.id })
    .from(proxmoxHosts)
    .where(eq(proxmoxHosts.enabled, true));
  return rows.map((row) => row.id);
}

async function numericSetting(key: string, fallback: number): Promise<number> {
  const value = Number((await storage.getSettingValue(key)) || process.env[key] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function upsertOperationalIncident(data: {
  sourceType: "BACKUP" | "PROXMOX" | "MONITOR";
  sourceId: number;
  severity: "INFO" | "WARN" | "CRIT";
  title: string;
  details: string;
  sourceFingerprint: string;
}) {
  const [existing] = await db
    .select()
    .from(incidents)
    .where(eq(incidents.sourceFingerprint, data.sourceFingerprint));

  if (existing) {
    await db
      .update(incidents)
      .set({
        severity: data.severity,
        title: data.title,
        details: data.details,
        state: "OPEN",
        notificationSentAt: existing.details === data.details ? existing.notificationSentAt : null,
        updatedAt: new Date(),
      })
      .where(eq(incidents.id, existing.id));
    return;
  }

  await db.insert(incidents).values({
    ...data,
    state: "OPEN",
  });
}

async function resolveOperationalIncidents(
  sourceType: "PROXMOX" | "MONITOR",
  sourceId: number,
  fingerprintPrefix: string,
) {
  await db
    .update(incidents)
    .set({ state: "RESOLVED", updatedAt: new Date() })
    .where(
      and(
        eq(incidents.sourceType, sourceType),
        eq(incidents.sourceId, sourceId),
        sql`${incidents.state} <> 'RESOLVED'`,
        sql`${incidents.sourceFingerprint} LIKE ${`${fingerprintPrefix}%`}`,
      ),
    );
}

function capacityPercent(usedBytes: string, totalBytes: string): number {
  const used = Number(usedBytes);
  const total = Number(totalBytes);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.round((used / total) * 100);
}

function summarizeHealthDetails(result: Awaited<ReturnType<typeof collectProxmoxHealth>>): string {
  const parts: string[] = [];
  if (result.components.zfs?.status && result.components.zfs.status !== "OK") {
    parts.push(`ZFS: ${result.components.zfs.status}`);
  }
  if (result.components.raid?.status && result.components.raid.status !== "OK") {
    parts.push(`RAID: ${result.components.raid.status}`);
  }
  if (result.components.mdadm?.status && result.components.mdadm.status !== "OK") {
    parts.push(`mdadm: ${result.components.mdadm.status}`);
  }
  if (result.components.smart.status !== "OK") {
    parts.push(`SMART: ${result.components.smart.status}`);
  }
  return parts.length > 0 ? parts.join("; ") : `Overall status: ${result.overall_status}`;
}

export async function listEnabledBackupTargetIds(): Promise<number[]> {
  const rows = await db
    .select({ id: backupTargets.id })
    .from(backupTargets)
    .where(eq(backupTargets.enabled, true));
  return rows.map((row) => row.id);
}
