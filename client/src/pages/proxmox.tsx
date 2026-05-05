import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
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
import {
  Plus,
  Server,
  Pencil,
  Trash2,
  Wifi,
  WifiOff,
  Play,
  HardDrive,
  AlertTriangle,
  Clock,
  ExternalLink,
} from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useLocation } from "wouter";
import type { ProxmoxHost, Customer } from "@shared/schema";
import { format } from "date-fns";

interface HealthPayload {
  overall_status?: string;
  storage_type?: string;
  components?: {
    zfs?: {
      status: string;
      pools?: { name: string; state: string }[];
    };
    smart?: {
      status: string;
      disks_total?: number;
      disks_warning?: number;
      disks_failed?: number;
    };
    raid?: {
      status: string;
      virtual_disks_degraded?: number;
      predictive_failures?: number;
    };
    mdadm?: {
      status: string;
      arrays_degraded?: number;
    };
  };
  monitoring_error?: string | null;
}

interface ProxmoxHostWithCustomer extends ProxmoxHost {
  customerName?: string;
}

function getHealthSummaryLines(payload: HealthPayload | null | undefined): string[] {
  if (!payload) return ["No check data available"];

  if (payload.monitoring_error) {
    const errorLabels: Record<string, string> = {
      SSH_TIMEOUT: "SSH timeout",
      AUTH_FAILED: "Authentication failed",
      SUDO_DENIED: "Sudo access denied",
      TOOL_MISSING: "Required tool missing",
    };
    return [`Monitoring Error: ${errorLabels[payload.monitoring_error] || payload.monitoring_error}`];
  }

  if (payload.overall_status === "OK") {
    return ["All storage healthy"];
  }

  const lines: string[] = [];
  const comp = payload.components;
  if (!comp) return ["No component data"];

  if (comp.zfs) {
    const degraded = comp.zfs.pools?.filter(p => p.state !== "ONLINE") || [];
    if (degraded.length > 0) {
      lines.push(`Pools: ${comp.zfs.pools!.length} total (${degraded.length} DEGRADED)`);
    } else {
      lines.push(`Storage: ${payload.storage_type || "ZFS"}`);
    }
  }

  if (comp.raid) {
    if (comp.raid.virtual_disks_degraded && comp.raid.virtual_disks_degraded > 0) {
      lines.push(`RAID: ${comp.raid.virtual_disks_degraded} Virtual Disk DEGRADED`);
    }
    if (comp.raid.predictive_failures && comp.raid.predictive_failures > 0) {
      lines.push(`SMART: ${comp.raid.predictive_failures} predictive failure`);
    }
  }

  if (comp.smart) {
    if (comp.smart.disks_failed && comp.smart.disks_failed > 0) {
      lines.push(`SMART: ${comp.smart.disks_failed} disk FAILED`);
    } else if (comp.smart.disks_warning && comp.smart.disks_warning > 0) {
      lines.push(`Disks: ${comp.smart.disks_warning} SMART warning`);
    }
  }

  if (comp.mdadm && comp.mdadm.arrays_degraded && comp.mdadm.arrays_degraded > 0) {
    lines.push(`mdadm: ${comp.mdadm.arrays_degraded} array DEGRADED`);
  }

  return lines.length > 0 ? lines.slice(0, 3) : ["All storage healthy"];
}

function getComponentBadges(payload: HealthPayload | null | undefined) {
  if (!payload || !payload.components) return [];
  const badges: { label: string; status: string }[] = [];
  const comp = payload.components;
  if (comp.zfs) badges.push({ label: "ZFS", status: comp.zfs.status });
  if (comp.smart) badges.push({ label: "SMART", status: comp.smart.status });
  if (comp.raid) badges.push({ label: "RAID", status: comp.raid.status });
  if (comp.mdadm) badges.push({ label: "mdadm", status: comp.mdadm.status });
  return badges;
}

function ComponentBadge({ label, status }: { label: string; status: string }) {
  const colorMap: Record<string, string> = {
    OK: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    WARN: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    CRIT: "bg-red-500/15 text-red-700 dark:text-red-400",
    UNKNOWN: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
  };
  return (
    <Badge
      variant="outline"
      className={`no-default-hover-elevate no-default-active-elevate border-transparent text-xs ${colorMap[status] || colorMap.UNKNOWN}`}
      data-testid={`badge-component-${label.toLowerCase()}`}
    >
      {label}
    </Badge>
  );
}

function StorageTypeBadge({ type }: { type: string | undefined }) {
  if (!type || type === "UNKNOWN") return null;
  return (
    <Badge
      variant="outline"
      className="no-default-hover-elevate no-default-active-elevate border-transparent text-xs bg-sky-500/15 text-sky-700 dark:text-sky-400"
      data-testid="badge-storage-type"
    >
      <HardDrive className="h-3 w-3 mr-1" />
      {type}
    </Badge>
  );
}

