import { after } from "next/server";
import {
  createModelDescriptor,
  openHarnessTools,
  type ModelDescriptor,
} from "@open-harness/agent";
import { convertToModelMessages, createUIMessageStreamResponse } from "ai";
import { start } from "workflow/api";
import { type WebAgentUIMessage } from "@/app/types";
import { WEB_AGENT_APPROVAL } from "@/app/config";
import { chatWorkflow, type ChatWorkflowResult } from "@/app/workflows/chat";
import {
  compareAndSetChatActiveStreamId,
  createChatMessageIfNotExists,
  getChatById,
  getSessionById,
  isFirstChatMessage,
  touchChat,
  updateChat,
  updateSession,
} from "@/lib/db/sessions";
import { getUserPreferences } from "@/lib/db/user-preferences";
import { runAutoCommitInBackground } from "@/lib/chat-auto-commit";
import { resolveModelSelection } from "@/lib/model-variants";
import { DEFAULT_MODEL_ID } from "@/lib/models";
import { buildActiveLifecycleUpdate } from "@/lib/sandbox/lifecycle";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";

const DEFAULT_CONTEXT_LIMIT = 200_000;
const STREAM_TOKEN_SEPARATOR = ":";

interface ChatCompactionContextPayload {
  contextLimit?: number;
  lastInputTokens?: number;
}

interface ChatRequestBody {
  messages: WebAgentUIMessage[];
  sessionId?: string;
  chatId?: string;
  context?: ChatCompactionContextPayload;
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function toPositiveInputTokens(value: unknown): number | undefined {
  const normalized = toPositiveInteger(value);
  return normalized && normalized > 0 ? normalized : undefined;
}

function extractLastInputTokensFromMessages(
  messages: WebAgentUIMessage[],
): number | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }

    const metadata = (message as { metadata?: unknown }).metadata;
    if (!metadata || typeof metadata !== "object") {
      continue;
    }

    const lastStepUsage = (metadata as { lastStepUsage?: unknown })
      .lastStepUsage;
    if (!lastStepUsage || typeof lastStepUsage !== "object") {
      continue;
    }

    const inputTokens = (lastStepUsage as { inputTokens?: unknown })
      .inputTokens;
    const normalizedTokens = toPositiveInputTokens(inputTokens);
    if (normalizedTokens) {
      return normalizedTokens;
    }
  }

  return undefined;
}

function createActiveStreamToken(startedAtMs: number, runId: string): string {
  return `${startedAtMs}${STREAM_TOKEN_SEPARATOR}${runId}`;
}

function parseActiveStreamToken(token: string | null): {
  startedAt: number;
  runId: string;
} | null {
  if (!token) {
    return null;
  }

  const separatorIndex = token.indexOf(STREAM_TOKEN_SEPARATOR);
  if (separatorIndex <= 0) {
    return null;
  }

  const startedAt = Number(token.slice(0, separatorIndex));
  if (!Number.isFinite(startedAt)) {
    return null;
  }

  const runId = token.slice(separatorIndex + 1);
  if (!runId) {
    return null;
  }

  return { startedAt, runId };
}

async function claimStreamOwnership(
  chatId: string,
  token: string,
  requestStartedAtMs: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const latestChat = await getChatById(chatId);
    const activeStream = parseActiveStreamToken(
      latestChat?.activeStreamId ?? null,
    );

    if (
      activeStream &&
      activeStream.startedAt > requestStartedAtMs &&
      latestChat?.activeStreamId !== token
    ) {
      return false;
    }

    const claimed = await compareAndSetChatActiveStreamId(
      chatId,
      latestChat?.activeStreamId ?? null,
      token,
    );
    if (claimed) {
      return true;
    }
  }

  return false;
}

