import crypto from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "./client";
import { apiRequestLogs } from "./schema";

export type ApiRateLimitAction =
  | "chat-workflow-start"
  | "generate-pr"
  | "sandbox-create";

export interface ApiRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export async function consumeUserRateLimit(params: {
  userId: string;
  action: ApiRateLimitAction;
  maxRequests: number;
  windowMs: number;
}): Promise<ApiRateLimitResult> {
  const { userId, action, maxRequests, windowMs } = params;
  const windowStart = new Date(Date.now() - windowMs);

  return db.transaction(async (tx) => {
    const [result] = await tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(apiRequestLogs)
      .where(
        and(
          eq(apiRequestLogs.userId, userId),
          eq(apiRequestLogs.action, action),
          gte(apiRequestLogs.createdAt, windowStart),
        ),
      );

    if ((result?.count ?? 0) >= maxRequests) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)),
      };
    }

    await tx.insert(apiRequestLogs).values({
      id: crypto.randomUUID(),
      userId,
      action,
    });

    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  });
}
