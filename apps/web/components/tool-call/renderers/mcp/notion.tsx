"use client";

import type { ReactNode } from "react";
import { tryParseStructuredOutput } from "./shared";
import { SearchResultItem } from "./output-search";
import { PageResultView } from "./output-page";
import { TableResultView } from "./output-table";

export function formatNotionOutput(rawOutput: unknown): ReactNode | undefined {
  const structured = tryParseStructuredOutput(rawOutput);
  if (!structured) return undefined;

  switch (structured.kind) {
    case "search":
      return (
        <div className="ml-4 space-y-0">
          {structured.results.map((result, i) => (
            <SearchResultItem key={result.id ?? i} result={result} />
          ))}
        </div>
      );
    case "page":
      return <PageResultView page={structured.page} />;
    case "table":
      return (
        <TableResultView rows={structured.rows} columns={structured.columns} />
      );
  }
}