function refreshCachedDiffInBackground(req: Request, sessionId: string): void {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) {
    return;
  }

  const diffUrl = new URL(`/api/sessions/${sessionId}/diff`, req.url);
  after(
    fetch(diffUrl, {
      method: "GET",
      headers: {
        cookie: cookieHeader,
      },
      cache: "no-store",
    })
      .then((response) => {
        if (response.ok) {
          return;
        }
        console.warn(
          `[chat] Failed to refresh cached diff for session ${sessionId}: ${response.status}`,
        );
      })
      .catch((error) => {
        console.error(
          `[chat] Failed to refresh cached diff for session ${sessionId}:`,
          error,
        );
      }),
  );
}

function scheduleAutoCommitInBackground(
  req: Request,
  params: {
    sessionId: string;
    sessionTitle: string;
    repoOwner: string;
    repoName: string;
  },
): void {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) {
    return;
  }

  after(
    runAutoCommitInBackground({
      requestUrl: req.url,
      cookieHeader,
      ...params,
    }).catch((error) => {
      console.error(
        `[chat] Auto commit background task failed for session ${params.sessionId}:`,
        error,
      );
    }),
  );
}

function createWorkflowModelDescriptor(options: {
  selectedModelId: string;
  fallbackModelId: string;
  providerOptionsByProvider?: NonNullable<
    ReturnType<typeof resolveModelSelection>["providerOptionsByProvider"]
  >;
  isMissingVariant: boolean;
}): ModelDescriptor {
  return createModelDescriptor(
    options.isMissingVariant
      ? options.fallbackModelId
      : options.selectedModelId,
    options.isMissingVariant || !options.providerOptionsByProvider
      ? {}
      : {
          providerOptionsOverrides: options.providerOptionsByProvider,
        },
  );
}

export const maxDuration = 800;

