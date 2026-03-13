import type {
  DynamicToolUIPart,
  InferUITools,
  LanguageModelUsage,
  ToolUIPart,
  UIMessage,
} from "ai";
import { openHarnessTools } from "@open-harness/agent";

export type WebAgentMessageMetadata = {
  lastStepUsage?: LanguageModelUsage;
  totalMessageUsage?: LanguageModelUsage;
};

export type WebAgentUITools = InferUITools<typeof openHarnessTools>;
export type WebAgentUIMessage = UIMessage<
  WebAgentMessageMetadata,
  never,
  WebAgentUITools
>;
export type WebAgentUIMessagePart = WebAgentUIMessage["parts"][number];
export type WebAgentUIToolPart =
  | DynamicToolUIPart
  | ToolUIPart<WebAgentUITools>;
