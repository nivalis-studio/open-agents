import type { AgentModelSelection } from "@open-harness/agent";
import type { SandboxState } from "@open-harness/sandbox";
import {
  convertToModelMessages,
  generateId as generateAiId,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type UIMessageChunk,
} from "ai";
import { getWritable } from "workflow";
import { claimStreamOwnership } from "@/app/api/chat/_lib/stream-lifecycle";
import type { WebAgentMessageMetadata, WebAgentUIMessage } from "@/app/types";
import { mergeLanguageModelUsage } from "./chat-shared";
import {
  compareAndSetChatActiveStreamId,
  getChatById,
  getSessionById,
  updateChatAssistantActivity,
  updateSession,
  upsertChatMessageScoped,
} from "@/lib/db/sessions";
import { recordUsage } from "@/lib/db/usage";
import { buildActiveLifecycleUpdate } from "@/lib/sandbox/lifecycle";

const cachedInputTokensFor = (usage: LanguageModelUsage) =>
  usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens ?? 0;

export async function convertMessages(
  messages: WebAgentUIMessage[],
): Promise<ModelMessage[]> {
  "use step";

  const { webAgent } = await import("@/app/config");

  return convertToModelMessages(messages, {
    ignoreIncompleteToolCalls: true,
    tools: webAgent.tools,
  });
}

export async function generateMessageId(): Promise<string> {
  "use step";
  return generateAiId();
}

export async function ensureChatStreamOwnership(
  chatId: string,
  ownedStreamToken: string,
  requestStartedAtMs: number,
): Promise<boolean> {
  "use step";

  return claimStreamOwnership({
    chatId,
    ownedStreamToken,
    requestStartedAtMs,
  });
}

export async function hasChatStreamOwnership(
  chatId: string,
  ownedStreamToken: string,
): Promise<boolean> {
  "use step";

  const chat = await getChatById(chatId);
  return chat?.activeStreamId === ownedStreamToken;
}

type ActiveSessionRecord = NonNullable<
  Awaited<ReturnType<typeof getSessionById>>
> & {
  sandboxState: NonNullable<
    NonNullable<Awaited<ReturnType<typeof getSessionById>>>["sandboxState"]
  >;
};

async function resolveGitHubToken(
  userId: string,
  sessionRecord: ActiveSessionRecord,
): Promise<string | null> {
  const [{ getRepoToken }, { getUserGitHubToken }] = await Promise.all([
    import("@/lib/github/get-repo-token"),
    import("@/lib/github/user-token"),
  ]);

  if (sessionRecord.repoOwner) {
    try {
      const tokenResult = await getRepoToken(userId, sessionRecord.repoOwner);
      return tokenResult.token;
    } catch {
      return getUserGitHubToken();
    }
  }

  return getUserGitHubToken();
}

async function createWorkflowChatRuntime(params: {
  userId: string;
  sessionRecord: ActiveSessionRecord;
}) {
  const [{ discoverSkills }, { connectSandbox }, { DEFAULT_SANDBOX_PORTS }] =
    await Promise.all([
      import("@open-harness/agent"),
      import("@open-harness/sandbox"),
      import("@/lib/sandbox/config"),
    ]);

  const githubToken = await resolveGitHubToken(
    params.userId,
    params.sessionRecord,
  );
  const sandbox = await connectSandbox(params.sessionRecord.sandboxState, {
    env: githubToken ? { GITHUB_TOKEN: githubToken } : undefined,
    ports: DEFAULT_SANDBOX_PORTS,
  });

  if (
    githubToken &&
    params.sessionRecord.repoOwner &&
    params.sessionRecord.repoName
  ) {
    const authUrl = `https://x-access-token:${githubToken}@github.com/${params.sessionRecord.repoOwner}/${params.sessionRecord.repoName}.git`;
    const remoteResult = await sandbox.exec(
      `git remote set-url origin "${authUrl}"`,
      sandbox.workingDirectory,
      5000,
    );

    if (!remoteResult.success) {
      console.warn(
        `Failed to refresh git remote auth for session ${params.sessionRecord.id}: ${remoteResult.stderr ?? remoteResult.stdout}`,
      );
    }
  }

  const skillDirs = [".claude", ".agents"].map(
    (folder) => `${sandbox.workingDirectory}/${folder}/skills`,
  );
  const skills = await discoverSkills(sandbox, skillDirs);

  return {
    sandbox,
    skills,
  };
}

