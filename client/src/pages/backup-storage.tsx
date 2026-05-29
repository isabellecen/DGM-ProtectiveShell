import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Database,
  HardDrive,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Server,
  Archive,
  Plus,
  Pencil,
  Trash2,
} from "lucide-react";
import type { BackupTarget, Customer } from "@shared/schema";
import { parseBackupDatastores } from "@shared/monitoringPayloads";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { ConfirmActionButton } from "@/components/confirm-action";
import { buildBackupTargetPayload } from "@/lib/workflow-payloads";

type TargetWithCustomer = BackupTarget & { customerName?: string };

function formatBytes(bytesStr: string | null): string {
  if (!bytesStr) return "N/A";
  const bytes = parseFloat(bytesStr);
  if (isNaN(bytes) || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function getUsagePercent(used: string | null, total: string | null): number {
  if (!used || !total) return 0;
  const u = parseFloat(used);
  const t = parseFloat(total);
  if (isNaN(u) || isNaN(t) || t === 0) return 0;
  return Math.round((u / t) * 100);
}

function getUsageColor(percent: number): string {
  if (percent >= 90) return "bg-red-500";
  if (percent >= 75) return "bg-amber-500";
  return "bg-emerald-500";
}

function getUsageTextColor(percent: number): string {
  if (percent >= 90) return "text-red-600 dark:text-red-400";
  if (percent >= 75) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

function UsageBar({
  used,
  total,
  label,
  detail,
}: {
  used: string | null;
  total: string | null;
  label?: string;
  detail?: string;
}) {
  const percent = getUsagePercent(used, total);
  const freeBytes = total && used ? (parseFloat(total) - parseFloat(used)).toString() : null;

  return (
    <div className="space-y-1.5">
      {label && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-sm font-medium">{label}</span>
          {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
        </div>
      )}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2.5 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${getUsageColor(percent)}`}
            style={{ width: `${Math.min(percent, 100)}%` }}
            data-testid="bar-usage"
          />
        </div>
        <span className={`text-sm font-semibold tabular-nums min-w-[3rem] text-right ${getUsageTextColor(percent)}`} data-testid="text-usage-percent">
          {percent}%
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground flex-wrap">
        <span>{formatBytes(used)} used of {formatBytes(total)}</span>
        <span>{formatBytes(freeBytes)} free</span>
      </div>
    </div>
  );
}

function TargetDialog({
  open,
  onOpenChange,
  target,
  customers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target?: BackupTarget;
  customers: Customer[];
}) {
  const { toast } = useToast();
  const isEditing = !!target;

  const [name, setName] = useState(target?.name || "");
  const [type, setType] = useState(target?.type || "PBS");
  const [host, setHost] = useState(target?.host || "");
  const [port, setPort] = useState(target?.port?.toString() || "8007");
  const [username, setUsername] = useState(target?.username || "root@pam");
  const [password, setPassword] = useState("");
  const [tlsFingerprint, setTlsFingerprint] = useState(target?.tlsFingerprint || "");
  const [allowInsecureTls, setAllowInsecureTls] = useState(target?.allowInsecureTls ?? false);
  const [customerId, setCustomerId] = useState(target?.customerId?.toString() || "none");
  const [enabled, setEnabled] = useState(target?.enabled !== false);

  const mutation = useMutation({
    mutationFn: async () => {
      const payload = buildBackupTargetPayload({
        name,
        type,
        host,
        port,
        username,
        password,
        tlsFingerprint,
        allowInsecureTls,
        customerId,
        enabled,
      }, isEditing);
      if (isEditing) {
        return apiRequest("PATCH", `/api/backup-targets/${target.id}`, payload);
      }
      return apiRequest("POST", "/api/backup-targets", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/backup-targets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      toast({ title: isEditing ? "Target updated" : "Target added" });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Backup Target" : "Add Backup Target"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="target-name">Display Name</Label>
            <Input
              id="target-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Primary PBS Server"
              data-testid="input-target-name"
            />
          </div>
          <div>
            <Label>Server Type</Label>
            <Select value={type} onValueChange={(v) => {
              setType(v);
              if (v === "PBS" && port === "5001") setPort("8007");
              if (v === "SYNOLOGY" && port === "8007") setPort("5001");
            }}>
              <SelectTrigger data-testid="select-target-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PBS">Proxmox Backup Server</SelectItem>
                <SelectItem value="SYNOLOGY">Synology NAS</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Label htmlFor="target-host">Host / IP</Label>
              <Input
                id="target-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.100"
                data-testid="input-target-host"
              />
            </div>
            <div>
              <Label htmlFor="target-port">Port</Label>
              <Input
                id="target-port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                data-testid="input-target-port"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="target-user">Username</Label>
              <Input
                id="target-user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={type === "PBS" ? "root@pam" : "admin"}
                data-testid="input-target-user"
              />
            </div>
            <div>
              <Label htmlFor="target-pass">Password / API Token</Label>
              <Input
                id="target-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isEditing ? "(unchanged)" : ""}
                data-testid="input-target-pass"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="target-tls-fingerprint">TLS Certificate Fingerprint</Label>
            <Input
              id="target-tls-fingerprint"
              value={tlsFingerprint}
              onChange={(e) => setTlsFingerprint(e.target.value)}
              placeholder="SHA256 fingerprint"
              data-testid="input-target-tls-fingerprint"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <div>
              <Label htmlFor="allow-insecure-tls">Allow self-signed TLS</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Prefer a pinned fingerprint for production targets.</p>
            </div>
            <Switch
              id="allow-insecure-tls"
              checked={allowInsecureTls}
              onCheckedChange={setAllowInsecureTls}
              data-testid="switch-allow-insecure-tls"
            />
          </div>
          <div>
            <Label>Customer</Label>
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger data-testid="select-target-customer">
                <SelectValue placeholder="Select customer (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No customer</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id.toString()}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="target-enabled">Enabled</Label>
            <Switch
              id="target-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              data-testid="switch-target-enabled"
            />
          </div>
          <Button
            className="w-full"
            onClick={() => mutation.mutate()}
            disabled={!name || !host || (!password && !isEditing) || mutation.isPending}
            data-testid="button-save-target"
          >
            {mutation.isPending ? "Saving..." : isEditing ? "Update Target" : "Add Target"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TargetCard({
  target,
  onEdit,
  onDelete,
}: {
  target: TargetWithCustomer;
  onEdit: (target: BackupTarget) => void;
  onDelete: (id: number) => void;
}) {
  const { toast } = useToast();
  const pollMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/backup-targets/${target.id}/poll`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/backup-targets"] });
      toast({ title: "Poll completed", description: `Updated capacity data for ${target.name}` });
    },
    onError: () => {
      toast({ title: "Poll failed", description: "Could not retrieve capacity data", variant: "destructive" });
    },
  });

  const datastores = parseBackupDatastores(target.datastoresJson);
  const percent = getUsagePercent(target.usedBytes, target.totalBytes);
  const hasCapacity = target.totalBytes && target.usedBytes;
  const isError = target.pollStatus === "ERROR";
  const isWarn = target.pollStatus === "WARN";
  const isDisabled = !target.enabled;

  return (
    <Card
      className={isDisabled ? "opacity-60" : ""}
      data-testid={`card-target-${target.id}`}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <CardTitle className="text-base font-semibold truncate">{target.name}</CardTitle>
            <Badge variant="outline" className="text-[10px]" data-testid={`badge-type-${target.id}`}>
              {target.type === "PBS" ? (
                <Server className="h-3 w-3 mr-1" />
              ) : (
                <Database className="h-3 w-3 mr-1" />
              )}
              {target.type}
            </Badge>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
            <span>{target.host}:{target.port}</span>
            {target.customerName && (
              <>
                <span>-</span>
                <span>{target.customerName}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {isDisabled && <Badge variant="secondary" className="text-[10px]">Disabled</Badge>}
          <StatusBadge status={isError ? "CRIT" : isWarn ? "WARN" : isDisabled ? "UNKNOWN" : hasCapacity ? (percent >= 90 ? "WARN" : "OK") : "UNKNOWN"} />
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onEdit(target)}
            data-testid={`button-edit-target-${target.id}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <ConfirmActionButton
            size="icon"
            variant="ghost"
            title={`Remove ${target.name}?`}
            description="Capacity data for this backup target will be removed and open monitor incidents will be resolved."
            confirmLabel="Remove"
            onConfirm={() => onDelete(target.id)}
            data-testid={`button-delete-target-${target.id}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </ConfirmActionButton>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {(isError || isWarn) && (
          <div
            className={`flex items-center gap-2 text-sm ${isError ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}
            data-testid={`text-error-${target.id}`}
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="truncate">{target.pollError || (isError ? "Connection error" : "Partial capacity data")}</span>
          </div>
        )}

        {hasCapacity && (
          <UsageBar
            used={target.usedBytes}
            total={target.totalBytes}
            label="Total Capacity"
          />
        )}

        {!hasCapacity && !isError && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <HardDrive className="h-4 w-4" />
            <span>No capacity data available</span>
          </div>
        )}

        {datastores.length > 0 && (
          <div className="space-y-3 pt-1">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {target.type === "PBS" ? "Datastores" : "Volumes"}
            </div>
            {datastores.map((ds, i) => (
              <div key={i} className="pl-0" data-testid={`row-datastore-${target.id}-${i}`}>
                {ds.error ? (
                  <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span className="truncate">{ds.name || "Datastore"}: {ds.error}</span>
                  </div>
                ) : (
                  <UsageBar
                    used={ds.usedBytes ?? ds.used_bytes ?? null}
                    total={ds.totalBytes ?? ds.total_bytes ?? null}
                    label={ds.name}
                    detail={
                      ds.snapshotCount != null
                        ? `${ds.snapshotCount} snapshots`
                        : ds.shareCount != null
                        ? `${ds.shareCount} shares`
                        : undefined
                    }
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/50">
          <div className="text-xs text-muted-foreground" data-testid={`text-last-polled-${target.id}`}>
            {target.lastPolledAt ? (
              <>Last polled {formatDistanceToNow(new Date(target.lastPolledAt), { addSuffix: true })}</>
            ) : (
              "Never polled"
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={pollMutation.isPending || isDisabled}
            onClick={() => pollMutation.mutate()}
            data-testid={`button-poll-${target.id}`}
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${pollMutation.isPending ? "animate-spin" : ""}`} />
            Poll Now
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
      {[...Array(4)].map((_, i) => (
        <Card key={i}>
          <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-3">
            <div className="space-y-2 flex-1">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-5 w-12" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2.5 w-full rounded-full" />
              <div className="flex justify-between">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function BackupStorage() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTarget, setEditingTarget] = useState<BackupTarget | undefined>();

  const { data: targets, isLoading } = useQuery<TargetWithCustomer[]>({
    queryKey: ["/api/backup-targets"],
    refetchInterval: 60_000,
  });

  const { data: customers } = useQuery<Customer[]>({
    queryKey: ["/api/customers"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("DELETE", `/api/backup-targets/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/backup-targets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      toast({ title: "Target removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleNew = () => {
    setEditingTarget(undefined);
    setDialogOpen(true);
  };

  const handleEdit = (target: BackupTarget) => {
    setEditingTarget(target);
    setDialogOpen(true);
  };

  const handleDelete = (id: number) => {
    deleteMutation.mutate(id);
  };

  const enabledTargets = targets?.filter((t) => t.enabled) || [];
  const disabledTargets = targets?.filter((t) => !t.enabled) || [];

  const totalCapacity = enabledTargets.reduce((acc, t) => acc + (t.totalBytes ? parseFloat(t.totalBytes) : 0), 0);
  const totalUsed = enabledTargets.reduce((acc, t) => acc + (t.usedBytes ? parseFloat(t.usedBytes) : 0), 0);
  const overallPercent = totalCapacity > 0 ? Math.round((totalUsed / totalCapacity) * 100) : 0;
  const criticalTargets = enabledTargets.filter((t) => getUsagePercent(t.usedBytes, t.totalBytes) >= 90);
  const warningTargets = enabledTargets.filter((t) => {
    const p = getUsagePercent(t.usedBytes, t.totalBytes);
    return p >= 75 && p < 90;
  });
  const errorTargets = enabledTargets.filter((t) => t.pollStatus === "ERROR");
  const partialTargets = enabledTargets.filter((t) => t.pollStatus === "WARN");
  const warningTargetCount = new Set([
    ...criticalTargets.map((target) => target.id),
    ...warningTargets.map((target) => target.id),
    ...errorTargets.map((target) => target.id),
    ...partialTargets.map((target) => target.id),
  ]).size;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
            Backup Storage
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Capacity and remaining space for Synology and Proxmox Backup Server targets
          </p>
        </div>
        <Button onClick={handleNew} data-testid="button-add-target">
          <Plus className="h-4 w-4 mr-2" />
          Add Target
        </Button>
      </div>

      {isLoading ? (
        <LoadingSkeleton />
      ) : (
        <>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 mb-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total Targets</CardTitle>
                <Archive className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold" data-testid="text-total-targets">{enabledTargets.length}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {enabledTargets.filter(t => t.type === "PBS").length} PBS, {enabledTargets.filter(t => t.type === "SYNOLOGY").length} Synology
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Overall Usage</CardTitle>
                <HardDrive className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${getUsageTextColor(overallPercent)}`} data-testid="text-overall-usage">
                  {overallPercent}%
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatBytes(totalUsed.toString())} of {formatBytes(totalCapacity.toString())}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Warnings</CardTitle>
                <AlertTriangle className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${criticalTargets.length > 0 || errorTargets.length > 0 ? "text-red-600 dark:text-red-400" : warningTargets.length > 0 || partialTargets.length > 0 ? "text-amber-600 dark:text-amber-400" : ""}`} data-testid="text-warnings">
                  {warningTargetCount}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {criticalTargets.length > 0 && `${criticalTargets.length} critical`}
                  {criticalTargets.length > 0 && warningTargets.length > 0 && ", "}
                  {warningTargets.length > 0 && `${warningTargets.length} high usage`}
                  {(criticalTargets.length > 0 || warningTargets.length > 0) && partialTargets.length > 0 && ", "}
                  {partialTargets.length > 0 && `${partialTargets.length} partial`}
                  {(criticalTargets.length > 0 || warningTargets.length > 0 || partialTargets.length > 0) && errorTargets.length > 0 && ", "}
                  {errorTargets.length > 0 && `${errorTargets.length} errors`}
                  {warningTargetCount === 0 && "All targets healthy"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Free Space</CardTitle>
                <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold" data-testid="text-free-space">
                  {formatBytes((totalCapacity - totalUsed).toString())}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Available across all targets
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
            {enabledTargets.map((target) => (
              <TargetCard key={target.id} target={target} onEdit={handleEdit} onDelete={handleDelete} />
            ))}
            {disabledTargets.map((target) => (
              <TargetCard key={target.id} target={target} onEdit={handleEdit} onDelete={handleDelete} />
            ))}
          </div>

          {(!targets || targets.length === 0) && (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Database className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-1">No Backup Targets</h3>
                <p className="text-sm text-muted-foreground max-w-sm mb-4">
                  Add Synology NAS or Proxmox Backup Server targets to monitor their storage capacity
                </p>
                <Button onClick={handleNew} data-testid="button-add-target-empty">
                  <Plus className="h-4 w-4 mr-2" />
                  Add First Target
                </Button>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <TargetDialog
        key={editingTarget?.id ?? "new"}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        target={editingTarget}
        customers={customers || []}
      />
    </div>
  );
}
