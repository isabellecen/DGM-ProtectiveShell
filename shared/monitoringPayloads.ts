import { z } from "zod";

export const healthStatusSchema = z.enum(["OK", "WARN", "CRIT", "UNKNOWN"]);

export const backupDatastoreSchema = z
  .object({
    name: z.string().optional(),
    totalBytes: z.string().optional(),
    total_bytes: z.string().optional(),
    usedBytes: z.string().optional(),
    used_bytes: z.string().optional(),
    status: z.string().optional(),
    error: z.string().optional(),
    snapshotCount: z.number().int().nonnegative().nullable().optional(),
    shareCount: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();

export type BackupDatastore = z.infer<typeof backupDatastoreSchema>;

const proxmoxComponentStatusSchema = z.object({
  status: z.string(),
});

export const proxmoxHealthPayloadSchema = z
  .object({
    overall_status: healthStatusSchema.optional(),
    storage_type: z.string().optional(),
    components: z
      .object({
        zfs: proxmoxComponentStatusSchema
          .extend({
            pools: z.array(z.object({ name: z.string(), state: z.string() }).passthrough()).optional(),
          })
          .optional(),
        smart: proxmoxComponentStatusSchema
          .extend({
            disks_total: z.number().int().nonnegative().optional(),
            disks_warning: z.number().int().nonnegative().optional(),
            disks_failed: z.number().int().nonnegative().optional(),
          })
          .optional(),
        raid: proxmoxComponentStatusSchema
          .extend({
            virtual_disks_degraded: z.number().int().nonnegative().optional(),
            predictive_failures: z.number().int().nonnegative().optional(),
          })
          .optional(),
        mdadm: proxmoxComponentStatusSchema
          .extend({
            arrays_degraded: z.number().int().nonnegative().optional(),
          })
          .optional(),
      })
      .passthrough()
      .optional(),
    monitoring_error: z.string().nullable().optional(),
  })
  .passthrough();

export type ProxmoxHealthPayload = z.infer<typeof proxmoxHealthPayloadSchema>;

export function parseBackupDatastores(value: unknown): BackupDatastore[] {
  const result = z.array(backupDatastoreSchema).safeParse(value);
  return result.success ? result.data : [];
}

export function parseProxmoxHealthPayload(value: unknown): ProxmoxHealthPayload | null {
  const result = proxmoxHealthPayloadSchema.safeParse(value);
  return result.success ? result.data : null;
}
