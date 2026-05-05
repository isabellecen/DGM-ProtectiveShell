import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge, StatusDot } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  HardDrive,
  Server,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Activity,
} from "lucide-react";
import type { Job, ProxmoxHost, Incident, ExpectedRun } from "@shared/schema";
import { Link } from "wouter";
import { format } from "date-fns";

interface DashboardStats {
  totalJobs: number;
  enabledJobs: number;
  totalHosts: number;
  openIncidents: number;
  recentRuns: (ExpectedRun & { jobName?: string })[];
  recentIncidents: Incident[];
  hostStatuses: { status: string; count: number }[];
  jobsBySystem: { systemType: string; count: number }[];
}

function StatCard({
  title,
  value,
  description,
  icon: Icon,
  trend,
}: {
  title: string;
  value: string | number;
  description: string;
  icon: any;
  trend?: "up" | "down" | "neutral";
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" data-testid={`text-stat-${title.toLowerCase().replace(/\s+/g, "-")}`}>
          {value}
        </div>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-4" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16 mb-1" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        {[...Array(2)].map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
            </CardHeader>
            <CardContent>
              {[...Array(3)].map((_, j) => (
                <Skeleton key={j} className="h-10 w-full mb-2" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { data: stats, isLoading } = useQuery<DashboardStats>({
    queryKey: ["/api/dashboard/stats"],
    refetchInterval: 30_000,
  });

  if (isLoading || !stats) {
    return (
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Overview of backup monitoring and infrastructure health
          </p>
        </div>
        <LoadingSkeleton />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Overview of backup monitoring and infrastructure health
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatCard
          title="Backup Jobs"
          value={stats.enabledJobs}
          description={`${stats.totalJobs} total, ${stats.enabledJobs} enabled`}
          icon={HardDrive}
        />
        <StatCard
          title="Proxmox Hosts"
          value={stats.totalHosts}
          description="Monitored hosts"
          icon={Server}
        />
        <StatCard
          title="Open Incidents"
          value={stats.openIncidents}
          description={stats.openIncidents === 0 ? "All clear" : "Needs attention"}
          icon={AlertTriangle}
        />
        <StatCard
          title="System Health"
          value={stats.openIncidents === 0 ? "Healthy" : "Degraded"}
          description="Overall status"
          icon={Activity}
        />
      </div>

      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0">
            <CardTitle className="text-base font-semibold">Recent Backup Runs</CardTitle>
            <Link
              href="/jobs"
              className="text-xs text-primary hover:underline"
              data-testid="link-view-all-jobs"
            >
              View all
            </Link>
          </CardHeader>
          <CardContent>
            {stats.recentRuns.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Clock className="h-8 w-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">No backup runs recorded yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Runs will appear here once IMAP polling is configured
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {stats.recentRuns.map((run) => (
                  <div
                    key={run.id}
                    className="flex items-center justify-between gap-2 py-2 border-b border-border/50 last:border-0"
                    data-testid={`row-run-${run.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <StatusDot status={run.status} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {run.jobName || `Job #${run.jobId}`}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Scheduled: {format(new Date(run.scheduledFor), "MMM d, HH:mm")}
                        </p>
                      </div>
                    </div>
                    <StatusBadge status={run.status} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0">
            <CardTitle className="text-base font-semibold">Recent Incidents</CardTitle>
            <Link
              href="/incidents"
              className="text-xs text-primary hover:underline"
              data-testid="link-view-all-incidents"
            >
              View all
            </Link>
          </CardHeader>
          <CardContent>
            {stats.recentIncidents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <CheckCircle2 className="h-8 w-8 text-emerald-500 mb-2" />
                <p className="text-sm text-muted-foreground">No incidents</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Everything is running smoothly
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {stats.recentIncidents.map((incident) => (
                  <div
                    key={incident.id}
                    className="flex items-center justify-between gap-2 py-2 border-b border-border/50 last:border-0"
                    data-testid={`row-incident-${incident.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <StatusDot status={incident.severity} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{incident.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {format(new Date(incident.createdAt), "MMM d, HH:mm")} - {incident.sourceType}
                        </p>
                      </div>
                    </div>
                    <StatusBadge status={incident.state} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Host Status Overview</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.hostStatuses.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Server className="h-8 w-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">No hosts configured</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Add Proxmox hosts to start monitoring
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {stats.hostStatuses.map((hs) => (
                  <div key={hs.status} className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <StatusDot status={hs.status} />
                      <span className="text-sm">{hs.status}</span>
                    </div>
                    <span className="text-sm font-medium">{hs.count}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Jobs by System</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.jobsBySystem.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <HardDrive className="h-8 w-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">No jobs configured</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Create backup jobs to start monitoring
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {stats.jobsBySystem.map((js) => (
                  <div key={js.systemType} className="flex items-center justify-between gap-2">
                    <span className="text-sm">{js.systemType}</span>
                    <span className="text-sm font-medium">{js.count}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
