/**
 * KB Entity Guidance for Project:
 * ## Knowledge Base: Relevant Guidance for This Generation
 * 
 * ### Anti-Patterns to AVOID in This File
 * 
 * **❌ Using array index as React key** (high)
 * Why bad: When items are reordered, inserted, or deleted, index keys cause React to mis-identify elements, leading to wrong state, broken animations, and subtle rendering bugs.
 * Fix: Use a stable, unique identifier from the data (e.g. item.id). If no ID exists, generate one once on creation and store it.
 * Bad:  `{items.map((item, index) => <ItemCard key={index} item={item} />)}`
 * Good: `{items.map(item => <ItemCard key={item.id} item={item} />)}`
 * 
 * **❌ Missing loading and error states** (high)
 * Why bad: Users see blank screens, unresponsive UIs, or data that is actually an error. Poor UX that signals broken software.
 * Fix: Every async data fetch needs three states: loading (show skeleton/spinner), success (show data), error (show message with retry option). Use a custom useAsync hook to standardise this.
 * Bad:  `function UserList() { const [users, setUsers] = useState([]); useEffect(() => { fetch("/api/users").then(r => r.json()).then(setUsers); }, []); return <ul>{users.map(u => <li key={u.id}>{u.name}</li>)}</ul>; }`
 * Good: `function UserList() { const { data: users, loading, error } = useQuery("/api/users"); if (loading) return <Skeleton />; if (error) return <ErrorMessage error={error} />; return <ul>{users!.map(u => <li key={u.id}>{u.name}</li>)}</ul>; }`
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { safeGet, formatCurrency, formatPercent, formatDate, formatDateTime } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectTrigger, SelectContent, SelectValue, SelectItem } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Trash2, Edit, AlertCircle, RefreshCcw, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { useRoute, Link } from "wouter";
import ConfirmDialog from "@/components/confirm-dialog";
import StatusBadge from "@/components/status-badge";

export default function ProjectDetailPage() {
  const [, params] = useRoute("/projects/:id");
  const id = params?.id;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const { data: item, isLoading, isError, refetch } = useQuery<any>({
    queryKey: ["/api/projects", id],
    enabled: !!id,
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/projects/${id}`);
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/projects"] });
      const previous = queryClient.getQueryData<any[]>(["/api/projects"]);
      queryClient.setQueryData<any[]>(["/api/projects"], (old) =>
        (old ?? []).filter((item: any) => item.id !== Number(id))
      );
      return { previous };
    },
    onError: (_err: Error, _vars: any, context: any) => {
      if (context?.previous) queryClient.setQueryData(["/api/projects"], context.previous);
      toast({ title: "Error", description: _err.message, variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      toast({ title: "Project deleted" });
      navigate("/projects");
    },
  });

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        <div className="flex items-center gap-4">
          <div className="h-10 w-10 rounded-md bg-muted animate-pulse" />
          <div className="h-8 w-64 bg-muted animate-pulse rounded-md" />
        </div>
        <Card>
          <CardHeader>
            <div className="h-6 w-32 bg-muted animate-pulse rounded-md" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[1, 2, 3, 4].map(i => (
                <div key={i} className="space-y-2">
                  <div className="h-4 w-24 bg-muted animate-pulse rounded-md" />
                  <div className="h-5 w-full bg-muted animate-pulse rounded-md" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <div className="text-center">
          <h3 className="text-lg font-semibold">Failed to load project</h3>
          <p className="text-sm text-muted-foreground">There was an error fetching the details. Please try again.</p>
        </div>
        <Button onClick={() => refetch()} variant="outline">
          <RefreshCcw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8 space-y-4" data-testid="text-not-found">
        <Link href="/projects">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to list
          </Button>
        </Link>
        <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 border-2 border-dashed rounded-lg bg-muted/30">
          <div className="rounded-full bg-muted p-6">
            <Plus className="h-12 w-12 text-muted-foreground" />
          </div>
          <div className="text-center">
            <h3 className="text-lg font-semibold">Project not found</h3>
            <p className="text-sm text-muted-foreground">The project you are looking for does not exist or has been deleted.</p>
          </div>
          <Link href="/projects">
            <Button variant="outline">Back to list</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8 space-y-6" data-testid="page-project-detail">
      <div className="flex items-center gap-4 flex-wrap">
        <Link href="/projects">
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-bold flex-1" data-testid="text-page-title">
          {item?.name || "Project Details"}
        </h1>
        <div className="flex items-center gap-2">
          <Button
            variant="destructive"
            onClick={() => setShowDeleteConfirm(true)}
            data-testid="button-delete-project"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <dt className="text-sm text-muted-foreground">Name</dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-name">{safeGet(item, "name")}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Status</dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-status"><StatusBadge status={item?.status ?? ""} data-testid="text-status" /></dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Description</dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-description">{safeGet(item, "description")}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Start Date</dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-start-date">{formatDate(item?.startDate)}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">End Date</dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-end-date">{formatDate(item?.endDate)}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Progress</dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-progress">{safeGet(item, "progress")}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Budget</dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-budget">{formatCurrency(item?.budget)}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Priority</dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-priority">{safeGet(item, "priority")}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Duration <span className="text-xs text-primary">(computed)</span></dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-duration">{Math.ceil((new Date(item.endDate).getTime() - new Date(item.startDate).getTime()) / (1000 * 60 * 60 * 24))}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Task Count <span className="text-xs text-primary">(computed)</span></dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-task-count">{relatedTasks.length}</dd>
              </div>
          </dl>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Tasks</CardTitle>
          <Button size="sm" variant="outline" onClick={() => setShowTaskForm(!showAddTask)} data-testid="button-add-task">
            <Plus className="h-3 w-3 mr-1" /> Add
          </Button>
        </CardHeader>
        <CardContent>
          {showAddTask && (
            <div className="mb-4 p-3 border rounded-md space-y-2 bg-muted/30">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input id="title" placeholder="Enter title" value={childTaskTitle} onChange={(e) => setChildTaskTitle(e.target.value)} data-testid="input-title" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="status">Status</Label>
                <Select value={childTaskStatus} onValueChange={(val) => setChildTaskStatus(val)}>
                  <SelectTrigger data-testid="input-status">
                    <SelectValue placeholder="Select Status..." />
                  </SelectTrigger>
                  <SelectContent>
                  <SelectItem value="backlog">Backlog</SelectItem>
                  <SelectItem value="todo">Todo</SelectItem>
                  <SelectItem value="in-progress">In Progress</SelectItem>
                  <SelectItem value="review">Review</SelectItem>
                  <SelectItem value="done">Done</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea id="description" placeholder="Enter description..." rows={3} value={childTaskDescription} onChange={(e) => setChildTaskDescription(e.target.value)} data-testid="input-description" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="priority">Priority</Label>
                <Select value={childTaskPriority} onValueChange={(val) => setChildTaskPriority(val)}>
                  <SelectTrigger data-testid="input-priority">
                    <SelectValue placeholder="Select Priority..." />
                  </SelectTrigger>
                  <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="dueDate">Due Date</Label>
                <Input id="dueDate" type="date" value={childTaskDueDate} onChange={(e) => setChildTaskDueDate(e.target.value)} data-testid="input-due-date" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="labels">Labels</Label>
                <Input id="labels" placeholder="Enter labels" value={childTaskLabels} onChange={(e) => setChildTaskLabels(e.target.value)} data-testid="input-labels" />
              </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" onClick={() => setShowTaskForm(false)}>Cancel</Button>
                <Button size="sm" onClick={() => createTaskMutation.mutate({
      title: childTaskTitle,
      status: childTaskStatus,
      description: childTaskDescription,
      priority: childTaskPriority,
      dueDate: childTaskDueDate,
      labels: childTaskLabels,
      projectId: Number(id),
    }} loading={createTaskMutation.isPending} data-testid="button-submit-task">
                  {createTaskMutation.isPending ? "Adding..." : "Add Task"}
                </Button>
              </div>
            </div>
          )}
          {tasks.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                  <th className="text-left py-2 font-medium text-sm">Title</th>
                  <th className="text-left py-2 font-medium text-sm">Status</th>
                  <th className="text-left py-2 font-medium text-sm">Description</th>
                  <th className="text-left py-2 font-medium text-sm">Priority</th>
                  <th className="text-left py-2 font-medium text-sm">Due Date</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((child: any) => (
                    <tr key={child.id} className="border-b last:border-0">
                    <td className="py-2 text-sm">{safeGet(child, "title")}</td>
                    <td className="py-2 text-sm"><StatusBadge status={child?.status ?? ""} data-testid="text-status" /></td>
                    <td className="py-2 text-sm">{safeGet(child, "description")}</td>
                    <td className="py-2 text-sm">{safeGet(child, "priority")}</td>
                    <td className="py-2 text-sm">{formatDate(child?.dueDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No tasks yet.</p>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Project?"
        description="This action cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />
    </div>
  );
}
