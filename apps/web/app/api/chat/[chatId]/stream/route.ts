import { createUIMessageStreamResponse } from "ai";
import { getRun } from "workflow/api";
import type { WebAgentUIMessage } from "@/app/types";
import {
  requireAuthenticatedUser,
  requireOwnedChatById,
} from "@/app/api/chat/_lib/chat-context";
import { persistAssistantMessageFromStream } from "@/app/api/chat/_lib/message-persistence";
import { parseStreamTokenValue } from "@/lib/chat-stream-token";
import { getChatMessages } from "@/lib/db/sessions";

type RouteContext = {
  params: Promise<{ chatId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser("text");
  if (!authResult.ok) {
    return authResult.response;
  }

  const { chatId: runId } = await context.params;
  const owningChatId = request.headers.get("x-chat-id");
  if (!owningChatId) {
    return new Response("Missing x-chat-id header", { status: 400 });
  }

  const chatContext = await requireOwnedChatById({
    userId: authResult.userId,
    chatId: owningChatId,
    format: "text",
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  const activeRunId = parseStreamTokenValue(chatContext.chat.activeStreamId);
  if (!activeRunId || activeRunId !== runId) {
    return new Response(null, { status: 204 });
  }

  const url = new URL(request.url);
  const startIndexValue = url.searchParams.get("startIndex");
  const parsedStartIndex = startIndexValue
    ? Number.parseInt(startIndexValue, 10)
    : Number.NaN;
  const startIndex = Number.isFinite(parsedStartIndex)
    ? parsedStartIndex
    : undefined;

  try {
    const latestPersistedMessage = (await getChatMessages(owningChatId)).at(-1);
    const initialAssistantMessage =
      latestPersistedMessage?.role === "assistant"
        ? (latestPersistedMessage.parts as WebAgentUIMessage)
        : undefined;

    const run = getRun(runId);
    const [clientStream, persistenceStream] = run
      .getReadable({ startIndex })
      .tee();

    void persistAssistantMessageFromStream({
      chatId: owningChatId,
      stream: persistenceStream,
      ...(initialAssistantMessage ? { initialAssistantMessage } : {}),
    });

    return createUIMessageStreamResponse({
      stream: clientStream,
    });
  } catch {
    return new Response(null, { status: 204 });
  }
}
