import type { SubagentMessageMetadata } from "./types";

/**
 * A reconstructed subagent message built from a stream of UIMessageStream chunks.
 * This is structurally compatible with SubagentUIMessage but constructed manually
 * from the SSE buffer rather than via readUIMessageStream.
 */
export type ReconstructedSubagentMessage = {
  id: string;
  role: "assistant";
  parts: ReconstructedPart[];
  metadata: SubagentMessageMetadata;
};

type ReconstructedTextPart = {
  type: "text";
  text: string;
};

type ReconstructedToolPart = {
  type: string; // e.g. "tool-read", "tool-bash", etc.
  toolCallId: string;
  toolName: string;
  state:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error";
  input?: unknown;
  output?: unknown;
  errorText?: string;
  preliminary?: boolean;
  title?: string;
};

export type ReconstructedPart = ReconstructedTextPart | ReconstructedToolPart;

/**
 * Reconstruct a SubagentUIMessage from a newline-separated JSON buffer
 * of UIMessageStream chunks. This is a synchronous alternative to
 * readUIMessageStream that avoids the O(N²) structuredClone overhead.
 *
 * The buffer contains the raw chunks produced by toUIMessageStream(),
 * one JSON object per line.
 */
export function reconstructSubagentMessage(
  buffer: string,
): ReconstructedSubagentMessage {
  const message: ReconstructedSubagentMessage = {
    id: "",
    role: "assistant",
    parts: [],
    metadata: {},
  };

  // Indexes for fast lookup during reconstruction
  const textParts = new Map<string, ReconstructedTextPart>();
  const toolParts = new Map<string, ReconstructedToolPart>();

  const lines = buffer.split("\n");
  for (const line of lines) {
    if (!line) continue;

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(line);
    } catch {
      continue;
    }

    const type = chunk.type as string;

    switch (type) {
      case "start": {
        if (chunk.messageId) message.id = chunk.messageId as string;
        if (chunk.messageMetadata) {
          message.metadata = chunk.messageMetadata as SubagentMessageMetadata;
        }
        break;
      }

      case "text-start": {
        const id = chunk.id as string;
        const part: ReconstructedTextPart = { type: "text", text: "" };
        textParts.set(id, part);
        message.parts.push(part);
        break;
      }

      case "text-delta": {
        const id = chunk.id as string;
        const part = textParts.get(id);
        if (part) {
          part.text += chunk.delta as string;
        }
        break;
      }

      case "text-end": {
        // No-op — text part is already complete
        break;
      }

      case "tool-input-start": {
        const toolCallId = chunk.toolCallId as string;
        const toolName = chunk.toolName as string;
        const part: ReconstructedToolPart = {
          type: `tool-${toolName}`,
          toolCallId,
          toolName,
          state: "input-streaming",
          input: undefined,
          output: undefined,
          ...(chunk.title != null ? { title: chunk.title as string } : {}),
        };
        toolParts.set(toolCallId, part);
        message.parts.push(part);
        break;
      }

      case "tool-input-available": {
        const toolCallId = chunk.toolCallId as string;
        const part = toolParts.get(toolCallId);
        if (part) {
          part.state = "input-available";
          part.input = chunk.input;
        } else {
          // Tool appeared without a start event — create it
          const toolName = chunk.toolName as string;
          const newPart: ReconstructedToolPart = {
            type: `tool-${toolName}`,
            toolCallId,
            toolName,
            state: "input-available",
            input: chunk.input,
            output: undefined,
            ...(chunk.title != null ? { title: chunk.title as string } : {}),
          };
          toolParts.set(toolCallId, newPart);
          message.parts.push(newPart);
        }
        break;
      }

      case "tool-input-error": {
        const toolCallId = chunk.toolCallId as string;
        const part = toolParts.get(toolCallId);
        if (part) {
          part.state = "output-error";
          part.input = chunk.input;
          part.errorText = chunk.errorText as string;
        }
        break;
      }

      case "tool-output-available": {
        const toolCallId = chunk.toolCallId as string;
        const part = toolParts.get(toolCallId);
        if (part) {
          part.state = "output-available";
          part.output = chunk.output;
          part.preliminary = chunk.preliminary as boolean | undefined;
        }
        break;
      }

      case "tool-output-error": {
        const toolCallId = chunk.toolCallId as string;
        const part = toolParts.get(toolCallId);
        if (part) {
          part.state = "output-error";
          part.errorText = chunk.errorText as string;
        }
        break;
      }

      case "tool-output-denied": {
        // Subagent tools shouldn't have denials, but handle gracefully
        break;
      }

      case "message-metadata": {
        if (chunk.messageMetadata) {
          message.metadata = {
            ...message.metadata,
            ...(chunk.messageMetadata as SubagentMessageMetadata),
          };
        }
        break;
      }

      case "finish": {
        if (chunk.messageMetadata) {
          message.metadata = {
            ...message.metadata,
            ...(chunk.messageMetadata as SubagentMessageMetadata),
          };
        }
        break;
      }

      // Ignored chunk types
      case "start-step":
      case "finish-step":
      case "tool-input-delta":
      case "tool-input-end":
      case "reasoning-start":
      case "reasoning-delta":
      case "reasoning-end":
      case "error":
      case "abort":
        break;
    }
  }

  return message;
}
