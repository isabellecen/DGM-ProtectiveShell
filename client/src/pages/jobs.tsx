import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { Plus, HardDrive, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Job, Customer } from "@shared/schema";
import { ConfirmActionButton } from "@/components/confirm-action";
import { buildJobPayload } from "@/lib/workflow-payloads";
import { jobDisplayStatus, jobStatusDetail, systemTypeLabel } from "@/lib/job-display";
import { Badge } from "@/components/ui/badge";

interface JobWithCustomer extends Job {
  customerName?: string;
  latestRunStatus?: string | null;
  latestEventStatus?: string | null;
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

const systemTypeClasses: Record<string, string> = {
  VEEAM: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  PBS: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400",
  SYNOLOGY: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
};

function SystemBadge({ systemType }: { systemType: string }) {
  return (
    <Badge
      variant="outline"
      className={`no-default-hover-elevate no-default-active-elevate border-transparent font-medium ${systemTypeClasses[systemType] || "bg-slate-500/15 text-slate-600 dark:text-slate-400"}`}
      data-testid={`badge-system-${systemType.toLowerCase()}`}
    >
      {systemTypeLabel(systemType)}
    </Badge>
  );
}

function JobFormDialog({
  job,
  customers,
  open,
  onOpenChange,
}: {
  job?: Job;
  customers: Customer[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const isEditing = !!job;

  const [name, setName] = useState(job?.name || "");
  const [systemType, setSystemType] = useState(job?.systemType || "VEEAM");
  const [customerId, setCustomerId] = useState<string>(
    job?.customerId?.toString() || ""
  );
  const [scheduleType, setScheduleType] = useState(job?.scheduleType || "daily");
  const [scheduleTime, setScheduleTime] = useState(job?.scheduleTime || "02:00");
  const [windowHours, setWindowHours] = useState(job?.windowHours?.toString() || "6");
  const [longWindowHours, setLongWindowHours] = useState(job?.longWindowHours?.toString() || "24");
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [longRunning, setLongRunning] = useState(job?.longRunning ?? false);
  const [daysOfWeek, setDaysOfWeek] = useState<string[]>(job?.daysOfWeek || []);

  const mutation = useMutation({
    mutationFn: async () => {
      const payload = buildJobPayload({
        name,
        systemType,
        customerId,
        scheduleType,
        scheduleTime,
        windowHours,
        enabled,
        longRunning,
        longWindowHours,
        daysOfWeek,
      });
      if (isEditing) {
        return apiRequest("PATCH", `/api/jobs/${job.id}`, payload);
      }
      return apiRequest("POST", "/api/jobs", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      toast({ title: isEditing ? "Job updated" : "Job created" });
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
          <DialogTitle>{isEditing ? "Edit Job" : "New Backup Job"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="job-name">Job Name</Label>
            <Input
              id="job-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Daily VM Backup"
              data-testid="input-job-name"
            />
          </div>
          <div>
            <Label>System Type</Label>
            <Select value={systemType} onValueChange={setSystemType}>
              <SelectTrigger data-testid="select-system-type">
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
              <SelectTrigger data-testid="select-customer">
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
              <Label>Schedule Type</Label>
              <Select value={scheduleType} onValueChange={setScheduleType}>
                <SelectTrigger data-testid="select-schedule-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="schedule-time">Time</Label>
              <Input
                id="schedule-time"
                type="time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                data-testid="input-schedule-time"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="window-hours">Window (hours)</Label>
            <Input
              id="window-hours"
              type="number"
              min={1}
              max={48}
              value={windowHours}
              onChange={(e) => setWindowHours(e.target.value)}
              data-testid="input-window-hours"
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
                      data-testid={`checkbox-day-${value}`}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="long-running">Long-running job</Label>
            <Switch
              id="long-running"
              checked={longRunning}
              onCheckedChange={setLongRunning}
              data-testid="switch-long-running"
            />
          </div>
          {longRunning && (
            <div>
              <Label htmlFor="long-window-hours">Long Window (hours)</Label>
              <Input
                id="long-window-hours"
                type="number"
                min={1}
                max={336}
                value={longWindowHours}
                onChange={(e) => setLongWindowHours(e.target.value)}
                data-testid="input-long-window-hours"
              />
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="enabled">Enabled</Label>
            <Switch
              id="enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              data-testid="switch-enabled"
            />
          </div>
          <Button
            className="w-full"
            onClick={() => mutation.mutate()}
            disabled={!name || (scheduleType === "weekly" && daysOfWeek.length === 0) || mutation.isPending}
            data-testid="button-save-job"
          >
            {mutation.isPending ? "Saving..." : isEditing ? "Update Job" : "Create Job"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Jobs() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<Job | undefined>();

  const { data: jobs, isLoading } = useQuery<JobWithCustomer[]>({
    queryKey: ["/api/jobs"],
  });

  const { data: customers } = useQuery<Customer[]>({
    queryKey: ["/api/customers"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("DELETE", `/api/jobs/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      toast({ title: "Job deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleEdit = (job: Job) => {
    setEditingJob(job);
    setDialogOpen(true);
  };

  const handleNew = () => {
    setEditingJob(undefined);
    setDialogOpen(true);
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
            Backup Jobs
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage backup job monitoring configuration
          </p>
        </div>
        <Button onClick={handleNew} data-testid="button-new-job">
          <Plus className="h-4 w-4 mr-2" />
          New Job
        </Button>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="p-6">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full mb-2" />
            ))}
          </CardContent>
        </Card>
      ) : !jobs || jobs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <HardDrive className="h-12 w-12 text-muted-foreground mb-3" />
            <h3 className="text-lg font-semibold mb-1">No backup jobs configured</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">
              Create your first backup job to start monitoring email notifications
              from Veeam, PBS, or Synology.
            </p>
            <Button onClick={handleNew} data-testid="button-new-job-empty">
              <Plus className="h-4 w-4 mr-2" />
              Create First Job
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>System</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id} data-testid={`row-job-${job.id}`}>
                    <TableCell className="font-medium">{job.name}</TableCell>
                    <TableCell>
                      <SystemBadge systemType={job.systemType} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {job.customerName || "-"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {job.scheduleType} @ {job.scheduleTime}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <StatusBadge status={jobDisplayStatus(job)} />
                        <div className="text-xs text-muted-foreground">
                          {jobStatusDetail(job)}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleEdit(job)}
                          data-testid={`button-edit-job-${job.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <ConfirmActionButton
                          size="icon"
                          variant="ghost"
                          title={`Delete ${job.name}?`}
                          description="Email matches and expected runs for this job will be unlinked."
                          confirmLabel="Delete"
                          onConfirm={() => deleteMutation.mutate(job.id)}
                          data-testid={`button-delete-job-${job.id}`}
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
        </Card>
      )}

      <JobFormDialog
        key={editingJob?.id ?? "new"}
        job={editingJob}
        customers={customers || []}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}
