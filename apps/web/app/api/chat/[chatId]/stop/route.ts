import * as workflowApi from "workflow/api";
import {
  getChatById,
  getSessionById,
  updateChatActiveStreamId,
} from "@/lib/db/sessions";
import { getServerSession } from "@/lib/session/get-server-session";

const STREAM_TOKEN_SEPARATOR = ":";

type RouteContext = {
  params: Promise<{ chatId: string }>;
};

function parseActiveStreamRunId(activeStreamId: string | null): string | null {
  if (!activeStreamId) {
    return null;
  }

  const separatorIndex = activeStreamId.indexOf(STREAM_TOKEN_SEPARATOR);
  if (separatorIndex <= 0) {
    return null;
  }

  const runId = activeStreamId.slice(separatorIndex + 1);
  return runId || null;
}

export async function POST(_request: Request, context: RouteContext) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { chatId } = await context.params;

  const chat = await getChatById(chatId);
  if (!chat) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  const sessionRecord = await getSessionById(chat.sessionId);
  if (!sessionRecord || sessionRecord.userId !== session.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const runId = parseActiveStreamRunId(chat.activeStreamId);
  if (!runId) {
    return Response.json({ success: true });
  }

  try {
    await workflowApi.getRun(runId).cancel();
    await updateChatActiveStreamId(chatId, null);
  } catch (error) {
    console.error(`[workflow] Failed to cancel chat run ${runId}:`, error);
    return Response.json(
      { error: "Failed to stop workflow run" },
      { status: 502 },
    );
  }

  return Response.json({ success: true });
}
