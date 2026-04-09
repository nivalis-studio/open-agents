"use client";

import { PatchDiff } from "@pierre/diffs/react";
import {
  AlignJustify,
  Columns2,
  FileText,
  Loader2,
  RefreshCw,
  SquareDot,
  SquareMinus,
  SquarePlus,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DiffFile } from "@/app/api/sessions/[sessionId]/diff/route";
import { useGitPanel } from "./git-panel-context";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type DiffMode,
  useUserPreferences,
} from "@/hooks/use-user-preferences";
import { useIsMobile } from "@/hooks/use-mobile";
import { defaultDiffOptions, splitDiffOptions } from "@/lib/diffs-config";
import { cn } from "@/lib/utils";
import { useSessionChatWorkspaceContext } from "./session-chat-context";

type DiffStyle = DiffMode;

const wrappedDiffExtensions = new Set([".md", ".mdx", ".markdown", ".txt"]);

function shouldWrapDiffContent(filePath: string) {
  const normalizedPath = filePath.toLowerCase();
  return [...wrappedDiffExtensions].some((extension) =>
    normalizedPath.endsWith(extension),
  );
}

function formatTimestamp(date: Date) {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function StaleBanner({ cachedAt }: { cachedAt: Date | null }) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-amber-100 px-4 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
      <span>
        Viewing cached changes - sandbox is offline
        {cachedAt && (
          <span className="text-amber-700/70 dark:text-amber-400/70">
            {" "}
            (saved {formatTimestamp(cachedAt)})
          </span>
        )}
      </span>
    </div>
  );
}

function FileStatusIcon({ status }: { status: DiffFile["status"] }) {
  if (status === "added") {
    return <SquarePlus className="h-4 w-4 shrink-0 text-green-500" />;
  }
  if (status === "deleted") {
    return <SquareMinus className="h-4 w-4 shrink-0 text-red-500" />;
  }
  // modified + renamed
  return <SquareDot className="h-4 w-4 shrink-0 text-yellow-500" />;
}

/**
 * Shows a single file's diff, opened from the git panel's diff file list.
 * No multi-file view, no collapse — just the file header + patch.
 */
