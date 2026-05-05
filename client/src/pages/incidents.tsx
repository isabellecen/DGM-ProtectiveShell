import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, CheckCircle2, Eye } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Incident } from "@shared/schema";
import { format } from "date-fns";
import { useState } from "react";

export default function Incidents() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("open");

  const { data: incidents, isLoading } = useQuery<Incident[]>({
    queryKey: ["/api/incidents"],
    refetchInterval: 30_000,
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, state }: { id: number; state: string }) => {
      return apiRequest("PATCH", `/api/incidents/${id}`, { state });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/incidents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      toast({ title: "Incident updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const filteredIncidents = incidents?.filter((i) => {
    if (activeTab === "open") return i.state === "OPEN";
    if (activeTab === "acked") return i.state === "ACKED";
    if (activeTab === "resolved") return i.state === "RESOLVED";
    return true;
  });

  const openCount = incidents?.filter((i) => i.state === "OPEN").length || 0;
  const ackedCount = incidents?.filter((i) => i.state === "ACKED").length || 0;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
          Incidents
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Track and manage backup failures, missing runs, and infrastructure alerts
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="open" data-testid="tab-open">
            Open {openCount > 0 && `(${openCount})`}
          </TabsTrigger>
          <TabsTrigger value="acked" data-testid="tab-acked">
            Acknowledged {ackedCount > 0 && `(${ackedCount})`}
          </TabsTrigger>
          <TabsTrigger value="resolved" data-testid="tab-resolved">
            Resolved
          </TabsTrigger>
          <TabsTrigger value="all" data-testid="tab-all">
            All
          </TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab}>
          {isLoading ? (
            <Card>
              <CardContent className="p-6">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full mb-2" />
                ))}
              </CardContent>
            </Card>
          ) : !filteredIncidents || filteredIncidents.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                {activeTab === "open" ? (
                  <>
                    <CheckCircle2 className="h-12 w-12 text-emerald-500 mb-3" />
                    <h3 className="text-lg font-semibold mb-1">No open incidents</h3>
                    <p className="text-sm text-muted-foreground max-w-sm">
                      All systems are operating normally. Incidents will appear here
                      when backup failures or infrastructure issues are detected.
                    </p>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-12 w-12 text-muted-foreground mb-3" />
                    <h3 className="text-lg font-semibold mb-1">No incidents found</h3>
                    <p className="text-sm text-muted-foreground">
                      No incidents match the current filter.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Severity</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="w-32">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredIncidents.map((incident) => (
                      <TableRow key={incident.id} data-testid={`row-incident-${incident.id}`}>
                        <TableCell>
                          <StatusBadge status={incident.severity} />
                        </TableCell>
                        <TableCell>
                          <div>
                            <p className="font-medium text-sm">{incident.title}</p>
                            {incident.details && (
                              <p className="text-xs text-muted-foreground truncate max-w-xs">
                                {incident.details}
                              </p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {incident.sourceType}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={incident.state} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {format(new Date(incident.createdAt), "MMM d, HH:mm")}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {incident.state === "OPEN" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  updateMutation.mutate({
                                    id: incident.id,
                                    state: "ACKED",
                                  })
                                }
                                data-testid={`button-ack-${incident.id}`}
                              >
                                <Eye className="h-3.5 w-3.5 mr-1" />
                                Ack
                              </Button>
                            )}
                            {(incident.state === "OPEN" || incident.state === "ACKED") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  updateMutation.mutate({
                                    id: incident.id,
                                    state: "RESOLVED",
                                  })
                                }
                                data-testid={`button-resolve-${incident.id}`}
                              >
                                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                                Resolve
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