export interface ChatAgentStepResult {
  responseMessage: WebAgentUIMessage;
  responseMessages: ModelMessage[];
  finishReason: FinishReason;
  usage: LanguageModelUsage;
  sandboxState: SandboxState | undefined;
}

export async function runChatAgentStep(params: {
  userId: string;
  sessionId: string;
  model: AgentModelSelection;
  subagentModel?: AgentModelSelection;
  messages: ModelMessage[];
  originalMessages: WebAgentUIMessage[];
  assistantId: string;
}): Promise<ChatAgentStepResult> {
  "use step";

  const sessionRecord = await getSessionById(params.sessionId);
  if (!sessionRecord?.sandboxState) {
    throw new Error("Sandbox state is required to continue chat workflow");
  }

  const activeSessionRecord: ActiveSessionRecord = {
    ...sessionRecord,
    sandboxState: sessionRecord.sandboxState,
  };

  const [{ webAgent }, { sandbox, skills }] = await Promise.all([
    import("@/app/config"),
    createWorkflowChatRuntime({
      userId: params.userId,
      sessionRecord: activeSessionRecord,
    }),
  ]);

  let responseMessage: WebAgentUIMessage | undefined;
  const writable = getWritable<UIMessageChunk<WebAgentMessageMetadata>>();
  const writer = writable.getWriter();

  try {
    const result = await webAgent.stream({
      messages: params.messages,
      options: {
        sandbox: {
          state: sessionRecord.sandboxState,
          workingDirectory: sandbox.workingDirectory,
          currentBranch: sandbox.currentBranch,
          environmentDetails: sandbox.environmentDetails,
        },
        model: params.model,
        ...(params.subagentModel
          ? {
              subagentModel: params.subagentModel,
            }
          : {}),
        ...(skills.length > 0 ? { skills } : {}),
      },
    });

    for await (const part of result.toUIMessageStream<WebAgentUIMessage>({
      originalMessages: params.originalMessages,
      generateMessageId: () => params.assistantId,
      sendStart: false,
      sendFinish: false,
      messageMetadata: ({ part }) => {
        if (part.type === "finish-step") {
          return { lastStepUsage: part.usage };
        }

        return undefined;
      },
      onFinish: ({ responseMessage: finishedResponseMessage }) => {
        responseMessage = finishedResponseMessage;
      },
    })) {
      await writer.write(part);
    }

    if (!responseMessage) {
      throw new Error("Agent stream finished without a response message");
    }

    return {
      responseMessage,
      responseMessages: (await result.response).messages,
      finishReason: await result.finishReason,
      usage: await result.usage,
      sandboxState: sandbox.getState?.() as SandboxState | undefined,
    };
  } finally {
    writer.releaseLock();
  }
}

export async function sendStart(messageId: string): Promise<void> {
  "use step";

  const writer =
    getWritable<UIMessageChunk<WebAgentMessageMetadata>>().getWriter();
  try {
    await writer.write({ type: "start", messageId });
  } finally {
    writer.releaseLock();
  }
}

export async function sendError(errorText: string): Promise<void> {
  "use step";

  const writer =
    getWritable<UIMessageChunk<WebAgentMessageMetadata>>().getWriter();
  try {
    await writer.write({ type: "error", errorText });
  } finally {
    writer.releaseLock();
  }
}

export async function sendFinish(
  finishReason: FinishReason,
  metadata: WebAgentMessageMetadata,
): Promise<void> {
  "use step";

  const writable = getWritable<UIMessageChunk<WebAgentMessageMetadata>>();
  const writer = writable.getWriter();

  try {
    await writer.write({
      type: "finish",
      finishReason,
      messageMetadata: metadata,
    });
  } catch (error) {
    if (
      !(error instanceof TypeError) ||
      !String(error.message).includes("WritableStream is closed")
    ) {
      throw error;
    }
  } finally {
    writer.releaseLock();
  }

  try {
    await writable.close();
  } catch (error) {
    if (
      !(error instanceof TypeError) ||
      !String(error.message).includes("WritableStream is closed")
    ) {
      throw error;
    }
  }
}

