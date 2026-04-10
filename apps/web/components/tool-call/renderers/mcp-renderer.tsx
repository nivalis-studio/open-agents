"use client";

import type { ToolRendererProps } from "@/app/lib/render-tool";
import { McpProviderIcon } from "@/components/mcp-icons";
import { ToolLayout } from "../tool-layout";

/**
 * Parse an MCP tool name like "mcp_granola_query_granola_meetings"
 * into { provider: "granola", toolName: "query_granola_meetings" }.
 */
function parseMcpToolName(fullName: string): {
  provider: string;
  toolName: string;
} {
  // Strip the "mcp_" prefix
  const withoutPrefix = fullName.slice(4);
  const underscoreIdx = withoutPrefix.indexOf("_");
  if (underscoreIdx === -1) {
    return { provider: withoutPrefix, toolName: withoutPrefix };
  }
  return {
    provider: withoutPrefix.slice(0, underscoreIdx),
    toolName: withoutPrefix.slice(underscoreIdx + 1),
  };
}

/**
 * Generate a human-friendly action label based on the tool name and provider.
 */
function getActionLabel(toolName: string, provider: string): string {
  const capitalized = provider.charAt(0).toUpperCase() + provider.slice(1);
  const lower = toolName.toLowerCase();

  if (/query|search|find|list|get/.test(lower)) {
    return `Searching ${capitalized}`;
  }
  if (/create|add|insert/.test(lower)) {
    return `Creating in ${capitalized}`;
  }
  if (/update|edit|modify/.test(lower)) {
    return `Updating ${capitalized}`;
  }
  if (/delete|remove/.test(lower)) {
    return `Deleting from ${capitalized}`;
  }
  return `Using ${capitalized}`;
}

/**
 * Get the most relevant input field to display as the summary.
 */
function getSummary(input: Record<string, unknown> | undefined): string {
  if (!input) return "...";

  // Try common field names in order of priority
  for (const key of [
    "query",
    "search",
    "q",
    "name",
    "title",
    "message",
    "text",
    "content",
    "url",
    "path",
    "id",
  ]) {
    if (key in input && input[key] != null) {
      const val = String(input[key]);
      return val.length > 80 ? `${val.slice(0, 77)}...` : val;
    }
  }

  // Fall back to first string value
  for (const val of Object.values(input)) {
    if (typeof val === "string" && val.length > 0) {
      return val.length > 80 ? `${val.slice(0, 77)}...` : val;
    }
  }

  // Fall back to JSON
  const json = JSON.stringify(input);
  return json.length > 80 ? `${json.slice(0, 77)}...` : json;
}

// ---------------------------------------------------------------------------
// Provider icon
// ---------------------------------------------------------------------------

function getProviderIcon(provider: string) {
  return (
    <McpProviderIcon provider={provider.toLowerCase()} className="size-4" />
  );
}

// ---------------------------------------------------------------------------
// Format MCP output content
// ---------------------------------------------------------------------------

function formatMcpOutput(output: unknown): string | null {
  if (output == null) return null;

  // MCP CallToolResult has a `content` array
  if (typeof output === "object" && "content" in (output as object)) {
    const result = output as { content?: unknown[] };
    if (Array.isArray(result.content)) {
      return result.content
        .map((item) => {
          if (typeof item === "object" && item != null && "text" in item) {
            return String((item as { text: unknown }).text);
          }
          if (typeof item === "string") return item;
          return JSON.stringify(item, null, 2);
        })
        .join("\n");
    }
  }

  if (typeof output === "string") return output;
  return JSON.stringify(output, null, 2);
}

// ---------------------------------------------------------------------------
// McpRenderer
// ---------------------------------------------------------------------------

export function McpRenderer({
  part,
  state,
  onApprove,
  onDeny,
}: ToolRendererProps<"dynamic-tool">) {
  const fullToolName =
    part.type === "dynamic-tool" ? part.toolName : String(part.type);
  const { provider, toolName } = parseMcpToolName(fullToolName);
  const actionLabel = getActionLabel(toolName, provider);
  const icon = getProviderIcon(provider);

  const input = part.input as Record<string, unknown> | undefined;
  const summary = getSummary(input);

  const rawOutput =
    part.state === "output-available" ? (part.output as unknown) : undefined;
  const outputText = formatMcpOutput(rawOutput);
  const hasOutput = outputText != null && outputText.length > 0;

  const expandedContent = hasOutput ? (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
      {outputText}
    </pre>
  ) : undefined;

  const meta = part.state === "output-available" ? "Done" : undefined;

  return (
    <ToolLayout
      name={actionLabel}
      icon={icon}
      summary={summary}
      summaryClassName="font-mono"
      meta={meta}
      state={state}
      expandedContent={expandedContent}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}
