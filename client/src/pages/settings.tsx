import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Mail,
  Send,
  Bell,
  Save,
  Plus,
  Trash2,
  Pencil,
  Settings as SettingsIcon,
  Route as RouteIcon,
  Activity,
  History,
  RefreshCw,
} from "lucide-react";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ConfirmActionButton } from "@/components/confirm-action";
import {
  buildNotificationRoutePayload,
  buildRecipientPayload,
  buildSettingPayload,
} from "@/lib/workflow-payloads";
import { CLEAR_SECRET_SETTING_VALUE } from "@shared/settings";
import type {
  AppSetting,
  AuditLog,
  Customer,
  Job,
  NotificationRoute,
  Recipient,
  SchedulerRun,
} from "@shared/schema";

function SettingField({
  label,
  description,
  settingKey,
  type = "text",
  clearableSecret = false,
  secretHasValue,
  settings,
  onSave,
}: {
  label: string;
  description: string;
  settingKey: string;
  type?: string;
  clearableSecret?: boolean;
  secretHasValue?: boolean;
  settings: Record<string, string>;
  onSave: (key: string, value: string) => void;
}) {
  const [value, setValue] = useState(settings[settingKey] || "");

  useEffect(() => {
    setValue(settings[settingKey] || "");
  }, [settings, settingKey]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={settingKey}>{label}</Label>
        {clearableSecret && (
          <Badge variant={secretHasValue ? "secondary" : "outline"} className="text-[10px]">
            {secretHasValue ? "Stored" : "Not set"}
          </Badge>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          id={settingKey}
          type={type}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1"
          data-testid={`input-setting-${settingKey}`}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => onSave(settingKey, value)}
          data-testid={`button-save-${settingKey}`}
        >
          <Save className="h-3.5 w-3.5" />
        </Button>
        {clearableSecret && (
          <ConfirmActionButton
            size="sm"
            variant="outline"
            title={`Clear ${label}?`}
            description="The saved secret value will be removed."
            confirmLabel="Clear"
            onConfirm={() => onSave(settingKey, CLEAR_SECRET_SETTING_VALUE)}
            data-testid={`button-clear-${settingKey}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </ConfirmActionButton>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function formatDate(value?: string | Date | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function routeRecipientIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
}

function routeRecipientsLabel(route: NotificationRoute, recipients: Recipient[]) {
  const ids = new Set(routeRecipientIds(route.recipientsJson));
  if (ids.size === 0) return "Default routing";
  const names = recipients
    .filter((recipient) => ids.has(recipient.id))
    .map((recipient) => recipient.name);
  return names.length > 0 ? names.join(", ") : `${ids.size} recipient(s)`;
}

function scopeLabel(route: NotificationRoute, customers: Customer[], jobs: Job[]) {
  if (route.scopeType === "GLOBAL") return "Global";
  if (route.scopeType === "CUSTOMER") {
    return customers.find((customer) => customer.id === route.scopeId)?.name || `Customer #${route.scopeId}`;
  }
  if (route.scopeType === "JOB") {
    return jobs.find((job) => job.id === route.scopeId)?.name || `Job #${route.scopeId}`;
  }
  return route.scopeType;
}

function NotificationRouteDialog({
  customers,
  jobs,
  recipients,
  open,
  onOpenChange,
}: {
  customers: Customer[];
  jobs: Job[];
  recipients: Recipient[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [scopeType, setScopeType] = useState("GLOBAL");
  const [scopeId, setScopeId] = useState("none");
  const [eventType, setEventType] = useState("FAIL");
  const [severityMin, setSeverityMin] = useState("WARN");
  const [recipientIds, setRecipientIds] = useState<number[]>([]);

  useEffect(() => {
    if (!open) return;
    setScopeType("GLOBAL");
    setScopeId("none");
    setEventType("FAIL");
    setSeverityMin("WARN");
    setRecipientIds([]);
  }, [open]);

  const mutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/notification-routes", buildNotificationRoutePayload({
        scopeType,
        scopeId,
        eventType,
        severityMin,
        recipientIds,
      }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notification-routes"] });
      toast({ title: "Route added" });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Notification Route</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Scope</Label>
              <Select
                value={scopeType}
                onValueChange={(value) => {
                  setScopeType(value);
                  setScopeId("none");
                }}
              >
                <SelectTrigger data-testid="select-route-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GLOBAL">Global</SelectItem>
                  <SelectItem value="CUSTOMER">Customer</SelectItem>
                  <SelectItem value="JOB">Job</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {scopeType !== "GLOBAL" && (
              <div>
                <Label>{scopeType === "CUSTOMER" ? "Customer" : "Job"}</Label>
                <Select value={scopeId} onValueChange={setScopeId}>
                  <SelectTrigger data-testid="select-route-scope-id">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Choose...</SelectItem>
                    {(scopeType === "CUSTOMER" ? customers : jobs).map((item) => (
                      <SelectItem key={item.id} value={item.id.toString()}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Event</Label>
              <Select value={eventType} onValueChange={setEventType}>
                <SelectTrigger data-testid="select-route-event">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FAIL">Failure</SelectItem>
                  <SelectItem value="MISSING">Missing Backup</SelectItem>
                  <SelectItem value="WARN">Warning</SelectItem>
                  <SelectItem value="MONITOR_DOWN">Monitor Down</SelectItem>
                  <SelectItem value="DAILY_REPORT">Daily Report</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Minimum Severity</Label>
              <Select value={severityMin} onValueChange={setSeverityMin}>
                <SelectTrigger data-testid="select-route-severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="INFO">Info</SelectItem>
                  <SelectItem value="WARN">Warning</SelectItem>
                  <SelectItem value="CRIT">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Recipients</Label>
            <div className="max-h-48 overflow-auto rounded-md border p-2">
              {recipients.length === 0 ? (
                <p className="px-1 py-2 text-sm text-muted-foreground">No recipients configured</p>
              ) : (
                recipients.map((recipient) => (
                  <label key={recipient.id} className="flex items-center gap-2 rounded-sm px-1 py-1.5 text-sm">
                    <Checkbox
                      checked={recipientIds.includes(recipient.id)}
                      onCheckedChange={(checked) => {
                        setRecipientIds((current) =>
                          checked
                            ? [...current, recipient.id]
                            : current.filter((id) => id !== recipient.id),
                        );
                      }}
                    />
                    <span>{recipient.name}</span>
                    <span className="text-muted-foreground">{recipient.email}</span>
                  </label>
                ))
              )}
            </div>
          </div>

          <Button
            className="w-full"
            onClick={() => mutation.mutate()}
            disabled={
              mutation.isPending ||
              recipientIds.length === 0 ||
              (scopeType !== "GLOBAL" && scopeId === "none")
            }
            data-testid="button-save-notification-route"
          >
            {mutation.isPending ? "Saving..." : "Add Route"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RecipientDialog({
  recipient,
  customers,
  open,
  onOpenChange,
}: {
  recipient?: Recipient;
  customers: Customer[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const isEditing = !!recipient;

  const [name, setName] = useState(recipient?.name || "");
  const [email, setEmail] = useState(recipient?.email || "");
  const [type, setType] = useState(recipient?.type || "TECH");
  const [customerId, setCustomerId] = useState<string>(
    recipient?.customerId?.toString() || ""
  );
  const [enabled, setEnabled] = useState(recipient?.enabled ?? true);

  const mutation = useMutation({
    mutationFn: async () => {
      const payload = buildRecipientPayload({
        name,
        email,
        type,
        customerId,
        enabled,
      });
      if (isEditing) {
        return apiRequest("PATCH", `/api/recipients/${recipient.id}`, payload);
      }
      return apiRequest("POST", "/api/recipients", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recipients"] });
      toast({ title: isEditing ? "Recipient updated" : "Recipient added" });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Recipient" : "New Recipient"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="John Doe"
              data-testid="input-recipient-name"
            />
          </div>
          <div>
            <Label>Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="john@example.com"
              data-testid="input-recipient-email"
            />
          </div>
          <div>
            <Label>Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger data-testid="select-recipient-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="TECH">Technical</SelectItem>
                <SelectItem value="CLIENT">Client</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Customer</Label>
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger data-testid="select-recipient-customer">
                <SelectValue placeholder="Global (all customers)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Global</SelectItem>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id.toString()}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Label>Enabled</Label>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              data-testid="switch-recipient-enabled"
            />
          </div>
          <Button
            className="w-full"
            onClick={() => mutation.mutate()}
            disabled={!name || !email || mutation.isPending}
            data-testid="button-save-recipient"
          >
            {mutation.isPending ? "Saving..." : isEditing ? "Update" : "Add Recipient"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Settings() {
  const { toast } = useToast();
  const [recipientDialogOpen, setRecipientDialogOpen] = useState(false);
  const [editingRecipient, setEditingRecipient] = useState<Recipient | undefined>();
  const [routeDialogOpen, setRouteDialogOpen] = useState(false);

  const { data: settingsData, isLoading: settingsLoading } = useQuery<AppSetting[]>({
    queryKey: ["/api/settings"],
  });

  const { data: recipients, isLoading: recipientsLoading } = useQuery<Recipient[]>({
    queryKey: ["/api/recipients"],
  });

  const { data: customers } = useQuery<Customer[]>({
    queryKey: ["/api/customers"],
  });

  const { data: jobs } = useQuery<Job[]>({
    queryKey: ["/api/jobs"],
  });

  const { data: notificationRoutes, isLoading: routesLoading } = useQuery<NotificationRoute[]>({
    queryKey: ["/api/notification-routes"],
  });

  const { data: schedulerRuns, isLoading: schedulerLoading } = useQuery<SchedulerRun[]>({
    queryKey: ["/api/scheduler/status"],
    refetchInterval: 30_000,
  });

  const { data: auditLogs, isLoading: auditLoading } = useQuery<AuditLog[]>({
    queryKey: ["/api/audit-logs"],
    refetchInterval: 60_000,
  });

  const settings: Record<string, string> = {};
  const secretState: Record<string, boolean> = {};
  settingsData?.forEach((s) => {
    settings[s.key] = s.value || "";
    secretState[s.key] = !!(s as AppSetting & { hasValue?: boolean }).hasValue;
  });

  const saveMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      return apiRequest("POST", "/api/settings", buildSettingPayload(key, value));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Setting saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const testImapMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/settings/test-imap"),
    onSuccess: () => toast({ title: "IMAP connection succeeded" }),
    onError: (err: Error) => {
      toast({ title: "IMAP test failed", description: err.message, variant: "destructive" });
    },
  });

  const testSmtpMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/settings/test-smtp"),
    onSuccess: () => toast({ title: "SMTP connection succeeded" }),
    onError: (err: Error) => {
      toast({ title: "SMTP test failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteRecipientMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("DELETE", `/api/recipients/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recipients"] });
      toast({ title: "Recipient removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteRouteMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("DELETE", `/api/notification-routes/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notification-routes"] });
      toast({ title: "Route removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const runRetentionMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/maintenance/retention/run", {
        retentionDays: Number(settings.RETENTION_DAYS || 90),
      }).then((res) => res.json());
    },
    onSuccess: (summary: {
      deletedEvents: number;
      deletedExpectedRuns: number;
      deletedEmails: number;
      deletedProxmoxChecks: number;
      deletedIncidents: number;
    }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/scheduler/status"] });
      toast({
        title: "Retention completed",
        description: `${summary.deletedEmails} emails, ${summary.deletedProxmoxChecks} checks, ${summary.deletedIncidents} incidents removed`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Retention failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSaveSetting = (key: string, value: string) => {
    saveMutation.mutate({ key, value });
  };

  if (settingsLoading) {
    return (
      <div className="p-6">
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="space-y-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
          Settings
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure polling, notifications, maintenance, and operational controls
        </p>
      </div>

      <Tabs defaultValue="imap">
        <TabsList className="mb-4 flex h-auto flex-wrap">
          <TabsTrigger value="imap" data-testid="tab-imap">
            <Mail className="h-3.5 w-3.5 mr-1.5" />
            IMAP
          </TabsTrigger>
          <TabsTrigger value="smtp" data-testid="tab-smtp">
            <Send className="h-3.5 w-3.5 mr-1.5" />
            SMTP
          </TabsTrigger>
          <TabsTrigger value="recipients" data-testid="tab-recipients">
            <Bell className="h-3.5 w-3.5 mr-1.5" />
            Recipients
          </TabsTrigger>
          <TabsTrigger value="routes" data-testid="tab-routes">
            <RouteIcon className="h-3.5 w-3.5 mr-1.5" />
            Routes
          </TabsTrigger>
          <TabsTrigger value="general" data-testid="tab-general">
            <SettingsIcon className="h-3.5 w-3.5 mr-1.5" />
            General
          </TabsTrigger>
          <TabsTrigger value="operations" data-testid="tab-operations">
            <Activity className="h-3.5 w-3.5 mr-1.5" />
            Operations
          </TabsTrigger>
          <TabsTrigger value="audit" data-testid="tab-audit">
            <History className="h-3.5 w-3.5 mr-1.5" />
            Audit
          </TabsTrigger>
        </TabsList>

        <TabsContent value="imap">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-base">IMAP Configuration</CardTitle>
              <Button
                size="sm"
                variant="outline"
                onClick={() => testImapMutation.mutate()}
                disabled={testImapMutation.isPending}
                data-testid="button-test-imap"
              >
                {testImapMutation.isPending ? "Testing..." : "Test"}
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <SettingField
                label="IMAP Host"
                description="MXroute IMAP server hostname"
                settingKey="IMAP_HOST"
                settings={settings}
                onSave={handleSaveSetting}
              />
              <SettingField
                label="IMAP Port"
                description="Usually 993 for IMAPS"
                settingKey="IMAP_PORT"
                type="number"
                settings={settings}
                onSave={handleSaveSetting}
              />
              <SettingField
                label="IMAP User"
                description="Email address for IMAP login"
                settingKey="IMAP_USER"
                settings={settings}
                onSave={handleSaveSetting}
              />
              <SettingField
                label="IMAP Password"
                description="IMAP account password"
                settingKey="IMAP_PASS"
                type="password"
                clearableSecret
                secretHasValue={secretState.IMAP_PASS}
                settings={settings}
                onSave={handleSaveSetting}
              />
              <SettingField
                label="Poll Interval (minutes)"
                description="How often to check for new emails (default: 60)"
                settingKey="IMAP_POLL_INTERVAL"
                type="number"
                settings={settings}
                onSave={handleSaveSetting}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="smtp">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-base">SMTP Configuration</CardTitle>
              <Button
                size="sm"
                variant="outline"
                onClick={() => testSmtpMutation.mutate()}
                disabled={testSmtpMutation.isPending}
                data-testid="button-test-smtp"
              >
                {testSmtpMutation.isPending ? "Testing..." : "Test"}
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <SettingField
                label="SMTP Host"
                description="SMTP server for sending notifications"
                settingKey="SMTP_HOST"
                settings={settings}
                onSave={handleSaveSetting}
              />
              <SettingField
                label="SMTP Port"
                description="Usually 587 for STARTTLS or 465 for SSL"
                settingKey="SMTP_PORT"
                type="number"
                settings={settings}
                onSave={handleSaveSetting}
              />
              <SettingField
                label="SMTP User"
                description="Authentication username"
                settingKey="SMTP_USER"
                settings={settings}
                onSave={handleSaveSetting}
              />
              <SettingField
                label="SMTP Password"
                description="Authentication password"
                settingKey="SMTP_PASS"
                type="password"
                clearableSecret
                secretHasValue={secretState.SMTP_PASS}
                settings={settings}
                onSave={handleSaveSetting}
              />
              <SettingField
                label="From Address"
                description="Sender address for notification emails"
                settingKey="SMTP_FROM"
                settings={settings}
                onSave={handleSaveSetting}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="recipients">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0">
              <CardTitle className="text-base">Notification Recipients</CardTitle>
              <Button
                size="sm"
                onClick={() => {
                  setEditingRecipient(undefined);
                  setRecipientDialogOpen(true);
                }}
                data-testid="button-add-recipient"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add
              </Button>
            </CardHeader>
            <CardContent>
              {recipientsLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : !recipients || recipients.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <Bell className="h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">No recipients configured</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Add recipients to receive backup failure and monitoring alerts
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="w-20">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recipients.map((r) => (
                        <TableRow key={r.id} data-testid={`row-recipient-${r.id}`}>
                          <TableCell className="font-medium">{r.name}</TableCell>
                          <TableCell className="text-muted-foreground">{r.email}</TableCell>
                          <TableCell className="text-muted-foreground">{r.type}</TableCell>
                          <TableCell>
                            <span
                              className={`text-xs font-medium ${
                                r.enabled
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {r.enabled ? "Active" : "Disabled"}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => {
                                  setEditingRecipient(r);
                                  setRecipientDialogOpen(true);
                                }}
                                data-testid={`button-edit-recipient-${r.id}`}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <ConfirmActionButton
                                size="icon"
                                variant="ghost"
                                title={`Remove ${r.name}?`}
                                description="This recipient will stop receiving notifications from matching routes."
                                confirmLabel="Remove"
                                onConfirm={() => deleteRecipientMutation.mutate(r.id)}
                                data-testid={`button-delete-recipient-${r.id}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </ConfirmActionButton>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="routes">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0">
              <CardTitle className="text-base">Notification Routes</CardTitle>
              <Button
                size="sm"
                onClick={() => setRouteDialogOpen(true)}
                data-testid="button-add-notification-route"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add
              </Button>
            </CardHeader>
            <CardContent>
              {routesLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : !notificationRoutes || notificationRoutes.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <RouteIcon className="h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">No custom routes configured</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Default routing sends alerts to global and matching customer recipients
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Scope</TableHead>
                        <TableHead>Event</TableHead>
                        <TableHead>Minimum</TableHead>
                        <TableHead>Recipients</TableHead>
                        <TableHead className="w-20">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {notificationRoutes.map((route) => (
                        <TableRow key={route.id} data-testid={`row-notification-route-${route.id}`}>
                          <TableCell className="font-medium">
                            {scopeLabel(route, customers || [], jobs || [])}
                          </TableCell>
                          <TableCell>{route.eventType}</TableCell>
                          <TableCell>
                            <Badge variant={route.severityMin === "CRIT" ? "destructive" : "secondary"}>
                              {route.severityMin}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {routeRecipientsLabel(route, recipients || [])}
                          </TableCell>
                          <TableCell>
                            <ConfirmActionButton
                              size="icon"
                              variant="ghost"
                              title="Remove this notification route?"
                              description="Matching alerts will fall back to the remaining custom routes or default routing."
                              confirmLabel="Remove"
                              onConfirm={() => deleteRouteMutation.mutate(route.id)}
                              data-testid={`button-delete-notification-route-${route.id}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </ConfirmActionButton>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="general">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">General Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <SettingField
                label="App Timezone"
                description="Timezone for schedule calculations (e.g. America/New_York)"
                settingKey="APP_TIMEZONE"
                settings={settings}
                onSave={handleSaveSetting}
              />
              <SettingField
                label="Retention Days"
                description="Delete old emails, checks, expected runs, and resolved incidents after this many days (default: 90)"
                settingKey="RETENTION_DAYS"
                type="number"
                settings={settings}
                onSave={handleSaveSetting}
              />
              <SettingField
                label="SSH Timeout (seconds)"
                description="Maximum time to wait for SSH health checks (default: 20)"
                settingKey="SSH_TIMEOUT"
                type="number"
                settings={settings}
                onSave={handleSaveSetting}
              />
              <SettingField
                label="Consecutive Failure Threshold"
                description="Create unreachable incident after N consecutive SSH failures (default: 3)"
                settingKey="CONSECUTIVE_FAILURE_THRESHOLD"
                type="number"
                settings={settings}
                onSave={handleSaveSetting}
              />
              <SettingField
                label="Daily Report Time"
                description="Time to send daily summary report (HH:MM format)"
                settingKey="DAILY_REPORT_TIME"
                settings={settings}
                onSave={handleSaveSetting}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="operations">
          <div className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                <CardTitle className="text-base">Scheduler Status</CardTitle>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/scheduler/status"] })}
                  data-testid="button-refresh-scheduler"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </CardHeader>
              <CardContent>
                {schedulerLoading ? (
                  <Skeleton className="h-24 w-full" />
                ) : !schedulerRuns || schedulerRuns.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No scheduler runs recorded yet
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Worker</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Started</TableHead>
                          <TableHead>Finished</TableHead>
                          <TableHead>Duration</TableHead>
                          <TableHead>Message</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {schedulerRuns.map((run) => (
                          <TableRow key={run.id} data-testid={`row-scheduler-${run.workerName}`}>
                            <TableCell className="font-medium">{run.workerName}</TableCell>
                            <TableCell>
                              <Badge
                                variant={
                                  run.status === "ERROR"
                                    ? "destructive"
                                    : run.status === "OK"
                                      ? "secondary"
                                      : "outline"
                                }
                              >
                                {run.status}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-muted-foreground">{formatDate(run.lastStartedAt)}</TableCell>
                            <TableCell className="text-muted-foreground">{formatDate(run.lastFinishedAt)}</TableCell>
                            <TableCell className="text-muted-foreground">
                              {run.durationMs == null ? "-" : `${run.durationMs}ms`}
                            </TableCell>
                            <TableCell className="max-w-sm truncate text-muted-foreground">
                              {run.message || "-"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                <CardTitle className="text-base">Retention</CardTitle>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => runRetentionMutation.mutate()}
                  disabled={runRetentionMutation.isPending}
                  data-testid="button-run-retention"
                >
                  {runRetentionMutation.isPending ? "Running..." : "Run Now"}
                </Button>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Current retention window: {settings.RETENTION_DAYS || "90"} days
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent Audit Events</CardTitle>
            </CardHeader>
            <CardContent>
              {auditLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : !auditLogs || auditLogs.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No audit events recorded yet
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Actor</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead>Entity</TableHead>
                        <TableHead>Summary</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {auditLogs.map((entry) => (
                        <TableRow key={entry.id} data-testid={`row-audit-${entry.id}`}>
                          <TableCell className="text-muted-foreground">{formatDate(entry.createdAt)}</TableCell>
                          <TableCell>{entry.actor}</TableCell>
                          <TableCell>{entry.action}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {entry.entityType}{entry.entityId ? ` #${entry.entityId}` : ""}
                          </TableCell>
                          <TableCell className="max-w-lg truncate text-muted-foreground">
                            {entry.summary}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <RecipientDialog
        key={editingRecipient?.id ?? "new"}
        recipient={editingRecipient}
        customers={customers || []}
        open={recipientDialogOpen}
        onOpenChange={setRecipientDialogOpen}
      />
      <NotificationRouteDialog
        customers={customers || []}
        jobs={jobs || []}
        recipients={recipients || []}
        open={routeDialogOpen}
        onOpenChange={setRouteDialogOpen}
      />
    </div>
  );
}
