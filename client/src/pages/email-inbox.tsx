import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Mail,
  MailWarning,
  MailCheck,
  Plus,
  ArrowRight,
  Link as LinkIcon,
  Clock,
  User,
  FileText,
} from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Email, Job, Customer } from "@shared/schema";
import { buildEmailJobPayload, buildEmailLinkPayload, buildJobPayload } from "@/lib/workflow-payloads";

interface EmailWithJob extends Email {
  jobName?: string;
}

const weekDays = [
  ["sunday", "Sun"],
  ["monday", "Mon"],
  ["tuesday", "Tue"],
  ["wednesday", "Wed"],
  ["thursday", "Thu"],
  ["friday", "Fri"],
  ["saturday", "Sat"],
] as const;

function detectSystemType(email: Email): string {
  const from = (email.fromAddr || "").toLowerCase();
  const subject = (email.subject || "").toLowerCase();
  if (from.includes("veeam") || subject.includes("veeam")) return "VEEAM";
  if (from.includes("pbs") || subject.includes("[pbs]") || subject.includes("proxmox backup")) return "PBS";
  if (from.includes("synology") || subject.includes("hyper backup") || subject.includes("synology")) return "SYNOLOGY";
  return "VEEAM";
}

function suggestJobName(email: Email): string {
  const subject = email.subject || "";
  const quoteMatch = subject.match(/'([^']+)'/);
  if (quoteMatch) return quoteMatch[1];
  const bracketMatch = subject.match(/\[([^\]]+)\]/);
  if (bracketMatch) return bracketMatch[1];
  return subject.slice(0, 50);
}

