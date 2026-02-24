import type { UIMessageChunk } from "ai";
import { getRun } from "workflow/api";
import { getChatById, getSessionById } from "@/lib/db/sessions";
import { getServerSession } from "@/lib/session/get-server-session";

type RouteContext = {
  params: Promise<{ runId: string }>;
};

/**
 * Reconnection endpoint for durable chat workflows.
 *
 * The `WorkflowChatTransport` on the client calls this endpoint to
 * resume reading from an in-progress or completed workflow run.
 */
export async function GET(request: Request, context: RouteContext) {
  const session = await getServerSession();
  if (!session?.user) {
    return new Response("Not authenticated", { status: 401 });
  }

  const { runId } = await context.params;

  const url = new URL(request.url);
  const chatId = url.searchParams.get("chatId");

  // If chatId is provided, verify ownership
  if (chatId) {
    const chat = await getChatById(chatId);
    if (!chat) {
      return new Response("Chat not found", { status: 404 });
    }

    const sessionRecord = await getSessionById(chat.sessionId);
    if (!sessionRecord || sessionRecord.userId !== session.user.id) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  const startIndex = Number.parseInt(
    url.searchParams.get("startIndex") ?? "0",
    10,
  );

  try {
    const run = getRun(runId);
    const stream = run.getReadable<UIMessageChunk>({
      startIndex: Number.isFinite(startIndex) ? startIndex : 0,
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-workflow-run-id": runId,
      },
    });
  } catch (error) {
    console.error("Failed to reconnect to workflow run:", error);
    return new Response("Workflow run not found", { status: 404 });
  }
}
