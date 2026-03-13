import type { WebAgentMessageMetadata } from "@/app/types";
import { getWorkflowMetadata } from "workflow";
import {
  attachMessageMetadata,
  createActiveStreamToken,
  isAbortError,
  type ChatWorkflowInput,
  type ChatWorkflowResult,
} from "./chat-types";
import {
  clearWorkflowOwnership,
  closeWorkflowStream,
  persistWorkflowCompletion,
  prepareWorkflowRuntime,
  runChatAgentStep,
  writeWorkflowError,
  writeWorkflowFinish,
} from "./chat-step-helpers";

export type { ChatWorkflowInput, ChatWorkflowResult } from "./chat-types";

export async function chatWorkflow(input: ChatWorkflowInput) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const streamToken = createActiveStreamToken(
    input.requestStartedAtMs,
    workflowRunId,
  );

  const { runtimeContext, sandboxState } = await prepareWorkflowRuntime(input);

  try {
    const agentResult = await runChatAgentStep({
      messages: input.messages,
      runtimeContext,
    });

    const metadata: WebAgentMessageMetadata = {
      ...(agentResult.lastStepUsage
        ? { lastStepUsage: agentResult.lastStepUsage }
        : {}),
      ...(agentResult.totalMessageUsage
        ? { totalMessageUsage: agentResult.totalMessageUsage }
        : {}),
    };

    const assistantMessage = attachMessageMetadata(
      agentResult.assistantMessage,
      metadata,
    );

    const persistence = await persistWorkflowCompletion({
      workflow: input,
      streamToken,
      runtimeContext,
      sandboxState,
      assistantMessage,
      mainUsage: agentResult.totalMessageUsage,
    });

    await writeWorkflowFinish({
      finishReason: agentResult.finishReason,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });

    return {
      persisted: persistence.persisted,
      naturalFinish: true,
      autoCommitEligible: persistence.persisted,
    } satisfies ChatWorkflowResult;
  } catch (error) {
    await clearWorkflowOwnership(input, streamToken).catch(() => {});

    if (isAbortError(error)) {
      await closeWorkflowStream().catch(() => {});
      return {
        persisted: false,
        naturalFinish: false,
        autoCommitEligible: false,
      } satisfies ChatWorkflowResult;
    }

    const message = error instanceof Error ? error.message : String(error);
    await writeWorkflowError(message).catch(() => {});
    throw error;
  }
}