export function DiffTabView() {
  const {
    diff,
    diffLoading,
    diffRefreshing,
    diffError,
    diffCachedAt,
    sandboxInfo,
    refreshDiff,
  } = useSessionChatWorkspaceContext();
  const { focusedDiffFile, setFocusedDiffFile, diffScope } = useGitPanel();
  const isMobile = useIsMobile();
  const { preferences } = useUserPreferences();
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");

  // Find the focused file in the diff data
  const file = useMemo(() => {
    if (!diff || !focusedDiffFile) return null;
    return diff.files.find((f) => f.path === focusedDiffFile) ?? null;
  }, [diff, focusedDiffFile]);

  // When in uncommitted scope and the focused file has no local changes,
  // auto-switch to the first file that does have uncommitted changes.
  useEffect(() => {
    if (diffScope !== "uncommitted" || !diff || !file) return;
    const hasLocalChanges =
      file.stagingStatus === "unstaged" || file.stagingStatus === "partial";
    if (hasLocalChanges) return;

    const firstUncommitted = diff.files.find(
      (f) => f.stagingStatus === "unstaged" || f.stagingStatus === "partial",
    );
    if (firstUncommitted) {
      setFocusedDiffFile(firstUncommitted.path);
    }
    // If no uncommitted files exist, keep the current file selected
    // so the Changes tab stays open — the empty state renders inline.
  }, [diffScope, diff, file, setFocusedDiffFile]);

  const showStaleIndicator = !sandboxInfo && diff !== null;

  useEffect(() => {
    if (isMobile) {
      setDiffStyle("unified");
      return;
    }
    setDiffStyle(preferences?.defaultDiffMode ?? "unified");
  }, [isMobile, preferences?.defaultDiffMode]);

  const baseOptions =
    diffStyle === "split" ? splitDiffOptions : defaultDiffOptions;

  // If there's no focused file yet, show an empty state
  if (!focusedDiffFile) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center border-b border-border px-4 py-2">
          <span className="text-sm font-medium text-muted-foreground font-mono">
            No file selected
          </span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground/50">
          <FileText className="h-8 w-8" />
          <p className="text-sm">
            Select a file from the Changes panel to view its diff
          </p>
        </div>
      </div>
    );
  }

  const fileName = file ? (file.path.split("/").pop() ?? file.path) : "";

  // Don't show file info in toolbar when the file has no local changes in uncommitted scope
  const isFileVisibleInScope =
    file &&
    (diffScope === "branch" ||
      file.stagingStatus === "unstaged" ||
      file.stagingStatus === "partial");

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {isFileVisibleInScope ? (
            <>
              <FileStatusIcon status={file.status} />
              <span className="shrink-0 text-sm font-medium font-mono">
                {fileName}
              </span>
              <div className="flex shrink-0 items-center gap-1.5 text-xs">
                {file.additions > 0 && (
                  <span className="text-green-600 dark:text-green-500">
                    +{file.additions}
                  </span>
                )}
                {file.deletions > 0 && (
                  <span className="text-red-600 dark:text-red-400">
                    -{file.deletions}
                  </span>
                )}
              </div>
            </>
          ) : (
            <span className="text-sm font-medium text-muted-foreground font-mono">
              No file selected
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => refreshDiff()}
                disabled={diffRefreshing || !sandboxInfo}
                className="h-7 w-7 px-0"
              >
                <RefreshCw
                  className={cn(
                    "h-3.5 w-3.5",
                    diffRefreshing && "animate-spin",
                  )}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Refresh</TooltipContent>
          </Tooltip>
          {/* Unified / Split icon toggle */}
          <div className="hidden items-center rounded-md border border-border md:flex">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setDiffStyle("unified")}
                  className={cn(
                    "rounded-l-md p-1.5 transition-colors",
                    diffStyle === "unified"
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <AlignJustify className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Unified</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setDiffStyle("split")}
                  className={cn(
                    "rounded-r-md p-1.5 transition-colors",
                    diffStyle === "split"
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Columns2 className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Split</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {showStaleIndicator ? <StaleBanner cachedAt={diffCachedAt} /> : null}

      {/* Content */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          showStaleIndicator && "opacity-90",
        )}
      >
        {diffLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {diffError && (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-red-600 dark:text-red-400">
              {diffError}
            </p>
          </div>
        )}

        {!diffLoading && !diffError && !file && (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              File not found in diff
            </p>
          </div>
        )}

        {!diffLoading &&
          !diffError &&
          file &&
          (() => {
            const isLocalScope = diffScope === "uncommitted";
            const hasLocalChanges =
              file.stagingStatus === "unstaged" ||
              file.stagingStatus === "partial";

            // The effect above will auto-redirect or clear; show empty state while pending.
            if (isLocalScope && !hasLocalChanges) {
              return (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground/50">
                  <FileText className="h-8 w-8" />
                  <p className="text-sm">No uncommitted changes to display</p>
                </div>
              );
            }

            // In local scope, prefer the localDiff (uncommitted changes vs HEAD)
            const patchContent =
              isLocalScope && file.localDiff ? file.localDiff : file.diff;

            return (
              <div>
                {file.generated ? (
                  <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                    Generated file — diff content hidden
                  </div>
                ) : patchContent ? (
                  <PatchDiff
                    key={`${file.path}-${diffStyle}-${diffScope}`}
                    patch={patchContent}
                    options={
                      shouldWrapDiffContent(file.path)
                        ? { ...baseOptions, overflow: "wrap" as const }
                        : baseOptions
                    }
                  />
                ) : (
                  <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                    No diff content available
                  </div>
                )}
              </div>
            );
          })()}
      </div>
    </div>
  );
}
