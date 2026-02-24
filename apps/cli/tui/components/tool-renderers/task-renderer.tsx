import type {
  TaskToolStreamOutput,
  ReconstructedSubagentMessage,
  ReconstructedPart,
} from "@open-harness/agent";
import { reconstructSubagentMessage } from "@open-harness/agent";
import { formatTokens } from "@open-harness/shared";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
// ai SDK imports removed — we use ReconstructedPart type guards instead
import React, { useMemo } from "react";
import { useChatContext } from "../../chat-context";
import { PRIMARY_COLOR } from "../../lib/colors";
import type { ToolRendererProps } from "../../lib/render-tool";
import { truncateText } from "../../lib/truncate";
import { ToolSpinner, toRelativePath } from "./shared";

function isToolPart(
  part: ReconstructedPart,
): part is ReconstructedPart & { type: string; toolCallId: string } {
  return part.type.startsWith("tool-");
}

function isTextPart(
  part: ReconstructedPart,
): part is ReconstructedPart & { type: "text"; text: string } {
  return part.type === "text";
}

function getToolSummary(part: ReconstructedPart, cwd: string): string {
  if (!isToolPart(part)) return "";
  const input = (part as { input?: Record<string, unknown> }).input;
  switch (part.type) {
    case "tool-read":
    case "tool-write":
    case "tool-edit":
      return input?.filePath
        ? toRelativePath(String(input.filePath), cwd)
        : "";
    case "tool-grep":
    case "tool-glob":
      return input?.pattern ? `"${input.pattern}"` : "";
    case "tool-bash":
      return input?.command ? String(input.command) : "";
    default:
      return "";
  }
}

function SubagentToolCall({ part }: { part: ReconstructedPart }) {
  const { state: chatState } = useChatContext();
  const cwd = chatState.workingDirectory ?? process.cwd();
  const { width } = useTerminalDimensions();
  if (!isToolPart(part)) return null;
  const toolPart = part as { state?: string };
  if (toolPart.state === "input-streaming") return null;
  const toolName = part.type.replace("tool-", "");
  const isRunning = toolPart.state === "input-available";
  const hasError = toolPart.state === "output-error";
  const summary = getToolSummary(part, cwd);
  const terminalWidth = width ?? 80;

  const dotColor = isRunning ? PRIMARY_COLOR : hasError ? "red" : "green";
  const displayName = toolName.charAt(0).toUpperCase() + toolName.slice(1);
  const errorSuffix = hasError ? " - error" : "";
  const prefixLength = 2 + 2 + displayName.length + 1;
  const suffixLength = 1 + errorSuffix.length;
  const maxSummaryWidth = Math.max(
    10,
    terminalWidth - prefixLength - suffixLength,
  );
  const displaySummary = summary ? truncateText(summary, maxSummaryWidth) : "";

  return (
    <box paddingLeft={1} flexDirection="row">
      <text fg="gray">│ </text>
      <box flexDirection="row">
        {isRunning ? <ToolSpinner /> : <text fg={dotColor}>● </text>}
        <text
          fg={isRunning ? PRIMARY_COLOR : "white"}
          attributes={TextAttributes.BOLD}
        >
          {displayName}
        </text>
        {displaySummary && (
          <>
            <text fg="gray">(</text>
            <text fg="white">{displaySummary}</text>
            <text fg="gray">)</text>
          </>
        )}
        {hasError && <text fg="red">{errorSuffix}</text>}
      </box>
    </box>
  );
}

