import { readUIMessageStream, type UIMessageChunk } from "ai";
import type { WebAgentUIMessage } from "@/app/types";
import { hasRenderableAssistantPart } from "@/lib/chat-streaming-state";
import {
  createChatMessageIfNotExists,
  isFirstChatMessage,
  touchChat,
  updateChat,
  updateChatAssistantActivity,
  upsertChatMessageScoped,
} from "@/lib/db/sessions";

async function persistLatestUserMessage(
  chatId: string,
  latestMessage: WebAgentUIMessage,
): Promise<void> {
  if (latestMessage.role !== "user") {
    return;
  }

  try {
    const createdUserMessage = await createChatMessageIfNotExists({
      id: latestMessage.id,
      chatId,
      role: "user",
      parts: latestMessage,
    });

    if (!createdUserMessage) {
      return;
    }

    await touchChat(chatId);

    const shouldSetTitle = await isFirstChatMessage(
      chatId,
      createdUserMessage.id,
    );
    if (!shouldSetTitle) {
      return;
    }

    const textContent = latestMessage.parts
      .filter(
        (part): part is { type: "text"; text: string } => part.type === "text",
      )
      .map((part) => part.text)
      .join(" ")
      .trim();

    if (textContent.length === 0) {
      return;
    }

    const title =
      textContent.length > 30 ? `${textContent.slice(0, 30)}...` : textContent;
    await updateChat(chatId, { title });
  } catch (error) {
    console.error("Failed to save latest chat message:", error);
  }
}

export async function persistAssistantMessageFromStream(params: {
  chatId: string;
  stream: ReadableStream<UIMessageChunk>;
  initialAssistantMessage?: WebAgentUIMessage;
}): Promise<void> {
  let latestAssistantMessage = params.initialAssistantMessage;

  try {
    for await (const message of readUIMessageStream<WebAgentUIMessage>({
      message: params.initialAssistantMessage,
      stream: params.stream,
      onError: (error) => {
        console.error(
          "Failed to read assistant stream for persistence:",
          error,
        );
      },
    })) {
      latestAssistantMessage = message;
    }
  } catch (error) {
    console.error("Failed to consume assistant stream for persistence:", error);
  }

  if (
    !latestAssistantMessage ||
    !latestAssistantMessage.parts.some(hasRenderableAssistantPart)
  ) {
    return;
  }

  try {
    const upsertResult = await upsertChatMessageScoped({
      id: latestAssistantMessage.id,
      chatId: params.chatId,
      role: "assistant",
      parts: latestAssistantMessage,
    });

    if (upsertResult.status === "conflict") {
      console.warn(
        `Skipped assistant message upsert due to ID scope conflict: ${latestAssistantMessage.id}`,
      );
      return;
    }

    await updateChatAssistantActivity(params.chatId, new Date());
  } catch (error) {
    console.error("Failed to save assistant message from stream:", error);
  }
}

export function scheduleLatestMessagePersistence(
  chatId: string,
  messages: WebAgentUIMessage[],
): WebAgentUIMessage | null {
  const latestMessage = messages[messages.length - 1];
  if (
    !latestMessage ||
    (latestMessage.role !== "user" && latestMessage.role !== "assistant") ||
    typeof latestMessage.id !== "string" ||
    latestMessage.id.length === 0
  ) {
    return null;
  }

  if (latestMessage.role === "assistant") {
    return latestMessage;
  }

  void persistLatestUserMessage(chatId, latestMessage);
  return null;
}
