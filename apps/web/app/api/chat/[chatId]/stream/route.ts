import { createUIMessageStreamResponse } from "ai";
import { getRun } from "workflow/api";
import {
  requireAuthenticatedUser,
  requireOwnedChatById,
} from "@/app/api/chat/_lib/chat-context";
import { parseStreamTokenValue } from "@/lib/chat-stream-token";

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
    const run = getRun(runId);
    return createUIMessageStreamResponse({
      stream: run.getReadable({ startIndex }),
    });
  } catch {
    return new Response(null, { status: 204 });
  }
}