export async function clearChatActiveStreamIfOwned(
  chatId: string,
  ownedStreamToken: string,
): Promise<boolean> {
  "use step";

  try {
    return await compareAndSetChatActiveStreamId(
      chatId,
      ownedStreamToken,
      null,
    );
  } catch (error) {
    console.error("Failed to clear active chat stream:", error);
    return false;
  }
}

export async function finalizeChatWorkflowRun(params: {
  userId: string;
  sessionId: string;
  chatId: string;
  ownedStreamToken: string;
  responseMessage: WebAgentUIMessage;
  sandboxState: SandboxState | undefined;
  modelId: string;
  totalMessageUsage: LanguageModelUsage | undefined;
}): Promise<void> {
  "use step";

  const stillOwnsStream = await clearChatActiveStreamIfOwned(
    params.chatId,
    params.ownedStreamToken,
  );
  if (!stillOwnsStream) {
    return;
  }

  const activityAt = new Date();

  try {
    const upsertResult = await upsertChatMessageScoped({
      id: params.responseMessage.id,
      chatId: params.chatId,
      role: "assistant",
      parts: params.responseMessage,
    });

    if (upsertResult.status === "conflict") {
      console.warn(
        `Skipped assistant message upsert due to ID scope conflict: ${params.responseMessage.id}`,
      );
    } else if (upsertResult.status === "inserted") {
      await updateChatAssistantActivity(params.chatId, activityAt);
    }
  } catch (error) {
    console.error("Failed to save assistant message:", error);
  }

  const currentSession = await getSessionById(params.sessionId);
  const persistedSandboxState =
    params.sandboxState ?? currentSession?.sandboxState;

  if (persistedSandboxState) {
    try {
      await updateSession(params.sessionId, {
        sandboxState: params.sandboxState ?? persistedSandboxState,
        ...buildActiveLifecycleUpdate(persistedSandboxState, {
          activityAt,
        }),
      });
    } catch (error) {
      console.error("Failed to persist sandbox state:", error);
    }
  }

  const usageWrites: Promise<void>[] = [];

  if (params.totalMessageUsage) {
    usageWrites.push(
      recordUsage(params.userId, {
        source: "web",
        agentType: "main",
        model: params.modelId,
        messages: [params.responseMessage],
        usage: {
          inputTokens: params.totalMessageUsage.inputTokens ?? 0,
          cachedInputTokens: cachedInputTokensFor(params.totalMessageUsage),
          outputTokens: params.totalMessageUsage.outputTokens ?? 0,
        },
      }).catch((error) => {
        console.error("Failed to record main agent usage:", error);
      }),
    );
  }

  const { collectTaskToolUsageEvents } = await import("@open-harness/agent");
  const subagentUsageEvents = collectTaskToolUsageEvents(
    params.responseMessage,
  );
  if (subagentUsageEvents.length > 0) {
    const subagentUsageByModel = new Map<string, LanguageModelUsage>();

    for (const event of subagentUsageEvents) {
      const eventModelId = event.modelId ?? params.modelId;
      if (!eventModelId) {
        continue;
      }

      const combinedUsage = mergeLanguageModelUsage(
        subagentUsageByModel.get(eventModelId),
        event.usage,
      );
      if (combinedUsage) {
        subagentUsageByModel.set(eventModelId, combinedUsage);
      }
    }

    for (const [eventModelId, usage] of subagentUsageByModel) {
      usageWrites.push(
        recordUsage(params.userId, {
          source: "web",
          agentType: "subagent",
          model: eventModelId,
          messages: [],
          usage: {
            inputTokens: usage.inputTokens ?? 0,
            cachedInputTokens: cachedInputTokensFor(usage),
            outputTokens: usage.outputTokens ?? 0,
          },
        }).catch((error) => {
          console.error("Failed to record subagent usage:", error);
        }),
      );
    }
  }

  await Promise.all(usageWrites);
}
