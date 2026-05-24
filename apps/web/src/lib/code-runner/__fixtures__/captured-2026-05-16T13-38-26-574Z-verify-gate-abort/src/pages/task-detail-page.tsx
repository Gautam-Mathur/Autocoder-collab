/**
 * KB Entity Guidance for Task:
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

export default function TaskDetailPage() {
  const [, params] = useRoute("/tasks/:id");
  const id = params?.id;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const { data: item, isLoading, isError, refetch } = useQuery<any>({
    queryKey: ["/api/tasks", id],
    enabled: !!id,
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/tasks/${id}`);
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
      const previous = queryClient.getQueryData<any[]>(["/api/tasks"]);
      queryClient.setQueryData<any[]>(["/api/tasks"], (old) =>
        (old ?? []).filter((item: any) => item.id !== Number(id))
      );
      return { previous };
    },
    onError: (_err: Error, _vars: any, context: any) => {
      if (context?.previous) queryClient.setQueryData(["/api/tasks"], context.previous);
      toast({ title: "Error", description: _err.message, variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({ title: "Task deleted" });
      navigate("/tasks");
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
          <h3 className="text-lg font-semibold">Failed to load task</h3>
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
        <Link href="/tasks">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to list
          </Button>
        </Link>
        <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 border-2 border-dashed rounded-lg bg-muted/30">
          <div className="rounded-full bg-muted p-6">
            <Plus className="h-12 w-12 text-muted-foreground" />
          </div>
          <div className="text-center">
            <h3 className="text-lg font-semibold">Task not found</h3>
            <p className="text-sm text-muted-foreground">The task you are looking for does not exist or has been deleted.</p>
          </div>
          <Link href="/tasks">
            <Button variant="outline">Back to list</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8 space-y-6" data-testid="page-task-detail">
      <div className="flex items-center gap-4 flex-wrap">
        <Link href="/tasks">
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-bold flex-1" data-testid="text-page-title">
          {item?.title || "Task Details"}
        </h1>
        <div className="flex items-center gap-2">
            {item?.projectId && <Link href={`/projects/${item.projectId}`}><Button variant="ghost" size="sm"><ArrowLeft className="h-3 w-3 mr-1" /> View Project</Button></Link>}
            {item?.assigneeId && <Link href={`/team/${item.assigneeId}`}><Button variant="ghost" size="sm"><ArrowLeft className="h-3 w-3 mr-1" /> View Team Member</Button></Link>}
          <Button
            variant="destructive"
            onClick={() => setShowDeleteConfirm(true)}
            data-testid="button-delete-task"
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
                <dt className="text-sm text-muted-foreground">Title</dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-title">{safeGet(item, "title")}</dd>
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
                <dt className="text-sm text-muted-foreground">Priority</dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-priority">{safeGet(item, "priority")}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Due Date</dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-due-date">{formatDate(item?.dueDate)}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Labels</dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-labels">{safeGet(item, "labels")}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Estimated Hours</dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-estimated-hours">{safeGet(item, "estimatedHours")}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Actual Hours</dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-actual-hours">{safeGet(item, "actualHours")}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Comment Count <span className="text-xs text-primary">(computed)</span></dt>
                <dd className="text-sm font-medium mt-1" data-testid="text-comment-count">{relatedComments.length}</dd>
              </div>
          </dl>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Comments</CardTitle>
          <Button size="sm" variant="outline" onClick={() => setShowCommentForm(!showAddComment)} data-testid="button-add-comment">
            <Plus className="h-3 w-3 mr-1" /> Add
          </Button>
        </CardHeader>
        <CardContent>
          {showAddComment && (
            <div className="mb-4 p-3 border rounded-md space-y-2 bg-muted/30">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="status">Status</Label>
                <Input id="status" placeholder="Enter status" value={childCommentStatus} onChange={(e) => setChildCommentStatus(e.target.value)} data-testid="input-status" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="content">Content</Label>
                <Textarea id="content" placeholder="Enter content..." rows={3} value={childCommentContent} onChange={(e) => setChildCommentContent(e.target.value)} data-testid="input-content" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="likes">Likes</Label>
                <Input id="likes" type="number" value={childCommentLikes} onChange={(e) => setChildCommentLikes(Number(e.target.value))} data-testid="input-likes" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="authorId">Author Id</Label>
                <Input id="authorId" type="number" value={childCommentAuthorId} onChange={(e) => setChildCommentAuthorId(Number(e.target.value))} data-testid="input-author-id" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="parentId">Parent Id</Label>
                <Input id="parentId" type="number" value={childCommentParentId} onChange={(e) => setChildCommentParentId(Number(e.target.value))} data-testid="input-parent-id" />
              </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" onClick={() => setShowCommentForm(false)}>Cancel</Button>
                <Button size="sm" onClick={() => createCommentMutation.mutate({
      status: childCommentStatus,
      content: childCommentContent,
      likes: childCommentLikes,
      authorId: childCommentAuthorId,
      parentId: childCommentParentId,
      taskId: Number(id),
    }} loading={createCommentMutation.isPending} data-testid="button-submit-comment">
                  {createCommentMutation.isPending ? "Adding..." : "Add Comment"}
                </Button>
              </div>
            </div>
          )}
          {comments.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                  <th className="text-left py-2 font-medium text-sm">Status</th>
                  <th className="text-left py-2 font-medium text-sm">Content</th>
                  <th className="text-left py-2 font-medium text-sm">Likes</th>
                  <th className="text-left py-2 font-medium text-sm">Author Id</th>
                  <th className="text-left py-2 font-medium text-sm">Parent Id</th>
                  </tr>
                </thead>
                <tbody>
                  {comments.map((child: any) => (
                    <tr key={child.id} className="border-b last:border-0">
                    <td className="py-2 text-sm"><StatusBadge status={child?.status ?? ""} data-testid="text-status" /></td>
                    <td className="py-2 text-sm">{safeGet(child, "content")}</td>
                    <td className="py-2 text-sm">{safeGet(child, "likes")}</td>
                    <td className="py-2 text-sm">{safeGet(child, "authorId")}</td>
                    <td className="py-2 text-sm">{safeGet(child, "parentId")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No comments yet.</p>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Task?"
        description="This action cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />
    </div>
  );
}
