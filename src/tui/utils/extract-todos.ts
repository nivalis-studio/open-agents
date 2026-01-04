import { isToolUIPart } from "ai";
import type { TodoItem } from "../../agent/types.js";
import type { TUIAgentUIMessage, TUIAgentUIToolPart } from "../types.js";

function isTodoWritePart(
  part: TUIAgentUIToolPart
): part is TUIAgentUIToolPart & { type: "tool-todo_write" } {
  return part.type === "tool-todo_write";
}

export function extractTodosFromMessage(
  message: TUIAgentUIMessage
): TodoItem[] | null {
  let latestTodos: TodoItem[] | null = null;
  for (const part of message.parts) {
    if (
      isToolUIPart(part) &&
      isTodoWritePart(part) &&
      part.state === "output-available" &&
      part.output
    ) {
      latestTodos = part.output.todos;
    }
  }
  return latestTodos;
}

export function extractTodosFromLastAssistantMessage(
  messages: TUIAgentUIMessage[]
): TodoItem[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "assistant") {
      const todos = extractTodosFromMessage(message);
      if (todos !== null) {
        return todos;
      }
    }
    if (message.role === "user") {
      break;
    }
  }
  return null;
}
