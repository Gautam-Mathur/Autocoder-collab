import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

export interface ColumnDef<T = any> {
  key: string;
  header: string;
  render?: (item: T) => ReactNode;
  className?: string;
}

interface DataTableProps<T = any> {
  data: T[];
  columns: ColumnDef<T>[];
  isLoading?: boolean;
  emptyMessage?: string;
  onRowClick?: (item: T) => void;
  rowTestId?: (item: T) => string;
  actions?: (item: T) => ReactNode;
  className?: string;
}

export default function DataTable<T extends { id: number | string }>() {
  data,
  columns,
  isLoading,
  emptyMessage = "No items found.",
  onRowClick,
  rowTestId,
  actions,
  className,
}: DataTableProps<T>) {
  if (isLoading) {
    return (
      <Card className={className}>
        <CardContent className="p-0">
          <div className="p-8 text-center text-muted-foreground" data-testid="text-loading">Loading...</div>
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card className={className}>
        <CardContent className="p-0">
          <div className="p-8 text-center text-muted-foreground" data-testid="text-empty">{emptyMessage}</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b">
              <tr>
                {columns.map((col) => (
                  <th key={col.key} className={cn("text-left p-3 text-sm font-medium text-muted-foreground", col.className)}>
                    {col.header}
                  </th>
                ))}
                {actions && (
                  <th className="text-right p-3 text-sm font-medium text-muted-foreground">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.map((item) => (
                <tr
                  key={item.id}
                  className={cn("hover:bg-muted/50 transition-colors", onRowClick && "cursor-pointer")}
                  onClick={() => onRowClick?.(item)}
                  data-testid={rowTestId?.(item)}
                >
                  {columns.map((col) => (
                    <td key={col.key} className={cn("p-3 text-sm", col.className)}>
                      {col.render ? col.render(item) : (item as any)[col.key]}
                    </td>
                  ))}
                  {actions && (
                    <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                      {actions(item)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