function EmailDetailDialog({
  email,
  open,
  onOpenChange,
  onCreateJob,
  onLinkToJob,
}: {
  email: Email;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateJob: () => void;
  onLinkToJob: () => void;
}) {
  const receivedDate = email.receivedAt
    ? new Date(email.receivedAt).toLocaleString()
    : "Unknown";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MailWarning className="h-5 w-5 text-primary" />
            Unmatched Email
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <User className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">From</p>
                <p className="text-sm font-mono" data-testid="text-email-from">{email.fromAddr}</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <FileText className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">Subject</p>
                <p className="text-sm font-medium" data-testid="text-email-subject">{email.subject}</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Clock className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">Received</p>
                <p className="text-sm">{receivedDate}</p>
              </div>
            </div>
          </div>

          {email.snippet && (
            <div className="rounded-md bg-muted p-3">
              <p className="text-xs text-muted-foreground mb-1">Body Preview</p>
              <p className="text-sm whitespace-pre-wrap" data-testid="text-email-snippet">{email.snippet}</p>
            </div>
          )}

          <div className="border-t pt-4 space-y-2">
            <Button
              className="w-full"
              onClick={onCreateJob}
              data-testid="button-create-job-from-email"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Job From This Email
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={onLinkToJob}
              data-testid="button-link-to-existing-job"
            >
              <LinkIcon className="h-4 w-4 mr-2" />
              Link to Existing Job
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CreateJobFromEmailDialog({
  email,
  customers,
  open,
  onOpenChange,
}: {
  email: Email;
  customers: Customer[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const detectedSystem = detectSystemType(email);
  const suggestedName = suggestJobName(email);

  const [name, setName] = useState(suggestedName);
  const [systemType, setSystemType] = useState(detectedSystem);
  const [customerId, setCustomerId] = useState<string>("");
  const [scheduleType, setScheduleType] = useState("daily");
  const [scheduleTime, setScheduleTime] = useState("02:00");
  const [windowHours, setWindowHours] = useState("6");
  const [daysOfWeek, setDaysOfWeek] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [createRule, setCreateRule] = useState(true);

  const mutation = useMutation({
    mutationFn: async () => {
      const jobPayload = buildJobPayload({
        name,
        systemType,
        customerId,
        scheduleType,
        scheduleTime,
        windowHours,
        enabled,
        longRunning: false,
        daysOfWeek,
      });
      const jobRes = await apiRequest(
        "POST",
        `/api/emails/${email.id}/create-job`,
        buildEmailJobPayload(jobPayload, createRule),
      );
      const result = await jobRes.json();
      return result.job;
    },
    onSuccess: (newJob) => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/emails"] });
      queryClient.invalidateQueries({ queryKey: ["/api/emails/unmatched"] });
      queryClient.invalidateQueries({ queryKey: ["/api/emails/matched"] });
      queryClient.invalidateQueries({ queryKey: ["/api/emails/unmatched-count"] });
      queryClient.invalidateQueries({ queryKey: ["/api/job-rules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      toast({ title: `Job "${newJob.name}" created and email linked` });
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
          <DialogTitle>Create Job From Email</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md bg-muted p-3 space-y-1">
            <p className="text-xs text-muted-foreground">Source Email</p>
            <p className="text-sm font-mono truncate">{email.fromAddr}</p>
            <p className="text-sm truncate">{email.subject}</p>
          </div>

          <div>
            <Label htmlFor="job-name-from-email">Job Name</Label>
            <Input
              id="job-name-from-email"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="input-job-name-from-email"
            />
          </div>
          <div>
            <Label>Detected System Type</Label>
            <Select value={systemType} onValueChange={setSystemType}>
              <SelectTrigger data-testid="select-system-type-from-email">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="VEEAM">Veeam</SelectItem>
                <SelectItem value="PBS">Proxmox Backup Server</SelectItem>
                <SelectItem value="SYNOLOGY">Synology</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Customer</Label>
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger data-testid="select-customer-from-email">
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Schedule</Label>
              <Select value={scheduleType} onValueChange={setScheduleType}>
                <SelectTrigger data-testid="select-schedule-from-email">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="time-from-email">Time</Label>
              <Input
                id="time-from-email"
                type="time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                data-testid="input-time-from-email"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="window-from-email">Window (hours)</Label>
            <Input
              id="window-from-email"
              type="number"
              min={1}
              max={48}
              value={windowHours}
              onChange={(e) => setWindowHours(e.target.value)}
              data-testid="input-window-from-email"
            />
          </div>
          {scheduleType === "weekly" && (
            <div className="space-y-2">
              <Label>Run Days</Label>
              <div className="grid grid-cols-2 gap-2">
                {weekDays.map(([value, label]) => (
                  <label key={value} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                    <Checkbox
                      checked={daysOfWeek.includes(value)}
                      onCheckedChange={(checked) => {
                        setDaysOfWeek((current) =>
                          checked ? [...current, value] : current.filter((day) => day !== value),
                        );
                      }}
                      data-testid={`checkbox-day-from-email-${value}`}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="enabled-from-email">Enabled</Label>
            <Switch
              id="enabled-from-email"
              checked={enabled}
              onCheckedChange={setEnabled}
              data-testid="switch-enabled-from-email"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <div>
              <Label htmlFor="create-rule">Auto-create matching rule</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Matches future emails from: {email.fromAddr}
              </p>
            </div>
            <Switch
              id="create-rule"
              checked={createRule}
              onCheckedChange={setCreateRule}
              data-testid="switch-create-rule"
            />
          </div>
          <Button
            className="w-full"
            onClick={() => mutation.mutate()}
            disabled={!name || (scheduleType === "weekly" && daysOfWeek.length === 0) || mutation.isPending}
            data-testid="button-confirm-create-job"
          >
            {mutation.isPending ? "Creating..." : "Create Job & Link Email"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LinkToJobDialog({
  email,
  jobs,
  open,
  onOpenChange,
}: {
  email: Email;
  jobs: Job[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [selectedJobId, setSelectedJobId] = useState<string>("");

  const mutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/emails/${email.id}/link-job`, buildEmailLinkPayload(selectedJobId));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/emails"] });
      queryClient.invalidateQueries({ queryKey: ["/api/emails/unmatched"] });
      queryClient.invalidateQueries({ queryKey: ["/api/emails/matched"] });
      queryClient.invalidateQueries({ queryKey: ["/api/emails/unmatched-count"] });
      toast({ title: "Email linked to job" });
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
          <DialogTitle>Link Email to Existing Job</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md bg-muted p-3 space-y-1">
            <p className="text-xs text-muted-foreground">Email</p>
            <p className="text-sm truncate">{email.subject}</p>
          </div>
          <div>
            <Label>Select Job</Label>
            <Select value={selectedJobId} onValueChange={setSelectedJobId}>
              <SelectTrigger data-testid="select-link-job">
                <SelectValue placeholder="Choose a backup job" />
              </SelectTrigger>
              <SelectContent>
                {jobs.map((j) => (
                  <SelectItem key={j.id} value={j.id.toString()}>
                    {j.name} ({j.systemType})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            className="w-full"
            onClick={() => mutation.mutate()}
            disabled={!selectedJobId || mutation.isPending}
            data-testid="button-confirm-link-job"
          >
            {mutation.isPending ? "Linking..." : "Link Email to Job"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EmailRow({
  email,
  onClick,
  matched,
  jobName,
}: {
  email: Email;
  onClick: () => void;
  matched: boolean;
  jobName?: string;
}) {
  const receivedDate = email.receivedAt
    ? new Date(email.receivedAt).toLocaleString()
    : "Unknown";

  const system = detectSystemType(email);
  const systemColors: Record<string, string> = {
    VEEAM: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    PBS: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
    SYNOLOGY: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  };

  return (
    <div
      className="flex items-start gap-3 p-3 rounded-md hover-elevate cursor-pointer"
      onClick={onClick}
      data-testid={`row-email-${email.id}`}
    >
      <div className="mt-0.5">
        {matched ? (
          <MailCheck className="h-5 w-5 text-emerald-500" />
        ) : (
          <MailWarning className="h-5 w-5 text-primary" />
        )}
      </div>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium truncate" data-testid={`text-email-subject-${email.id}`}>
            {email.subject || "(no subject)"}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground font-mono truncate">
            {email.fromAddr}
          </span>
          <Badge
            variant="outline"
            className={`no-default-hover-elevate no-default-active-elevate border-transparent text-[10px] ${systemColors[system] || ""}`}
          >
            {system}
          </Badge>
          {matched && jobName && (
            <Badge variant="secondary" className="text-[10px]">
              {jobName}
            </Badge>
          )}
        </div>
        {email.snippet && (
          <p className="text-xs text-muted-foreground line-clamp-1">
            {email.snippet}
          </p>
        )}
      </div>
      <div className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
        {receivedDate}
      </div>
    </div>
  );
}

export default function EmailInbox() {
  const [activeTab, setActiveTab] = useState("unmatched");
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [createJobOpen, setCreateJobOpen] = useState(false);
  const [linkJobOpen, setLinkJobOpen] = useState(false);

  const { data: unmatchedEmails, isLoading: unmatchedLoading } = useQuery<Email[]>({
    queryKey: ["/api/emails/unmatched"],
    refetchInterval: 60_000,
  });

  const { data: matchedEmails, isLoading: matchedLoading } = useQuery<EmailWithJob[]>({
    queryKey: ["/api/emails/matched"],
    refetchInterval: 60_000,
  });

  const { data: customers } = useQuery<Customer[]>({
    queryKey: ["/api/customers"],
  });

  const { data: jobs } = useQuery<Job[]>({
    queryKey: ["/api/jobs"],
  });

  const handleEmailClick = (email: Email) => {
    setSelectedEmail(email);
    if (activeTab === "unmatched") {
      setDetailOpen(true);
    }
  };

  const handleCreateJob = () => {
    setDetailOpen(false);
    setCreateJobOpen(true);
  };

  const handleLinkToJob = () => {
    setDetailOpen(false);
    setLinkJobOpen(true);
  };

  const unmatchedCount = unmatchedEmails?.length || 0;
  const matchedCount = matchedEmails?.length || 0;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
            Email Inbox
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Incoming backup notification emails — match them to jobs or create new ones
          </p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="unmatched" data-testid="tab-unmatched">
            Unmatched
            {unmatchedCount > 0 && (
              <Badge variant="destructive" className="ml-1.5 text-[10px]">
                {unmatchedCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="matched" data-testid="tab-matched">
            Matched
            {matchedCount > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-[10px]">
                {matchedCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="unmatched" className="mt-4">
          {unmatchedLoading ? (
            <Card>
              <CardContent className="p-4">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full mb-2" />
                ))}
              </CardContent>
            </Card>
          ) : !unmatchedEmails || unmatchedEmails.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <MailCheck className="h-12 w-12 text-muted-foreground mb-3" />
                <h3 className="text-lg font-semibold mb-1">All caught up</h3>
                <p className="text-sm text-muted-foreground max-w-sm">
                  No unmatched emails. All incoming backup notifications have been linked to jobs.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-2">
                <div className="divide-y">
                  {unmatchedEmails.map((email) => (
                    <EmailRow
                      key={email.id}
                      email={email}
                      onClick={() => handleEmailClick(email)}
                      matched={false}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="matched" className="mt-4">
          {matchedLoading ? (
            <Card>
              <CardContent className="p-4">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full mb-2" />
                ))}
              </CardContent>
            </Card>
          ) : !matchedEmails || matchedEmails.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <Mail className="h-12 w-12 text-muted-foreground mb-3" />
                <h3 className="text-lg font-semibold mb-1">No matched emails yet</h3>
                <p className="text-sm text-muted-foreground max-w-sm">
                  Emails will appear here once they are linked to backup jobs.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-2">
                <div className="divide-y">
                  {matchedEmails.map((email) => (
                    <EmailRow
                      key={email.id}
                      email={email}
                      onClick={() => {}}
                      matched={true}
                      jobName={email.jobName}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {selectedEmail && (
        <>
          <EmailDetailDialog
            email={selectedEmail}
            open={detailOpen}
            onOpenChange={setDetailOpen}
            onCreateJob={handleCreateJob}
            onLinkToJob={handleLinkToJob}
          />
          <CreateJobFromEmailDialog
            key={`create-${selectedEmail.id}`}
            email={selectedEmail}
            customers={customers || []}
            open={createJobOpen}
            onOpenChange={setCreateJobOpen}
          />
          <LinkToJobDialog
            key={`link-${selectedEmail.id}`}
            email={selectedEmail}
            jobs={jobs || []}
            open={linkJobOpen}
            onOpenChange={setLinkJobOpen}
          />
        </>
      )}
    </div>
  );
}
