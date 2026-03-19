import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WebAgentUIMessage } from "@/app/types";
import { AssistantMessageGroups } from "./assistant-message-groups";

function renderMessage(
  message: WebAgentUIMessage,
  options?: {
    isStreaming?: boolean;
    isInterrupted?: boolean;
  },
): string {
  const { isStreaming = false, isInterrupted = false } = options ?? {};
  return renderToStaticMarkup(
    <AssistantMessageGroups
      message={message}
      isStreaming={isStreaming}
      isInterrupted={isInterrupted}
      durationMs={null}
      startedAt={null}
    >
      {(isExpanded) => <div>{isExpanded ? "expanded" : "collapsed"}</div>}
    </AssistantMessageGroups>,
  );
}

function makeAssistantMessage(
  overrides?: Partial<WebAgentUIMessage>,
): WebAgentUIMessage {
  return {
    id: "msg-1",
    role: "assistant",
    parts: [],
    ...overrides,
  } as WebAgentUIMessage;
}

describe("AssistantMessageGroups interrupted summary", () => {
  test("does not mark ask-user-question input as interrupted after streaming ends", () => {
    const html = renderMessage(
      makeAssistantMessage({
        parts: [
          {
            type: "tool-ask_user_question",
            toolCallId: "tool-1",
            state: "input-available",
            input: {
              questions: [
                {
                  header: "Choice",
                  question: "Pick one?",
                  options: [
                    { label: "A", description: "Option A" },
                    { label: "B", description: "Option B" },
                  ],
                  multiSelect: false,
                },
              ],
            },
          },
        ],
      }),
    );

    expect(html).not.toContain(
      '<span class="inline-flex shrink-0 items-center rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-[11px] font-medium leading-none text-yellow-600 dark:text-yellow-400">Interrupted</span>',
    );
  });

  test("marks preliminary task output as interrupted after streaming ends", () => {
    const html = renderMessage(
      makeAssistantMessage({
        parts: [
          {
            type: "tool-task",
            toolCallId: "tool-2",
            state: "output-available",
            preliminary: true,
            input: {
              subagentType: "executor",
              task: "Fix a bug",
              instructions: "Investigate and patch the issue.",
            },
            output: {
              toolCallCount: 1,
            },
          },
        ],
      }),
    );

    expect(html).toContain(
      '<span class="inline-flex shrink-0 items-center rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-[11px] font-medium leading-none text-yellow-600 dark:text-yellow-400">Interrupted</span>',
    );
  });

  test("marks a user-aborted assistant turn as interrupted even when no tool call is interrupted", () => {
    const html = renderMessage(
      makeAssistantMessage({
        parts: [
          {
            type: "tool-ask_user_question",
            toolCallId: "tool-3",
            state: "input-available",
            input: {
              questions: [
                {
                  header: "Choice",
                  question: "Pick one?",
                  options: [
                    { label: "A", description: "Option A" },
                    { label: "B", description: "Option B" },
                  ],
                  multiSelect: false,
                },
              ],
            },
          },
        ],
      }),
      { isInterrupted: true },
    );

    expect(html).toContain(
      '<span class="inline-flex shrink-0 items-center rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-[11px] font-medium leading-none text-yellow-600 dark:text-yellow-400">Interrupted</span>',
    );
  });
});
