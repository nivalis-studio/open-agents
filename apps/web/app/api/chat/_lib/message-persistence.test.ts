import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { UIMessageChunk } from "ai";

const upsertCalls: Array<{
  id: string;
  chatId: string;
  role: string;
  parts: unknown;
}> = [];
const assistantActivityCalls: Array<{ chatId: string }> = [];

mock.module("@/lib/db/sessions", () => ({
  createChatMessageIfNotExists: async () => null,
  isFirstChatMessage: async () => false,
  touchChat: async () => undefined,
  updateChat: async () => undefined,
  updateChatAssistantActivity: async (chatId: string) => {
    assistantActivityCalls.push({ chatId });
  },
  upsertChatMessageScoped: async (params: {
    id: string;
    chatId: string;
    role: string;
    parts: unknown;
  }) => {
    upsertCalls.push(params);
    return { status: "inserted" };
  },
}));

const messagePersistenceModulePromise = import("./message-persistence");

function createChunkStream(
  chunks: UIMessageChunk[],
): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe("persistAssistantMessageFromStream", () => {
  beforeEach(() => {
    upsertCalls.length = 0;
    assistantActivityCalls.length = 0;
  });

  test("persists partial assistant text when the stream closes without finish", async () => {
    const { persistAssistantMessageFromStream } =
      await messagePersistenceModulePromise;

    await persistAssistantMessageFromStream({
      chatId: "chat-1",
      stream: createChunkStream([
        { type: "start", messageId: "assistant-1" },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Partial" },
      ]),
    });

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({
      id: "assistant-1",
      chatId: "chat-1",
      role: "assistant",
      parts: {
        id: "assistant-1",
        role: "assistant",
        parts: [
          expect.objectContaining({
            type: "text",
            text: "Partial",
          }),
        ],
      },
    });
    expect(assistantActivityCalls).toEqual([{ chatId: "chat-1" }]);
  });

  test("skips persistence when no renderable assistant content was streamed", async () => {
    const { persistAssistantMessageFromStream } =
      await messagePersistenceModulePromise;

    await persistAssistantMessageFromStream({
      chatId: "chat-2",
      stream: createChunkStream([{ type: "start", messageId: "assistant-2" }]),
    });

    expect(upsertCalls).toEqual([]);
    expect(assistantActivityCalls).toEqual([]);
  });
});
