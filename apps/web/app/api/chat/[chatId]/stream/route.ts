import { after } from "next/server";
import { createUIMessageStreamResponse } from "ai";
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

function parseStartIndex(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function GET(request: Request, context: RouteContext) {
  const session = await getServerSession();
  if (!session?.user) {
    return new Response("Not authenticated", { status: 401 });
  }

  const { chatId } = await context.params;

  const chat = await getChatById(chatId);
  if (!chat) {
    return new Response("Chat not found", { status: 404 });
  }

  const sessionRecord = await getSessionById(chat.sessionId);
  if (!sessionRecord || sessionRecord.userId !== session.user.id) {
    return new Response("Forbidden", { status: 403 });
  }

  const runId = parseActiveStreamRunId(chat.activeStreamId);
  if (!runId) {
    return new Response(null, { status: 204 });
  }

  const startIndex = parseStartIndex(
    new URL(request.url).searchParams.get("startIndex"),
  );

  try {
    const run = workflowApi.getRun(runId);
    const stream = run.getReadable({ startIndex });
    return createUIMessageStreamResponse({ stream });
  } catch {
    after(async () => {
      await updateChatActiveStreamId(chatId, null);
    });
    return new Response(null, { status: 204 });
  }
}
