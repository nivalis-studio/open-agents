import type {
  ApprovalConfig,
  ModelDescriptor,
  SerializableRuntimeContext,
  SkillMetadata,
} from "@open-harness/agent";
import type { FinishReason, LanguageModelUsage, ModelMessage } from "ai";
import type { SandboxState } from "@open-harness/sandbox";
import type { WebAgentMessageMetadata, WebAgentUIMessage } from "@/app/types";

export const STREAM_TOKEN_SEPARATOR = ":";

export const cachedInputTokensFor = (usage: LanguageModelUsage) =>
  usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens ?? 0;

export function createActiveStreamToken(
  startedAtMs: number,
  runId: string,
): string {
  return `${startedAtMs}${STREAM_TOKEN_SEPARATOR}${runId}`;
}

export function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

export function attachMessageMetadata(
  message: WebAgentUIMessage | undefined,
  metadata: WebAgentMessageMetadata,
): WebAgentUIMessage | undefined {
  if (!message) {
    return undefined;
  }

  return {
    ...message,
    metadata,
  };
}

export interface ChatWorkflowInput {
  userId: string;
  sessionId: string;
  chatId: string;
  sandboxState: SandboxState;
  messages: ModelMessage[];
  model: ModelDescriptor;
  subagentModel?: ModelDescriptor;
  approval: ApprovalConfig;
  customInstructions?: string;
  context?: SerializableRuntimeContext["context"];
  repoOwner?: string | null;
  repoName?: string | null;
  requestStartedAtMs: number;
}

export interface ChatWorkflowResult {
  persisted: boolean;
  naturalFinish: boolean;
  autoCommitEligible: boolean;
}

export interface PreparedWorkflowRuntime {
  runtimeContext: SerializableRuntimeContext;
  sandboxState: SandboxState;
}

export interface RunChatAgentResult {
  assistantMessage?: WebAgentUIMessage;
  lastStepUsage?: LanguageModelUsage;
  totalMessageUsage?: LanguageModelUsage;
  finishReason?: FinishReason;
}

export type { SkillMetadata };
