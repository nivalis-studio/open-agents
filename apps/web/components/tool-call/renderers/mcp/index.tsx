"use client";

import { useMemo, type ReactNode } from "react";
import type { ToolRendererProps } from "@/app/lib/render-tool";
import { ToolLayout } from "../../tool-layout";
import {
  parseMcpToolName,
  getActionLabel,
  getProviderIcon,
  getSummary,
  isUUID,
  extractOutputText,
} from "./shared";
import { formatNotionOutput } from "./notion";
import { formatGranolaOutput } from "./granola";
import { formatDefaultOutput } from "./default";

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

type OutputFormatter = (rawOutput: unknown) => ReactNode | undefined;

const providerFormatters: Record<string, OutputFormatter> = {
  notion: formatNotionOutput,
  granola: formatGranolaOutput,
};

function getOutputFormatter(provider: string): OutputFormatter {
  return providerFormatters[provider] ?? formatDefaultOutput;
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
  const rawOutput =
    part.state === "output-available" ? (part.output as unknown) : undefined;

  // Try to get a better summary: if input is just an ID, use output title
  const summary = useMemo(() => {
    const inputSummary = getSummary(input);
    // If the summary is "..." or looks like a UUID, try to get title from output
    if ((inputSummary === "..." || isUUID(inputSummary)) && rawOutput != null) {
      const text = extractOutputText(rawOutput);
      if (text) {
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (typeof parsed.title === "string") return parsed.title;
          if (typeof parsed.name === "string") return parsed.name;
        } catch {
          // Try to extract title from XML-ish content
          const titleMatch = text.match(
            /(?:title|name)["=:]\s*"?([^"<\n]{2,60})/i,
          );
          if (titleMatch) return titleMatch[1].trim();
        }
      }
    }
    return inputSummary;
  }, [input, rawOutput]);

  const formatOutput = getOutputFormatter(provider);
  const expandedContent = useMemo(() => {
    if (rawOutput == null) return undefined;
    return formatOutput(rawOutput);
  }, [rawOutput, formatOutput]);

  return (
    <ToolLayout
      name={actionLabel}
      icon={icon}
      summary={summary}
      summaryClassName="font-mono"
      state={state}
      expandedContent={expandedContent}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}
