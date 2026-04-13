"use client";

import { ExternalLink } from "lucide-react";
import { McpProviderIcon } from "@/components/mcp-icons";
import type { PageResult } from "./shared";
import { isValidExternalUrl } from "./shared";

/**
 * Parse a Notion icon reference like "icons/circle-seven-eighths_green" into an emoji.
 */
export function parseNotionIcon(text: string | undefined): string | null {
  if (!text) return null;
  // Look for icon="..." in page XML
  const iconMatch = text.match(/icon="([^"]+)"/);
  if (!iconMatch) return null;
  const icon = iconMatch[1];
  // Direct emoji
  if (!icon.startsWith("icons/") && !icon.startsWith("/icons/")) return icon;
  // Map common Notion icon names to emoji
  const name = icon.replace(/^\/?icons\//, "");
  if (name.includes("check") || name.includes("complete")) return "✅";
  if (name.includes("circle") && name.includes("green")) return "🟢";
  if (name.includes("circle") && name.includes("red")) return "🔴";
  if (name.includes("circle") && name.includes("yellow")) return "🟡";
  if (name.includes("circle") && name.includes("blue")) return "🔵";
  if (name.includes("star")) return "⭐";
  if (name.includes("fire")) return "🔥";
  if (name.includes("book")) return "📖";
  if (name.includes("doc") || name.includes("page")) return "📄";
  if (name.includes("folder")) return "📁";
  if (name.includes("light")) return "💡";
  if (name.includes("rocket")) return "🚀";
  if (name.includes("heart")) return "❤️";
  if (name.includes("warning")) return "⚠️";
  return "📝";
}

/**
 * Check if the page text indicates a verified/published page.
 */
export function isPageVerified(text: string | undefined): boolean {
  if (!text) return false;
  return (
    /status[":]?\s*["']?(published|verified|live|approved)/i.test(text) ||
    /verified[":]?\s*["']?true/i.test(text)
  );
}

export function PageResultView({ page }: { page: PageResult }) {
  const hasLink = isValidExternalUrl(page.url);
  const pageIcon = parseNotionIcon(page.text);
  const verified = isPageVerified(page.text);

  // Strip XML-like tags for a cleaner preview
  const preview = page.text
    ?.replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 800);

  return (
    <div className="ml-4 space-y-1.5">
      {page.title && (
        <div className="inline-flex items-center gap-1.5">
          {pageIcon ? (
            <span className="text-xs shrink-0">{pageIcon}</span>
          ) : (
            <McpProviderIcon provider="notion" className="size-3.5" />
          )}
          {hasLink ? (
            <a
              href={page.url!}
              target="_blank"
              rel="noopener noreferrer"
              className="group/page inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
            >
              {page.title}
              <ExternalLink className="size-2.5 opacity-0 group-hover/page:opacity-70 transition-opacity" />
            </a>
          ) : (
            <span className="text-[11px] font-medium text-foreground/90">
              {page.title}
            </span>
          )}
          {verified && (
            <svg
              className="size-3 shrink-0 text-blue-500"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          )}
        </div>
      )}
      {preview && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/20 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/70">
          {preview}
        </pre>
      )}
    </div>
  );
}
