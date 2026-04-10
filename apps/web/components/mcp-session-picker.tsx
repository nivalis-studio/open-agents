"use client";

import { Plug, Settings2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { fetcher } from "@/lib/swr";

interface MCPConnectionSafe {
  id: string;
  provider: string | null;
  name: string;
  url: string;
  status: "active" | "needs_auth" | "error" | "unchecked";
  enabledByDefault: boolean;
}

interface McpSessionPickerProps {
  sessionId: string;
  enabledMcpConnectionIds: string[];
  onEnabledIdsChange?: (ids: string[]) => void;
}

export function McpSessionPicker({
  sessionId,
  enabledMcpConnectionIds,
  onEnabledIdsChange,
}: McpSessionPickerProps) {
  const [open, setOpen] = useState(false);
  const [enabledIds, setEnabledIds] = useState<string[]>(
    enabledMcpConnectionIds,
  );
  const [saving, setSaving] = useState(false);

  const { data: connections } = useSWR<MCPConnectionSafe[]>(
    "/api/mcp/connections",
    fetcher,
  );

  // Sync from props when they change externally
  useEffect(() => {
    setEnabledIds(enabledMcpConnectionIds);
  }, [enabledMcpConnectionIds]);

  const activeConnections = connections?.filter((c) => c.status === "active");

  const handleToggle = useCallback(
    async (connectionId: string, checked: boolean) => {
      const newIds = checked
        ? [...enabledIds, connectionId]
        : enabledIds.filter((id) => id !== connectionId);

      setEnabledIds(newIds);
      setSaving(true);

      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabledMcpConnectionIds: newIds }),
        });
        if (res.ok) {
          onEnabledIdsChange?.(newIds);
        } else {
          // Revert on failure
          setEnabledIds(enabledIds);
        }
      } catch {
        // Revert on failure
        setEnabledIds(enabledIds);
      } finally {
        setSaving(false);
      }
    },
    [enabledIds, sessionId, onEnabledIdsChange],
  );

  const enabledCount =
    activeConnections?.filter((c) => enabledIds.includes(c.id)).length ?? 0;

  // Don't render anything if user has no active MCP connections
  if (connections && (!activeConnections || activeConnections.length === 0)) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Plug className="size-3.5" />
          {enabledCount > 0 && (
            <span className="tabular-nums">{enabledCount}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start" sideOffset={8}>
        <div className="border-b border-border px-3 py-2">
          <p className="text-xs font-medium">MCP Connections</p>
        </div>

        {!activeConnections || activeConnections.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            No active MCP connections
          </div>
        ) : (
          <div className="max-h-48 overflow-y-auto py-1">
            {activeConnections.map((conn) => (
              <button
                type="button"
                key={conn.id}
                className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-1.5 hover:bg-muted/50"
                onClick={() =>
                  void handleToggle(conn.id, !enabledIds.includes(conn.id))
                }
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="inline-block size-2 shrink-0 rounded-full bg-green-500" />
                  <span className="text-sm truncate">{conn.name}</span>
                </div>
                <Switch
                  checked={enabledIds.includes(conn.id)}
                  onCheckedChange={(checked) =>
                    void handleToggle(conn.id, checked)
                  }
                  disabled={saving}
                  className="scale-75"
                />
              </button>
            ))}
          </div>
        )}

        <div className="border-t border-border px-3 py-2">
          <Link
            href="/settings/connections"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setOpen(false)}
          >
            <Settings2 className="size-3" />
            Manage MCPs
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
