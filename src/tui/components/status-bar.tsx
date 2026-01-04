import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { ThinkingState } from "../reasoning-context.js";
import type { TodoItem } from "../../agent/types.js";

const SILLY_WORDS = [
  "Thinking",
  "Pondering",
  "Cogitating",
  "Ruminating",
  "Mulling",
  "Noodling",
  "Smooshing",
  "Percolating",
  "Marinating",
  "Simmering",
  "Brewing",
  "Conjuring",
  "Manifesting",
  "Vibing",
  "Channeling",
];
const SILLY_WORD_INTERVAL = 2000;

function useSillyWord() {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * SILLY_WORDS.length));

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % SILLY_WORDS.length);
    }, SILLY_WORD_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  return SILLY_WORDS[index];
}

type StatusBarProps = {
  isStreaming: boolean;
  status?: string;
  thinkingState: ThinkingState;
  todos?: TodoItem[] | null;
  isTodoVisible?: boolean;
};

function getThinkingMeta(thinkingState: ThinkingState): string {
  if (thinkingState.thinkingDuration !== null) {
    return `thought for ${thinkingState.thinkingDuration}s`;
  }
  if (thinkingState.isThinking) {
    return "thinking";
  }
  return "";
}

// Status indicator - not memoized to allow animation
function StatusIndicator({
  isStreaming,
  status,
  thinkingState,
}: {
  isStreaming: boolean;
  status?: string;
  thinkingState: ThinkingState;
}) {
  const sillyWord = useSillyWord();
  const isDefaultStatus = !status || status === "Thinking...";
  const displayStatus = isDefaultStatus ? `${sillyWord}...` : status;

  // Determine prefix: + while streaming/thinking not done, * when thinking completed
  const hasThinkingCompleted = thinkingState.thinkingDuration !== null;
  const prefix = hasThinkingCompleted ? "*" : "+";

  // Build the meta text
  const thinkingMeta = getThinkingMeta(thinkingState);
  const metaText = thinkingMeta
    ? `(esc to interrupt · ${thinkingMeta})`
    : "(esc to interrupt)";

  if (isStreaming) {
    return (
      <>
        <Text color="yellow">{prefix} </Text>
        <Text color="yellow">{displayStatus}</Text>
        <Text color="gray"> {metaText}</Text>
      </>
    );
  }
  return <Text color="green">✓ {status || "Done"}</Text>;
}

function getTodoIcon(status: TodoItem["status"]): string {
  switch (status) {
    case "completed":
      return "☒";
    case "in_progress":
      return "◎";
    case "pending":
    default:
      return "☐";
  }
}

function getTodoColor(status: TodoItem["status"]): string {
  switch (status) {
    case "completed":
      return "gray";
    case "in_progress":
      return "yellow";
    case "pending":
    default:
      return "white";
  }
}

function TodoList({ todos }: { todos: TodoItem[] }) {
  const hasIncompleteTodos = todos.some((t) => t.status !== "completed");
  if (!hasIncompleteTodos) return null;

  return (
    <Box flexDirection="column" marginLeft={2}>
      {todos.map((todo) => (
        <Box key={todo.id}>
          <Text color={getTodoColor(todo.status)}>
            {getTodoIcon(todo.status)}{" "}
            {todo.status === "completed" ? (
              <Text strikethrough>{todo.content}</Text>
            ) : (
              todo.content
            )}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

// Not memoized to allow animation
export function StatusBar({
  isStreaming,
  status,
  thinkingState,
  todos,
  isTodoVisible = true,
}: StatusBarProps) {
  if (!isStreaming && !status) {
    return null;
  }

  const hasTodos = todos && todos.length > 0;
  const hasIncompleteTodos = hasTodos && todos.some((t) => t.status !== "completed");
  const showTodos = isTodoVisible && hasIncompleteTodos;

  const todoHint = hasTodos && hasIncompleteTodos
    ? ` · ctrl+t to ${isTodoVisible ? "hide" : "show"} todos`
    : "";

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <StatusIndicator
          isStreaming={isStreaming}
          status={status}
          thinkingState={thinkingState}
        />
        {hasTodos && <Text color="gray">{todoHint}</Text>}
      </Box>
      {showTodos && <TodoList todos={todos} />}
    </Box>
  );
}
