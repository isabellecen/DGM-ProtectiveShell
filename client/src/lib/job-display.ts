export type JobDisplayInput = {
  enabled: boolean;
  latestRunStatus?: string | null;
  latestEventStatus?: string | null;
};

const systemTypeLabels: Record<string, string> = {
  VEEAM: "Veeam",
  PBS: "Proxmox Backup Server",
  SYNOLOGY: "Synology",
};

export function systemTypeLabel(systemType: string): string {
  return systemTypeLabels[systemType] || "Unknown";
}

export function jobDisplayStatus(job: JobDisplayInput): string {
  if (!job.enabled) return "DISABLED";
  return job.latestRunStatus || job.latestEventStatus || "UNKNOWN";
}

export function jobStatusDetail(job: JobDisplayInput): string {
  if (!job.enabled) return "Disabled";
  if (job.latestRunStatus) return "Latest tracked run";
  if (job.latestEventStatus) return "Latest email event";
  return "No runs yet";
}