export async function POST(req: Request) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    messages,
    sessionId,
    chatId,
    context: requestedCompactionContext,
  } = body;

  if (!sessionId || !chatId) {
    return Response.json(
      { error: "sessionId and chatId are required" },
      { status: 400 },
    );
  }

  const [sessionRecord, chat] = await Promise.all([
    getSessionById(sessionId),
    getChatById(chatId),
  ]);

  if (!sessionRecord) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  if (sessionRecord.userId !== session.user.id) {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }
  if (!chat || chat.sessionId !== sessionId) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }
  if (!isSandboxActive(sessionRecord.sandboxState)) {
    return Response.json({ error: "Sandbox not initialized" }, { status: 400 });
  }

  const requestStartedAt = new Date();
  const requestStartedAtMs = requestStartedAt.getTime();
  await updateSession(sessionId, {
    ...buildActiveLifecycleUpdate(sessionRecord.sandboxState, {
      activityAt: requestStartedAt,
    }),
  });

  if (messages.length > 0) {
    const latestMessage = messages[messages.length - 1];
    if (
      latestMessage &&
      latestMessage.role === "user" &&
      typeof latestMessage.id === "string" &&
      latestMessage.id.length > 0
    ) {
      try {
        const createdUserMessage = await createChatMessageIfNotExists({
          id: latestMessage.id,
          chatId,
          role: "user",
          parts: latestMessage,
        });

        if (createdUserMessage) {
          await touchChat(chatId);
        }

        const shouldSetTitle =
          createdUserMessage !== undefined &&
          (await isFirstChatMessage(chatId, createdUserMessage.id));

        if (shouldSetTitle) {
          const textContent = latestMessage.parts
            .filter(
              (part): part is { type: "text"; text: string } =>
                part.type === "text",
            )
            .map((part) => part.text)
            .join(" ")
            .trim();

          if (textContent.length > 0) {
            const title =
              textContent.length > 30
                ? `${textContent.slice(0, 30)}...`
                : textContent;
            await updateChat(chatId, { title });
          }
        }
      } catch (error) {
        console.error("Failed to save latest chat message:", error);
      }
    }
  }

  const preferences = await getUserPreferences(session.user.id).catch(
    (error) => {
      console.error("Failed to load user preferences:", error);
      return null;
    },
  );
  const modelVariants = preferences?.modelVariants ?? [];

  const selectedModelId = chat.modelId ?? DEFAULT_MODEL_ID;
  const mainSelection = resolveModelSelection(selectedModelId, modelVariants);
  if (mainSelection.isMissingVariant) {
    console.warn(
      `Selected model variant "${selectedModelId}" was not found. Falling back to default model.`,
    );
  }

  const mainResolvedModelId = mainSelection.isMissingVariant
    ? DEFAULT_MODEL_ID
    : mainSelection.resolvedModelId;

  let subagentModel: ModelDescriptor | undefined;
  if (preferences?.defaultSubagentModelId) {
    const subagentSelection = resolveModelSelection(
      preferences.defaultSubagentModelId,
      modelVariants,
    );

    if (subagentSelection.isMissingVariant) {
      console.warn(
        `Subagent model variant "${preferences.defaultSubagentModelId}" was not found. Falling back to default model.`,
      );
    }

    const subagentResolvedModelId = subagentSelection.isMissingVariant
      ? DEFAULT_MODEL_ID
      : subagentSelection.resolvedModelId;

    subagentModel = createWorkflowModelDescriptor({
      selectedModelId: subagentResolvedModelId,
      fallbackModelId: DEFAULT_MODEL_ID,
      providerOptionsByProvider: subagentSelection.providerOptionsByProvider,
      isMissingVariant: subagentSelection.isMissingVariant,
    });
  }

  const requestedContextLimit = toPositiveInteger(
    requestedCompactionContext?.contextLimit,
  );
  const requestedLastInputTokens = toPositiveInputTokens(
    requestedCompactionContext?.lastInputTokens,
  );
  const inferredLastInputTokens = extractLastInputTokensFromMessages(messages);

  const compactionContext = {
    contextLimit: requestedContextLimit ?? DEFAULT_CONTEXT_LIMIT,
    lastInputTokens: requestedLastInputTokens ?? inferredLastInputTokens,
  };

  const modelMessages = await convertToModelMessages(messages, {
    ignoreIncompleteToolCalls: true,
    tools: openHarnessTools,
  });

  const run = await start(chatWorkflow, [
    {
      userId: session.user.id,
      sessionId,
      chatId,
      sandboxState: sessionRecord.sandboxState,
      messages: modelMessages,
      model: createWorkflowModelDescriptor({
        selectedModelId: mainResolvedModelId,
        fallbackModelId: DEFAULT_MODEL_ID,
        providerOptionsByProvider: mainSelection.providerOptionsByProvider,
        isMissingVariant: mainSelection.isMissingVariant,
      }),
      ...(subagentModel ? { subagentModel } : {}),
      approval: WEB_AGENT_APPROVAL,
      context: compactionContext,
      repoOwner: sessionRecord.repoOwner,
      repoName: sessionRecord.repoName,
      requestStartedAtMs,
    },
  ]);

  const activeStreamToken = createActiveStreamToken(
    requestStartedAtMs,
    run.runId,
  );
  await claimStreamOwnership(
    chatId,
    activeStreamToken,
    requestStartedAtMs,
  ).catch((error) => {
    console.error("Failed to claim chat stream ownership:", error);
    return false;
  });

  after(
    run.returnValue
      .then((result) => {
        const workflowResult = result as ChatWorkflowResult;
        if (
          !workflowResult.naturalFinish ||
          !workflowResult.autoCommitEligible
        ) {
          return;
        }

        refreshCachedDiffInBackground(req, sessionId);

        if (
          preferences?.autoCommitPush &&
          sessionRecord.cloneUrl &&
          sessionRecord.repoOwner &&
          sessionRecord.repoName
        ) {
          scheduleAutoCommitInBackground(req, {
            sessionId,
            sessionTitle: sessionRecord.title,
            repoOwner: sessionRecord.repoOwner,
            repoName: sessionRecord.repoName,
          });
        }
      })
      .catch((error) => {
        console.error("Workflow chat completion hook failed:", error);
      }),
  );

  return createUIMessageStreamResponse({
    stream: run.readable,
    headers: {
      "x-workflow-run-id": run.runId,
    },
  });
}