export function TaskRenderer({ part, state }: ToolRendererProps<"tool-task">) {
  const isInputReady = part.state !== "input-streaming";
  const desc = isInputReady ? (part.input?.task ?? "Spawning subagent") : "...";
  const subagentType = isInputReady ? part.input?.subagentType : undefined;
  const taskApprovalRequested = part.state === "approval-requested";
  const taskDenied = part.state === "output-denied";
  const taskDenialReason = taskDenied ? part.approval?.reason : undefined;

  // The output is now a TaskToolStreamOutput with a buffer of SSE chunks
  const hasOutput = part.state === "output-available";
  const isPreliminary = hasOutput && part.preliminary === true;
  const streamOutput = hasOutput
    ? (part.output as TaskToolStreamOutput | undefined)
    : undefined;

  // Reconstruct the SubagentUIMessage from the SSE buffer
  const message: ReconstructedSubagentMessage | undefined = useMemo(
    () =>
      streamOutput?.buffer
        ? reconstructSubagentMessage(streamOutput.buffer)
        : undefined,
    [streamOutput?.buffer],
  );

  // Get all parts in order, filter to text and tool parts
  const messageParts = message?.parts ?? [];
  const relevantParts = messageParts.filter((p) => {
    if (isTextPart(p)) return true;
    if (!isToolPart(p)) return false;
    return (p as { state?: string }).state !== "input-streaming";
  });
  const toolParts = messageParts.filter(isToolPart);

  // Show only the last few parts to avoid too much output
  const maxVisible = 4;
  const hiddenCount = Math.max(0, relevantParts.length - maxVisible);
  const visibleParts = relevantParts.slice(-maxVisible);

  const isComplete = hasOutput && !isPreliminary;
  const isStreaming = hasOutput && isPreliminary;

  const dotColor = taskDenied
    ? "red"
    : taskApprovalRequested
      ? PRIMARY_COLOR
      : isStreaming
        ? PRIMARY_COLOR
        : isComplete
          ? "green"
          : PRIMARY_COLOR;
  const indicator = state.interrupted ? (
    <text fg={PRIMARY_COLOR}>○ </text>
  ) : state.running || isStreaming ? (
    <ToolSpinner />
  ) : (
    <text fg={dotColor}>● </text>
  );

  // Format subagent type for display
  const subagentLabel =
    subagentType === "explorer"
      ? "Explorer"
      : subagentType === "executor"
        ? "Executor"
        : "Task";
  const { width: taskWidth } = useTerminalDimensions();
  const taskTerminalWidth = taskWidth ?? 80;
  const taskPrefixLength = 2 + subagentLabel.length + 1;
  const taskSuffixLength = 1;
  const maxDescWidth = Math.max(
    10,
    taskTerminalWidth - taskPrefixLength - taskSuffixLength,
  );
  const displayDesc = truncateText(desc, maxDescWidth);
  const maxTextWidth = Math.max(10, taskTerminalWidth - 4);
  const errorPrefix = "Error: ";
  const maxErrorWidth = Math.max(
    10,
    taskTerminalWidth - 2 - errorPrefix.length,
  );

  return (
    <box flexDirection="column" marginTop={1} marginBottom={1}>
      {/* Header */}
      <box flexDirection="row">
        {indicator}
        <text
          fg={taskDenied ? "red" : "white"}
          attributes={TextAttributes.BOLD}
        >
          {subagentLabel}
        </text>
        <text fg="gray">(</text>
        <text fg="white">{displayDesc}</text>
        <text fg="gray">)</text>
      </box>

      {/* Executor approval warning */}
      {taskApprovalRequested && subagentType === "executor" && (
        <box paddingLeft={2} marginTop={1} flexDirection="row">
          <text fg={PRIMARY_COLOR}>
            This executor has full write access and can create, modify, and
            delete files.
          </text>
        </box>
      )}

      {/* Denied message */}
      {taskDenied && (
        <box paddingLeft={2} flexDirection="row">
          <text fg="gray">└ </text>
          <text fg="red">
            Denied{taskDenialReason ? `: ${taskDenialReason}` : ""}
          </text>
        </box>
      )}

      {/* Nested parts from subagent (text and tools in order) */}
      {hasOutput && visibleParts.length > 0 && !state.interrupted && (
        <box flexDirection="column" paddingLeft={2} marginTop={1}>
          {hiddenCount > 0 && (
            <box marginBottom={1} flexDirection="row">
              <text fg="gray">... {hiddenCount} more above</text>
            </box>
          )}
          {visibleParts.map((p, i) => {
            if (isToolPart(p)) {
              return (
                <SubagentToolCall
                  key={"toolCallId" in p ? p.toolCallId : i}
                  part={p}
                />
              );
            }
            if (isTextPart(p)) {
              // Show truncated text, dimmed
              const text = p.text.trim();
              if (!text) return null;
              const truncated = truncateText(text, maxTextWidth);
              return (
                <box key={`text-${i}`} paddingLeft={1} flexDirection="row">
                  <text fg="gray">│ </text>
                  <text fg="gray" attributes={TextAttributes.DIM}>
                    {truncated}
                  </text>
                </box>
              );
            }
            return null;
          })}
        </box>
      )}

      {/* Completion status */}
      {isComplete && !state.interrupted && (
        <box paddingLeft={2} flexDirection="row">
          <text fg="gray">└ </text>
          <text fg="white">
            Complete ({toolParts.length} tool calls
            {message?.metadata?.lastStepUsage?.inputTokens
              ? `, ${formatTokens(message.metadata.lastStepUsage.inputTokens)} tokens`
              : ""}
            )
          </text>
        </box>
      )}

      {state.error && (
        <box paddingLeft={2} flexDirection="row">
          <text fg="gray">└ </text>
          <text fg="red">
            {errorPrefix}
            {truncateText(state.error, maxErrorWidth)}
          </text>
        </box>
      )}

      {state.interrupted && (
        <box paddingLeft={2} flexDirection="row">
          <text fg="gray">└ </text>
          <text fg={PRIMARY_COLOR}>Interrupted</text>
        </box>
      )}
    </box>
  );
}

// Export SubagentToolCall for use in other places if needed
export { SubagentToolCall };
