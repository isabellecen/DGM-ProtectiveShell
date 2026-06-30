import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const statusConfig: Record<string, { className: string; label: string }> = {
  OK: { className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", label: "OK" },
  WARN: { className: "bg-amber-500/15 text-amber-700 dark:text-amber-400", label: "Warning" },
  CRIT: { className: "bg-red-500/15 text-red-700 dark:text-red-400", label: "Critical" },
  FAIL: { className: "bg-red-500/15 text-red-700 dark:text-red-400", label: "Failed" },
  MISSING: { className: "bg-orange-500/15 text-orange-700 dark:text-orange-400", label: "Missing" },
  PENDING: { className: "bg-sky-500/15 text-sky-700 dark:text-sky-400", label: "Pending" },
  UNKNOWN: { className: "bg-slate-500/15 text-slate-600 dark:text-slate-400", label: "Unknown" },
  DISABLED: { className: "bg-slate-500/15 text-slate-600 dark:text-slate-400", label: "Disabled" },
  OPEN: { className: "bg-red-500/15 text-red-700 dark:text-red-400", label: "Open" },
  ACKED: { className: "bg-amber-500/15 text-amber-700 dark:text-amber-400", label: "Acknowledged" },
  RESOLVED: { className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", label: "Resolved" },
  INFO: { className: "bg-sky-500/15 text-sky-700 dark:text-sky-400", label: "Info" },
};

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = statusConfig[status] || statusConfig.UNKNOWN;
  return (
    <Badge
      variant="outline"
      className={cn(
        "no-default-hover-elevate no-default-active-elevate border-transparent font-medium",
        config.className,
        className
      )}
      data-testid={`badge-status-${status.toLowerCase()}`}
    >
      {config.label}
    </Badge>
  );
}

export function StatusDot({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    OK: "bg-emerald-500",
    WARN: "bg-amber-500",
    CRIT: "bg-red-500",
    FAIL: "bg-red-500",
    MISSING: "bg-orange-500",
    PENDING: "bg-sky-500",
    UNKNOWN: "bg-slate-400",
    DISABLED: "bg-slate-400",
    OPEN: "bg-red-500",
    ACKED: "bg-amber-500",
    RESOLVED: "bg-emerald-500",
  };

  return (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full",
        colorMap[status] || "bg-slate-400"
      )}
    />
  );
}
