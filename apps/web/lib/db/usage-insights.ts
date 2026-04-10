import { and, asc, eq, sql } from "drizzle-orm";
import {
  buildUsageInsights,
  type UsageAggregateRow,
  type UsageAssistantTurnRow,
  type UsageSessionInsightRow,
} from "@/lib/usage/compute-insights";
import {
  getDateRangeDaysInclusive,
  type UsageDateRange,
} from "@/lib/usage/date-range";
import type { UsageInsights } from "@/lib/usage/types";
import { db } from "./client";
import { chatMessages, chats, sessions, usageEvents } from "./schema";

const EMPTY_USAGE_AGGREGATE: UsageAggregateRow = {
  totalInputTokens: 0,
  totalCachedInputTokens: 0,
  totalOutputTokens: 0,
  totalToolCallCount: 0,
  mainInputTokens: 0,
  mainOutputTokens: 0,
  mainAssistantTurnCount: 0,
  largestMainTurnTokens: 0,
};

export interface UsageInsightsOptions {
  days?: number;
  range?: UsageDateRange;
  allTime?: boolean;
}

function buildUsageEventsWhereClause(
  userId: string,
  options?: UsageInsightsOptions,
) {
  if (options?.range) {
    return sql`${usageEvents.userId} = ${userId} and date(${usageEvents.createdAt}) >= ${options.range.from} and date(${usageEvents.createdAt}) <= ${options.range.to}`;
  }

  if (options?.allTime) {
    return sql`${usageEvents.userId} = ${userId}`;
  }

  const days = options?.days ?? 280;
  const since = new Date();
  since.setDate(since.getDate() - days);

  return sql`${usageEvents.userId} = ${userId} and ${usageEvents.createdAt} >= ${since.toISOString()}`;
}

function buildSessionsWhereClause(
  userId: string,
  options?: UsageInsightsOptions,
) {
  if (options?.range) {
    return and(
      eq(sessions.userId, userId),
      sql`date(${sessions.updatedAt}) >= ${options.range.from}`,
      sql`date(${sessions.updatedAt}) <= ${options.range.to}`,
    );
  }

  if (options?.allTime) {
    return eq(sessions.userId, userId);
  }

  const days = options?.days ?? 280;
  const since = new Date();
  since.setDate(since.getDate() - days);

  return and(
    eq(sessions.userId, userId),
    sql`${sessions.updatedAt} >= ${since.toISOString()}`,
  );
}

function buildAssistantTurnsWhereClause(
  userId: string,
  options?: UsageInsightsOptions,
) {
  if (options?.range) {
    return and(
      eq(sessions.userId, userId),
      sql`date(${chatMessages.createdAt}) >= ${options.range.from}`,
      sql`date(${chatMessages.createdAt}) <= ${options.range.to}`,
    );
  }

  if (options?.allTime) {
    return eq(sessions.userId, userId);
  }

  const days = options?.days ?? 280;
  const since = new Date();
  since.setDate(since.getDate() - days);

  return and(
    eq(sessions.userId, userId),
    sql`${chatMessages.createdAt} >= ${since.toISOString()}`,
  );
}

function getLookbackDays(options?: UsageInsightsOptions): number {
  if (options?.range) {
    return getDateRangeDaysInclusive(options.range);
  }

  if (options?.allTime) {
    return 0;
  }

  return options?.days ?? 280;
}

export async function getUsageInsights(
  userId: string,
  options?: UsageInsightsOptions,
): Promise<UsageInsights> {
  const [aggregateRows, sessionRows, assistantTurnRows] = await Promise.all([
    db
      .select({
        totalInputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::double precision`,
        totalCachedInputTokens: sql<number>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)::double precision`,
        totalOutputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::double precision`,
        totalToolCallCount: sql<number>`coalesce(sum(${usageEvents.toolCallCount}), 0)::double precision`,
        mainInputTokens: sql<number>`coalesce(sum(case when ${usageEvents.agentType} = 'main' then ${usageEvents.inputTokens} else 0 end), 0)::double precision`,
        mainOutputTokens: sql<number>`coalesce(sum(case when ${usageEvents.agentType} = 'main' then ${usageEvents.outputTokens} else 0 end), 0)::double precision`,
        mainAssistantTurnCount: sql<number>`coalesce(sum(case when ${usageEvents.agentType} = 'main' then 1 else 0 end), 0)::double precision`,
        largestMainTurnTokens: sql<number>`coalesce(max(case when ${usageEvents.agentType} = 'main' then cast(${usageEvents.inputTokens} as bigint) + cast(${usageEvents.outputTokens} as bigint) end), 0)::double precision`,
      })
      .from(usageEvents)
      .where(buildUsageEventsWhereClause(userId, options)),
    db
      .select({
        repoOwner: sessions.repoOwner,
        repoName: sessions.repoName,
        prNumber: sessions.prNumber,
        prStatus: sessions.prStatus,
        linesAdded: sessions.linesAdded,
        linesRemoved: sessions.linesRemoved,
        updatedAt: sessions.updatedAt,
      })
      .from(sessions)
      .where(buildSessionsWhereClause(userId, options)),
    db
      .select({
        chatId: chatMessages.chatId,
        role: chatMessages.role,
        parts: chatMessages.parts,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .innerJoin(chats, eq(chats.id, chatMessages.chatId))
      .innerJoin(sessions, eq(sessions.id, chats.sessionId))
      .where(buildAssistantTurnsWhereClause(userId, options))
      .orderBy(
        asc(chatMessages.chatId),
        asc(chatMessages.createdAt),
        asc(chatMessages.id),
      ),
  ]);

  const aggregate = aggregateRows[0] ?? EMPTY_USAGE_AGGREGATE;

  return buildUsageInsights({
    lookbackDays: getLookbackDays(options),
    aggregate,
    sessions: sessionRows as UsageSessionInsightRow[],
    assistantTurns: assistantTurnRows as UsageAssistantTurnRow[],
  });
}
