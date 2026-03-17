import { getRun } from "workflow/api";
import {
  requireAuthenticatedUser,
  requireOwnedChatById,
} from "@/app/api/chat/_lib/chat-context";
import { parseStreamTokenValue } from "@/lib/chat-stream-token";
import { compareAndSetChatActiveStreamId } from "@/lib/db/sessions";

type RouteContext = {
  params: Promise<{ chatId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const { chatId } = await context.params;

  const chatContext = await requireOwnedChatById({
    userId: authResult.userId,
    chatId,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  const activeStreamToken = chatContext.chat.activeStreamId;
  if (!activeStreamToken) {
    return Response.json({ success: true });
  }

  const runId = parseStreamTokenValue(activeStreamToken);
  if (runId) {
    try {
      await getRun(runId).cancel();
    } catch (error) {
      console.warn(
        `[chat] Failed to cancel workflow run ${runId} for chat ${chatId}:`,
        error,
      );
    }
  }

  await compareAndSetChatActiveStreamId(chatId, activeStreamToken, null);

  return Response.json({ success: true });
}
