import type { InferAgentUIMessage, LanguageModelUsage } from "ai";
import type { executorSubagent } from "./executor";
import type { explorerSubagent } from "./explorer";

export type SubagentMessageMetadata = {
  lastStepUsage?: LanguageModelUsage;
  totalMessageUsage?: LanguageModelUsage;
  modelId?: string;
};

// Union of both subagent types to support all tool types at runtime
export type SubagentUIMessage =
  | InferAgentUIMessage<typeof explorerSubagent, SubagentMessageMetadata>
  | InferAgentUIMessage<typeof executorSubagent, SubagentMessageMetadata>;

/**
 * The output yielded by the task tool's generator.
 *
 * Instead of yielding full SubagentUIMessage snapshots (O(N²) on the wire),
 * we yield a growing buffer of newline-separated JSON chunks from
 * toUIMessageStream(). The client reconstructs the SubagentUIMessage
 * from this compact buffer.
 */
export type TaskToolStreamOutput = {
  /** Newline-separated JSON chunks from toUIMessageStream */
  buffer: string;
  /**
   * Metadata extracted from the stream, kept at the top level
   * for compatibility with extractTaskOutputUsage in usage.ts
   */
  metadata?: SubagentMessageMetadata;
};
