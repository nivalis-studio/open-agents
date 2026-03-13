import { getWritable } from "workflow";
import type { LanguageModelUsage, UIMessageChunk } from "ai";
import type { WebAgentMessageMetadata } from "@/app/types";
import {
  attachMessageMetadata,
  cachedInputTokensFor,
  type ChatWorkflowInput,
  type PreparedWorkflowRuntime,
  type RunChatAgentResult,
  type SkillMetadata,
} from "./chat-types";

export async function prepareWorkflowRuntime(
  input: ChatWorkflowInput,
): Promise<PreparedWorkflowRuntime> {
  "use step";

  const [
    { getRepoToken },
    { getUserGitHubToken },
    sandboxModule,
    agentModule,
    skillsCacheModule,
    sandboxConfigModule,
  ] = await Promise.all([
    import("@/lib/github/get-repo-token"),
    import("@/lib/github/user-token"),
    import("@open-harness/sandbox"),
    import("@open-harness/agent"),
    import("@/lib/skills-cache"),
    import("@/lib/sandbox/config"),
  ]);

  let githubToken: string | null = null;
  if (input.repoOwner) {
    try {
      const tokenResult = await getRepoToken(input.userId, input.repoOwner);
      githubToken = tokenResult.token;
    } catch {
      githubToken = await getUserGitHubToken();
    }
  } else {
    githubToken = await getUserGitHubToken();
  }

  const sandbox = await sandboxModule.connectSandbox(input.sandboxState, {
    env: githubToken ? { GITHUB_TOKEN: githubToken } : undefined,
    ports: sandboxConfigModule.DEFAULT_SANDBOX_PORTS,
  });

  if (githubToken && input.repoOwner && input.repoName) {
    const authUrl = `https://x-access-token:${githubToken}@github.com/${input.repoOwner}/${input.repoName}.git`;
    const remoteResult = await sandbox.exec(
      `git remote set-url origin "${authUrl}"`,
      sandbox.workingDirectory,
      5000,
    );

    if (!remoteResult.success) {
      console.warn(
        `Failed to refresh git remote auth for session ${input.sessionId}: ${remoteResult.stderr ?? remoteResult.stdout}`,
      );
    }
  }

  const latestSandboxState =
    (sandbox.getState?.() as typeof input.sandboxState | undefined) ??
    input.sandboxState;

  const skillBaseFolders = [".claude", ".agents"];
  const skillDirs = skillBaseFolders.map(
    (folder) => `${sandbox.workingDirectory}/${folder}/skills`,
  );

  const cachedSkills = await skillsCacheModule.getCachedSkills(
    input.sessionId,
    input.sandboxState,
  );
  let skills: SkillMetadata[];
  if (cachedSkills !== null) {
    skills = cachedSkills;
  } else {
    skills = await agentModule.discoverSkills(sandbox, skillDirs);
    await skillsCacheModule.setCachedSkills(
      input.sessionId,
      latestSandboxState,
      skills,
    );
  }

  if (latestSandboxState.type !== "vercel" || !latestSandboxState.sandboxId) {
    throw new Error("Workflow chat requires a reconnectable Vercel sandbox.");
  }

  return {
    sandboxState: latestSandboxState,
    runtimeContext: {
      sandboxId: latestSandboxState.sandboxId,
      sandboxType: "vercel",
      workingDirectory: sandbox.workingDirectory,
      currentBranch: sandbox.currentBranch,
      environmentDetails: sandbox.environmentDetails,
      host: sandbox.host,
      expiresAt: sandbox.expiresAt,
      timeout: sandbox.timeout,
      approval: input.approval,
      model: input.model,
      ...(input.subagentModel ? { subagentModel: input.subagentModel } : {}),
      ...(input.customInstructions
        ? { customInstructions: input.customInstructions }
        : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(skills.length > 0 ? { skills } : {}),
    },
  };
}

export async function runChatAgentStep(input: {
  messages: ChatWorkflowInput["messages"];
  runtimeContext: PreparedWorkflowRuntime["runtimeContext"];
}): Promise<RunChatAgentResult> {
  "use step";

  const agentModule = await import("@open-harness/agent");
  const agent = agentModule.createOpenHarnessDurableAgent(input.runtimeContext);

  let lastStepUsage: LanguageModelUsage | undefined;
  let totalMessageUsage: LanguageModelUsage | undefined;

  const result = await agent.stream({
    messages: input.messages,
    writable: getWritable<UIMessageChunk<WebAgentMessageMetadata>>(),
    preventClose: true,
    sendFinish: false,
    collectUIMessages: true,
    onStepFinish: ({ usage }) => {
      lastStepUsage = usage;
      totalMessageUsage = agentModule.sumLanguageModelUsage(
        totalMessageUsage,
        usage,
      );
    },
  });

  const metadata: WebAgentMessageMetadata = {
    ...(lastStepUsage ? { lastStepUsage } : {}),
    ...(totalMessageUsage ? { totalMessageUsage } : {}),
  };

  const assistantMessage = attachMessageMetadata(
    result.uiMessages?.findLast((message) => message.role === "assistant") as
      | RunChatAgentResult["assistantMessage"]
      | undefined,
    metadata,
  );

  return {
    assistantMessage,
    lastStepUsage,
    totalMessageUsage,
    finishReason: result.steps.at(-1)?.finishReason,
  };
}

export async function writeWorkflowFinish(options: {
  finishReason?: RunChatAgentResult["finishReason"];
  metadata?: WebAgentMessageMetadata;
}) {
  "use step";

  const writable = getWritable<UIMessageChunk<WebAgentMessageMetadata>>();
  const writer = writable.getWriter();
  try {
    await writer.write({
      type: "finish",
      ...(options.finishReason ? { finishReason: options.finishReason } : {}),
      ...(options.metadata ? { messageMetadata: options.metadata } : {}),
    });
  } finally {
    writer.releaseLock();
  }

  await writable.close();
}

export async function writeWorkflowError(errorText: string) {
  "use step";

  const writable = getWritable<UIMessageChunk<WebAgentMessageMetadata>>();
  const writer = writable.getWriter();
  try {
    await writer.write({ type: "error", errorText });
  } finally {
    writer.releaseLock();
  }

  await writable.close();
}

export async function closeWorkflowStream() {
  "use step";
  await getWritable<UIMessageChunk<WebAgentMessageMetadata>>().close();
}

export async function persistWorkflowCompletion(input: {
  workflow: ChatWorkflowInput;
  streamToken: string;
  runtimeContext: PreparedWorkflowRuntime["runtimeContext"];
  sandboxState: PreparedWorkflowRuntime["sandboxState"];
  assistantMessage?: RunChatAgentResult["assistantMessage"];
  mainUsage?: RunChatAgentResult["totalMessageUsage"];
}): Promise<{ persisted: boolean }> {
  "use step";

  const [
    dbSessionsModule,
    usageModule,
    sandboxModule,
    sandboxLifecycleModule,
    agentModule,
  ] = await Promise.all([
    import("@/lib/db/sessions"),
    import("@/lib/db/usage"),
    import("@open-harness/sandbox"),
    import("@/lib/sandbox/lifecycle"),
    import("@open-harness/agent"),
  ]);

  const stillOwnsStream =
    await dbSessionsModule.compareAndSetChatActiveStreamId(
      input.workflow.chatId,
      input.streamToken,
      null,
    );

  if (!stillOwnsStream) {
    return { persisted: false };
  }

  const activityAt = new Date();

  if (input.assistantMessage) {
    try {
      const upsertResult = await dbSessionsModule.upsertChatMessageScoped({
        id: input.assistantMessage.id,
        chatId: input.workflow.chatId,
        role: "assistant",
        parts: input.assistantMessage,
      });
      if (upsertResult.status === "conflict") {
        console.warn(
          `Skipped assistant message upsert due to ID scope conflict: ${input.assistantMessage.id}`,
        );
      } else if (upsertResult.status === "inserted") {
        await dbSessionsModule.updateChatAssistantActivity(
          input.workflow.chatId,
          activityAt,
        );
      }
    } catch (error) {
      console.error("Failed to save assistant message:", error);
    }
  }

  let sandboxState = input.sandboxState;
  try {
    const sandbox = await sandboxModule.connectSandbox({
      type: "vercel",
      sandboxId: input.runtimeContext.sandboxId,
      ...(input.runtimeContext.expiresAt !== undefined
        ? { expiresAt: input.runtimeContext.expiresAt }
        : {}),
    });
    sandboxState =
      (sandbox.getState?.() as typeof input.sandboxState | undefined) ??
      sandboxState;
  } catch (error) {
    console.error("Failed to refresh sandbox state:", error);
  }

  try {
    await dbSessionsModule.updateSession(input.workflow.sessionId, {
      sandboxState,
      ...sandboxLifecycleModule.buildActiveLifecycleUpdate(sandboxState, {
        activityAt,
      }),
    });
  } catch (error) {
    console.error("Failed to persist sandbox state:", error);
    try {
      await dbSessionsModule.updateSession(input.workflow.sessionId, {
        ...sandboxLifecycleModule.buildActiveLifecycleUpdate(
          input.workflow.sandboxState,
          {
            activityAt,
          },
        ),
      });
    } catch (activityError) {
      console.error("Failed to persist lifecycle activity:", activityError);
    }
  }

  const postUsage = async (
    usage: LanguageModelUsage,
    usageModel: string,
    agentType: "main" | "subagent",
    messages: NonNullable<RunChatAgentResult["assistantMessage"]>[] = [],
  ) => {
    await usageModule.recordUsage(input.workflow.userId, {
      source: "web",
      agentType,
      model: usageModel,
      messages,
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        cachedInputTokens: cachedInputTokensFor(usage),
        outputTokens: usage.outputTokens ?? 0,
      },
    });
  };

  if (input.mainUsage && input.assistantMessage) {
    await postUsage(
      input.mainUsage,
      input.runtimeContext.model.modelId,
      "main",
      [input.assistantMessage],
    );
  }

  if (input.assistantMessage) {
    const subagentUsageEvents = agentModule.collectTaskToolUsageEvents(
      input.assistantMessage,
    );
    const subagentUsageByModel = new Map<string, LanguageModelUsage>();
    for (const event of subagentUsageEvents) {
      const eventModelId = event.modelId ?? input.runtimeContext.model.modelId;
      const existing = subagentUsageByModel.get(eventModelId);
      const combined = agentModule.sumLanguageModelUsage(existing, event.usage);
      if (combined) {
        subagentUsageByModel.set(eventModelId, combined);
      }
    }

    for (const [eventModelId, usage] of subagentUsageByModel) {
      await postUsage(usage, eventModelId, "subagent");
    }
  }

  return { persisted: true };
}

export async function clearWorkflowOwnership(
  workflow: ChatWorkflowInput,
  streamToken: string,
) {
  "use step";
  const dbSessionsModule = await import("@/lib/db/sessions");
  await dbSessionsModule.compareAndSetChatActiveStreamId(
    workflow.chatId,
    streamToken,
    null,
  );
}
