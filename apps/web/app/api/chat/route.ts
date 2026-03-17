import { createUIMessageStreamResponse } from "ai";
import { start } from "workflow/api";
import { updateSession } from "@/lib/db/sessions";
import { getUserPreferences } from "@/lib/db/user-preferences";
import { buildActiveLifecycleUpdate } from "@/lib/sandbox/lifecycle";
import { chatWorkflow } from "@/app/workflows/chat";
import {
  requireAuthenticatedUser,
  requireOwnedSessionChat,
} from "./_lib/chat-context";
import {
  persistAssistantMessageFromStream,
  scheduleLatestMessagePersistence,
} from "./_lib/message-persistence";
import { resolveChatModelSelection } from "./_lib/model-selection";
import { parseChatRequestBody, requireChatIdentifiers } from "./_lib/request";
import { createStreamToken } from "@/lib/chat-stream-token";
import { claimStreamOwnership } from "./_lib/stream-lifecycle";

export const maxDuration = 800;

export async function POST(req: Request) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }
  const userId = authResult.userId;

  const parsedBody = await parseChatRequestBody(req);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const { messages } = parsedBody.body;

  const chatIdentifiers = requireChatIdentifiers(parsedBody.body);
  if (!chatIdentifiers.ok) {
    return chatIdentifiers.response;
  }
  const { sessionId, chatId } = chatIdentifiers;

  const chatContext = await requireOwnedSessionChat({
    userId,
    sessionId,
    chatId,
    forbiddenMessage: "Unauthorized",
    requireActiveSandbox: true,
    sandboxInactiveMessage: "Sandbox not initialized",
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  const { sessionRecord, chat } = chatContext;
  const activeSandboxState = sessionRecord.sandboxState;
  if (!activeSandboxState) {
    throw new Error("Sandbox not initialized");
  }

  const requestStartedAt = new Date();
  const requestStartedAtMs = requestStartedAt.getTime();

  const pendingAssistantSnapshot = scheduleLatestMessagePersistence(
    chatId,
    messages,
  );

  await updateSession(sessionId, {
    ...buildActiveLifecycleUpdate(sessionRecord.sandboxState, {
      activityAt: requestStartedAt,
    }),
  });

  const preferences = await getUserPreferences(userId).catch((error) => {
    console.error("Failed to load user preferences:", error);
    return null;
  });

  const modelVariants = preferences?.modelVariants ?? [];
  const mainModelSelection = resolveChatModelSelection({
    selectedModelId: chat.modelId,
    modelVariants,
    missingVariantLabel: "Selected model variant",
  });
  const subagentModelSelection = preferences?.defaultSubagentModelId
    ? resolveChatModelSelection({
        selectedModelId: preferences.defaultSubagentModelId,
        modelVariants,
        missingVariantLabel: "Subagent model variant",
      })
    : undefined;

  const run = await start(chatWorkflow, [
    {
      userId,
      sessionId,
      chatId,
      messages,
      requestStartedAtMs,
      model: mainModelSelection,
      ...(subagentModelSelection
        ? {
            subagentModel: subagentModelSelection,
          }
        : {}),
    },
  ]);

  const ownedStreamToken = createStreamToken(requestStartedAtMs, run.runId);
  try {
    await claimStreamOwnership({
      chatId,
      ownedStreamToken,
      requestStartedAtMs,
    });
  } catch (error) {
    console.error("Failed to claim chat stream ownership:", error);
  }

  const [clientStream, persistenceStream] = run.readable.tee();
  void persistAssistantMessageFromStream({
    chatId,
    stream: persistenceStream,
    ...(pendingAssistantSnapshot
      ? {
          initialAssistantMessage: pendingAssistantSnapshot,
        }
      : {}),
  });

  return createUIMessageStreamResponse({
    stream: clientStream,
    headers: {
      "x-workflow-run-id": run.runId,
    },
  });
}
