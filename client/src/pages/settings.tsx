import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  Clock,
  Settings as SettingsIcon,
} from "lucide-react";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { AppSetting, Recipient, Customer } from "@shared/schema";

function SettingField({
  label,
  description,
  settingKey,
  type = "text",
  settings,
  onSave,
}: {
  label: string;
  description: string;
  settingKey: string;
  type?: string;
  settings: Record<string, string>;
  onSave: (key: string, value: string) => void;
}) {
  const [value, setValue] = useState(settings[settingKey] || "");

  useEffect(() => {
    setValue(settings[settingKey] || "");
  }, [settings, settingKey]);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={settingKey}>{label}</Label>
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
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
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
      const payload = {
        name,
        email,
        type,
        customerId: customerId && customerId !== "none" ? parseInt(customerId) : null,
        enabled,
      };
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

  const { data: settingsData, isLoading: settingsLoading } = useQuery<AppSetting[]>({
    queryKey: ["/api/settings"],
  });

  const { data: recipients, isLoading: recipientsLoading } = useQuery<Recipient[]>({
    queryKey: ["/api/recipients"],
  });

  const { data: customers } = useQuery<Customer[]>({
    queryKey: ["/api/customers"],
  });

  const settings: Record<string, string> = {};
  settingsData?.forEach((s) => {
    settings[s.key] = s.value || "";
  });

  const saveMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      return apiRequest("POST", "/api/settings", { key, value });
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
          Configure IMAP polling, SMTP notifications, and alert recipients
        </p>
      </div>

      <Tabs defaultValue="imap">
        <TabsList className="mb-4">
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
          <TabsTrigger value="general" data-testid="tab-general">
            <SettingsIcon className="h-3.5 w-3.5 mr-1.5" />
            General
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
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => {
                                  if (window.confirm(`Remove recipient ${r.name}?`)) {
                                    deleteRecipientMutation.mutate(r.id);
                                  }
                                }}
                                data-testid={`button-delete-recipient-${r.id}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
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
                description="Delete processed IMAP emails older than this many days (default: 7)"
                settingKey="RETENTION_DAYS"
                type="number"
                settings={settings}
                onSave={handleSaveSetting}
              />
              <SettingField
                label="SSH Timeout (seconds)"
                description="Maximum time to wait for SSH health checks (default: 10)"
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
      </Tabs>

      <RecipientDialog
        key={editingRecipient?.id ?? "new"}
        recipient={editingRecipient}
        customers={customers || []}
        open={recipientDialogOpen}
        onOpenChange={setRecipientDialogOpen}
      />
    </div>
  );
}
