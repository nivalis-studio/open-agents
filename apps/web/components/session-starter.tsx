"use client";

import { GitBranch, Plus, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import { cn } from "@/lib/utils";
import { BranchSelectorCompact } from "./branch-selector-compact";
import { RepoSelectorCompact } from "./repo-selector-compact";
import {
  DEFAULT_SANDBOX_TYPE,
  SANDBOX_OPTIONS,
  type SandboxType,
} from "./sandbox-selector-compact";

type SessionMode = "empty" | "repo";

interface SessionStarterProps {
  onSubmit: (session: {
    repoOwner?: string;
    repoName?: string;
    branch?: string;
    cloneUrl?: string;
    isNewBranch: boolean;
    sandboxType: SandboxType;
    initialPrompt?: string;
  }) => void;
  isLoading?: boolean;
  lastRepo: { owner: string; repo: string } | null;
}

export function SessionStarter({
  onSubmit,
  isLoading,
  lastRepo,
}: SessionStarterProps) {
  const [mode, setMode] = useState<SessionMode>(() =>
    lastRepo ? "repo" : "empty",
  );
  const [selectedOwner, setSelectedOwner] = useState(
    () => lastRepo?.owner ?? "",
  );
  const [selectedRepo, setSelectedRepo] = useState(() => lastRepo?.repo ?? "");
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [isNewBranch, setIsNewBranch] = useState(!!lastRepo);
  const [initialPrompt, setInitialPrompt] = useState("");

  const { preferences } = useUserPreferences();

  const sandboxType = preferences?.defaultSandboxType ?? DEFAULT_SANDBOX_TYPE;
  const sandboxName =
    SANDBOX_OPTIONS.find((s) => s.id === sandboxType)?.name ?? sandboxType;

  const handleRepoSelect = (owner: string, repo: string) => {
    setSelectedOwner(owner);
    setSelectedRepo(repo);
    setSelectedBranch(null);
    setIsNewBranch(false);
  };

  const handleRepoClear = () => {
    setSelectedOwner("");
    setSelectedRepo("");
    setSelectedBranch(null);
    setIsNewBranch(false);
  };

  const handleBranchChange = (branch: string | null, newBranch: boolean) => {
    setSelectedBranch(branch);
    setIsNewBranch(newBranch);
  };

  const handleModeChange = (newMode: SessionMode) => {
    setMode(newMode);
    if (newMode === "empty") {
      handleRepoClear();
    }
  };

  const isRepoSelectionComplete =
    mode !== "repo" || (selectedOwner && selectedRepo);
  const isSubmitDisabled = isLoading || !isRepoSelectionComplete;

  const handleSubmit = () => {
    if (isSubmitDisabled) return;

    const trimmedInitialPrompt = initialPrompt.trim();

    onSubmit({
      repoOwner: mode === "repo" ? selectedOwner || undefined : undefined,
      repoName: mode === "repo" ? selectedRepo || undefined : undefined,
      branch: mode === "repo" ? selectedBranch || undefined : undefined,
      cloneUrl:
        mode === "repo" && selectedOwner && selectedRepo
          ? `https://github.com/${selectedOwner}/${selectedRepo}`
          : undefined,
      isNewBranch: mode === "repo" ? isNewBranch : false,
      sandboxType,
      initialPrompt:
        trimmedInitialPrompt.length > 0 ? trimmedInitialPrompt : undefined,
    });
  };

  const hasInitialPrompt = initialPrompt.trim().length > 0;
  const buttonLabel = hasInitialPrompt
    ? mode === "repo" && selectedOwner && selectedRepo
      ? `Start ${selectedOwner}/${selectedRepo} in background`
      : "Start in background"
    : mode === "repo" && selectedOwner && selectedRepo
      ? `Start with ${selectedOwner}/${selectedRepo}`
      : "Start session";

  return (
    <div
      className={cn(
        "w-full max-w-2xl overflow-hidden rounded-xl border border-white/10 bg-neutral-900/60 p-4 sm:p-5",
        "transition-all duration-200",
      )}
    >
      <div className="flex flex-col gap-4">
        {/* Segmented toggle */}
        <div className="flex rounded-lg bg-white/[0.04] p-1">
          <button
            type="button"
            onClick={() => handleModeChange("empty")}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all",
              mode === "empty"
                ? "bg-white/10 text-neutral-100 shadow-sm"
                : "text-neutral-400 hover:text-neutral-300",
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            Empty sandbox
          </button>
          <button
            type="button"
            onClick={() => handleModeChange("repo")}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all",
              mode === "repo"
                ? "bg-white/10 text-neutral-100 shadow-sm"
                : "text-neutral-400 hover:text-neutral-300",
            )}
          >
            <GitBranch className="h-3.5 w-3.5" />
            From repository
          </button>
        </div>

        {/* Repo mode: show repo/branch pickers */}
        {mode === "repo" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <RepoSelectorCompact
                  selectedOwner={selectedOwner}
                  selectedRepo={selectedRepo}
                  onSelect={handleRepoSelect}
                />
              </div>
              {selectedOwner && selectedRepo && (
                <button
                  type="button"
                  onClick={handleRepoClear}
                  className="flex items-center justify-center self-stretch rounded-md border border-white/10 bg-white/[0.03] px-3 text-neutral-500 transition-colors hover:border-white/20 hover:bg-white/[0.06] hover:text-neutral-300"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {selectedOwner && selectedRepo && (
              <BranchSelectorCompact
                owner={selectedOwner}
                repo={selectedRepo}
                value={selectedBranch}
                isNewBranch={isNewBranch}
                onChange={handleBranchChange}
              />
            )}
          </div>
        )}

        {/* Empty mode: brief description */}
        {mode === "empty" && (
          <p className="text-center text-sm text-neutral-500">
            Start with a blank sandbox -- no repository required.
          </p>
        )}

        <div className="space-y-2">
          <label
            htmlFor="initial-prompt"
            className="block text-xs font-medium text-neutral-400"
          >
            Initial prompt (optional)
          </label>
          <textarea
            id="initial-prompt"
            value={initialPrompt}
            onChange={(e) => setInitialPrompt(e.currentTarget.value)}
            placeholder="Describe what you want to ship, and we'll send it as the first message."
            rows={3}
            className="w-full resize-none rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-white/20 focus:outline-none"
          />
          <p className="text-xs text-neutral-500">
            When provided, we'll start the sandbox and run this prompt in the
            background.
          </p>
        </div>

        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitDisabled}
          className={cn(
            "w-full rounded-md px-4 py-2 text-sm font-medium transition-colors",
            isSubmitDisabled
              ? "cursor-not-allowed bg-neutral-700 text-neutral-400"
              : "bg-neutral-200 text-neutral-900 hover:bg-neutral-300",
          )}
        >
          {buttonLabel}
        </button>

        <p className="text-center text-xs text-muted-foreground">
          Using {sandboxName} sandbox{" "}
          <span className="text-muted-foreground/60">&middot;</span>{" "}
          <Link
            href="/settings/preferences"
            className="text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/40"
          >
            Change
          </Link>
        </p>
      </div>
    </div>
  );
}