function HostFormDialog({
  host,
  customers,
  open,
  onOpenChange,
}: {
  host?: ProxmoxHost;
  customers: Customer[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const isEditing = !!host;

  const [name, setName] = useState(host?.name || "");
  const [hostAddr, setHostAddr] = useState(host?.host || "");
  const [port, setPort] = useState(host?.port?.toString() || "22");
  const [username, setUsername] = useState(host?.username || "root");
  const [password, setPassword] = useState("");
  const [hostKeyFingerprint, setHostKeyFingerprint] = useState(host?.hostKeyFingerprint || "");
  const [allowInsecureHostKey, setAllowInsecureHostKey] = useState(host?.allowInsecureHostKey ?? false);
  const [customerId, setCustomerId] = useState<string>(
    host?.customerId?.toString() || ""
  );
  const [enabled, setEnabled] = useState(host?.enabled ?? true);

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: any = {
        name,
        host: hostAddr,
        port: parseInt(port) || 22,
        username,
        hostKeyFingerprint: hostKeyFingerprint || null,
        allowInsecureHostKey,
        customerId: customerId && customerId !== "none" ? parseInt(customerId) : null,
        enabled,
      };
      if (password || !isEditing) {
        payload.password = password;
      }
      if (isEditing) {
        return apiRequest("PATCH", `/api/proxmox-hosts/${host.id}`, payload);
      }
      return apiRequest("POST", "/api/proxmox-hosts", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/proxmox-hosts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      toast({ title: isEditing ? "Host updated" : "Host added" });
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
          <DialogTitle>{isEditing ? "Edit Host" : "Add Proxmox Host"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="host-name">Display Name</Label>
            <Input
              id="host-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. PVE-Node01"
              data-testid="input-host-name"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Label htmlFor="host-addr">Host / IP</Label>
              <Input
                id="host-addr"
                value={hostAddr}
                onChange={(e) => setHostAddr(e.target.value)}
                placeholder="192.168.1.100"
                data-testid="input-host-addr"
              />
            </div>
            <div>
              <Label htmlFor="host-port">Port</Label>
              <Input
                id="host-port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                data-testid="input-host-port"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="host-user">Username</Label>
              <Input
                id="host-user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                data-testid="input-host-user"
              />
            </div>
            <div>
              <Label htmlFor="host-pass">Password</Label>
              <Input
                id="host-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isEditing ? "(unchanged)" : ""}
                data-testid="input-host-pass"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="host-key-fingerprint">SSH Host Key Fingerprint</Label>
            <Input
              id="host-key-fingerprint"
              value={hostKeyFingerprint}
              onChange={(e) => setHostKeyFingerprint(e.target.value)}
              placeholder="SHA256 fingerprint"
              data-testid="input-host-key-fingerprint"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <div>
              <Label htmlFor="allow-insecure-host-key">Allow unknown host key</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Use only while enrolling a host fingerprint.</p>
            </div>
            <Switch
              id="allow-insecure-host-key"
              checked={allowInsecureHostKey}
              onCheckedChange={setAllowInsecureHostKey}
              data-testid="switch-allow-insecure-host-key"
            />
          </div>
          <div>
            <Label>Customer</Label>
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger data-testid="select-host-customer">
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
            <Label htmlFor="host-enabled">Enabled</Label>
            <Switch
              id="host-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              data-testid="switch-host-enabled"
            />
          </div>
          <Button
            className="w-full"
            onClick={() => mutation.mutate()}
            disabled={!name || !hostAddr || (!password && !isEditing) || mutation.isPending}
            data-testid="button-save-host"
          >
            {mutation.isPending ? "Saving..." : isEditing ? "Update Host" : "Add Host"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Proxmox() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<ProxmoxHost | undefined>();

  const { data: hosts, isLoading } = useQuery<ProxmoxHostWithCustomer[]>({
    queryKey: ["/api/proxmox-hosts"],
    refetchInterval: 60_000,
  });

  const { data: customers } = useQuery<Customer[]>({
    queryKey: ["/api/customers"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("DELETE", `/api/proxmox-hosts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/proxmox-hosts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      toast({ title: "Host removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const runCheckMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("POST", `/api/proxmox-hosts/${id}/run-check`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/proxmox-hosts"] });
      toast({ title: "Check completed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleEdit = (e: React.MouseEvent, host: ProxmoxHost) => {
    e.stopPropagation();
    setEditingHost(host);
    setDialogOpen(true);
  };

  const handleNew = () => {
    setEditingHost(undefined);
    setDialogOpen(true);
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
            Proxmox Health
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Monitor Proxmox host storage and hardware health via SSH
          </p>
        </div>
        <Button onClick={handleNew} data-testid="button-new-host">
          <Plus className="h-4 w-4 mr-2" />
          Add Host
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-6 w-32 mb-2" />
                <Skeleton className="h-4 w-48 mb-4" />
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !hosts || hosts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Server className="h-12 w-12 text-muted-foreground mb-3" />
            <h3 className="text-lg font-semibold mb-1">No Proxmox hosts configured</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">
              Add your Proxmox hosts to monitor ZFS pools, mdadm arrays, SMART
              health, and Dell RAID status via SSH.
            </p>
            <Button onClick={handleNew} data-testid="button-new-host-empty">
              <Plus className="h-4 w-4 mr-2" />
              Add First Host
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {hosts.map((host) => {
            const payload = host.lastStatusDetails as HealthPayload | null;
            const summaryLines = getHealthSummaryLines(payload);
            const componentBadges = getComponentBadges(payload);
            const storageType = payload?.storage_type;
            const hasMonitoringError = !!payload?.monitoring_error;

            return (
              <Card
                key={host.id}
                className="hover-elevate cursor-pointer"
                data-testid={`card-host-${host.id}`}
                onClick={() => navigate(`/proxmox/${host.id}`)}
              >
                <CardHeader className="flex flex-row items-start justify-between gap-1 space-y-0 pb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
                        host.lastStatus === "OK"
                          ? "bg-emerald-500/15"
                          : host.lastStatus === "CRIT"
                          ? "bg-red-500/15"
                          : host.lastStatus === "WARN"
                          ? "bg-amber-500/15"
                          : "bg-slate-500/15"
                      }`}
                    >
                      {host.enabled ? (
                        <Wifi
                          className={`h-4 w-4 ${
                            host.lastStatus === "OK"
                              ? "text-emerald-600 dark:text-emerald-400"
                              : host.lastStatus === "CRIT"
                              ? "text-red-600 dark:text-red-400"
                              : host.lastStatus === "WARN"
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-slate-500"
                          }`}
                        />
                      ) : (
                        <WifiOff className="h-4 w-4 text-slate-500" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold truncate">{host.name}</h3>
                      <p className="text-xs text-muted-foreground truncate">
                        {host.host}:{host.port}
                        {host.customerName && ` \u00B7 ${host.customerName}`}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={host.lastStatus || "UNKNOWN"} />
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-1.5 flex-wrap mb-3">
                    <StorageTypeBadge type={storageType} />
                    {componentBadges.map((b) => (
                      <ComponentBadge key={b.label} label={b.label} status={b.status} />
                    ))}
                  </div>

                  <div className="space-y-1 mb-3">
                    {summaryLines.map((line, i) => (
                      <div
                        key={i}
                        className={`text-xs flex items-start gap-1.5 ${
                          hasMonitoringError
                            ? "text-muted-foreground"
                            : host.lastStatus === "CRIT"
                            ? "text-red-600 dark:text-red-400"
                            : host.lastStatus === "WARN"
                            ? "text-amber-600 dark:text-amber-400"
                            : host.lastStatus === "OK"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-muted-foreground"
                        }`}
                        data-testid={`text-health-line-${host.id}-${i}`}
                      >
                        {(host.lastStatus === "WARN" || host.lastStatus === "CRIT") && !hasMonitoringError ? (
                          <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                        ) : null}
                        <span>{line}</span>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center gap-3 text-xs text-muted-foreground mb-3">
                    <div className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      <span data-testid={`text-last-check-${host.id}`}>
                        {host.lastCheckAt
                          ? format(new Date(host.lastCheckAt), "MMM d, HH:mm")
                          : "Never"}
                      </span>
                    </div>
                    {host.consecutiveFailures > 0 && (
                      <div className="flex items-center gap-1 text-red-600 dark:text-red-400 font-medium" data-testid={`text-failures-${host.id}`}>
                        <AlertTriangle className="h-3 w-3" />
                        <span>{host.consecutiveFailures} consecutive failures</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1 pt-2 border-t border-border/50">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        runCheckMutation.mutate(host.id);
                      }}
                      disabled={!host.enabled || runCheckMutation.isPending}
                      data-testid={`button-run-check-${host.id}`}
                    >
                      <Play className="h-3.5 w-3.5 mr-1" />
                      {runCheckMutation.isPending ? "Running..." : "Run Check Now"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => handleEdit(e, host)}
                      data-testid={`button-edit-host-${host.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5 mr-1" />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Remove ${host.name} from monitoring? Check history for this host will be deleted.`)) {
                          deleteMutation.mutate(host.id);
                        }
                      }}
                      data-testid={`button-delete-host-${host.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      Remove
                    </Button>
                    <div className="ml-auto">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/proxmox/${host.id}`);
                        }}
                        data-testid={`button-detail-host-${host.id}`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <HostFormDialog
        key={editingHost?.id ?? "new"}
        host={editingHost}
        customers={customers || []}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}
