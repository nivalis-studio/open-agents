import type { AgentModelSelection } from "@open-harness/agent";
import { isToolUIPart, type LanguageModelUsage } from "ai";
import type { WebAgentUIMessage } from "@/app/types";

export interface ChatWorkflowInput {
  userId: string;
  sessionId: string;
  chatId: string;
  messages: WebAgentUIMessage[];
  requestStartedAtMs: number;
  model: AgentModelSelection;
  subagentModel?: AgentModelSelection;
}

export const shouldPauseForToolInteraction = (
  parts: WebAgentUIMessage["parts"],
) =>
  parts.some(
    (part) =>
      isToolUIPart(part) &&
      (part.state === "input-available" || part.state === "approval-requested"),
  );

export function mergeLanguageModelUsage(
  current: LanguageModelUsage | undefined,
  next: LanguageModelUsage | undefined,
): LanguageModelUsage | undefined {
  if (!current) {
    return next;
  }

  if (!next) {
    return current;
  }

  return {
    inputTokens: (current.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (current.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0),
    reasoningTokens:
      (current.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
    cachedInputTokens:
      (current.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
    inputTokenDetails: {
      noCacheTokens:
        (current.inputTokenDetails?.noCacheTokens ?? 0) +
        (next.inputTokenDetails?.noCacheTokens ?? 0),
      cacheReadTokens:
        (current.inputTokenDetails?.cacheReadTokens ?? 0) +
        (next.inputTokenDetails?.cacheReadTokens ?? 0),
      cacheWriteTokens:
        (current.inputTokenDetails?.cacheWriteTokens ?? 0) +
        (next.inputTokenDetails?.cacheWriteTokens ?? 0),
    },
    outputTokenDetails: {
      textTokens:
        (current.outputTokenDetails?.textTokens ?? 0) +
        (next.outputTokenDetails?.textTokens ?? 0),
      reasoningTokens:
        (current.outputTokenDetails?.reasoningTokens ?? 0) +
        (next.outputTokenDetails?.reasoningTokens ?? 0),
    },
  };
}

export function getErrorText(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected error occurred.";
}
