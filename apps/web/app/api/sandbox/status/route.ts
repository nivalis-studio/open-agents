import {
  requireAuthenticatedUser,
  requireOwnedSession,
} from "@/app/api/sessions/_lib/session-context";
import { updateSession } from "@/lib/db/sessions";
import { SANDBOX_EXPIRES_BUFFER_MS } from "@/lib/sandbox/config";
import {
  getLifecycleDueAtMs,
  getSandboxExpiresAtDate,
} from "@/lib/sandbox/lifecycle";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import {
  hasRuntimeSandboxState,
  hasSandboxIdentity,
} from "@/lib/sandbox/utils";

export type SandboxStatusResponse = {
  status: "active" | "no_sandbox";
  hasSnapshot: boolean;
  lifecycleVersion: number;
  lifecycle: {
    serverTime: number;
    state: string | null;
    lastActivityAt: number | null;
    hibernateAfter: number | null;
    sandboxExpiresAt: number | null;
  };
};

function isLifecycleActiveState(state: string | null): boolean {
  return (
    state === "active" || state === "provisioning" || state === "restoring"
  );
}

function isSessionExpired(record: { sandboxExpiresAt: Date | null }): boolean {
  if (!record.sandboxExpiresAt) {
    return false;
  }

  return (
    Date.now() >= record.sandboxExpiresAt.getTime() - SANDBOX_EXPIRES_BUFFER_MS
  );
}

export async function GET(req: Request): Promise<Response> {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const sessionContext = await requireOwnedSession({
    userId: authResult.userId,
    sessionId,
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;
  let effectiveSessionRecord = sessionRecord;

  const runtimeSandboxExpiresAt = getSandboxExpiresAtDate(
    sessionRecord.sandboxState,
  );
  const hasRecoverableFailedLifecycle =
    sessionRecord.lifecycleState === "failed" &&
    hasRuntimeSandboxState(sessionRecord.sandboxState) &&
    !isSessionExpired({ sandboxExpiresAt: runtimeSandboxExpiresAt });

  // If the lifecycle evaluator previously failed but runtime state is still
  // active, recover lifecycle state so UI does not get stuck in "Paused".
  if (hasRecoverableFailedLifecycle) {
    const recoveredSession = await updateSession(sessionRecord.id, {
      lifecycleState: "active",
      lifecycleError: null,
      sandboxExpiresAt: getSandboxExpiresAtDate(sessionRecord.sandboxState),
    });
    if (recoveredSession) {
      effectiveSessionRecord = recoveredSession;
    }
  }

  const effectiveIsExpired = isSessionExpired(effectiveSessionRecord);
  const effectiveHasRuntimeState = hasRuntimeSandboxState(
    effectiveSessionRecord.sandboxState,
  );
  const effectiveHasIdentity = hasSandboxIdentity(
    effectiveSessionRecord.sandboxState,
  );
  const effectiveIsActive =
    isLifecycleActiveState(effectiveSessionRecord.lifecycleState) &&
    !effectiveIsExpired &&
    (effectiveHasRuntimeState ||
      (effectiveHasIdentity &&
        effectiveSessionRecord.lifecycleState !== "active"));

  // Safety net: if the sandbox has stale runtime state (expired or overdue for
  // hibernation), kick the lifecycle to clean up DB state in the background.
  if (effectiveSessionRecord.lifecycleState === "active") {
    const now = Date.now();
    const dueAtMs = getLifecycleDueAtMs(effectiveSessionRecord);
    if (effectiveIsExpired || now >= dueAtMs) {
      kickSandboxLifecycleWorkflow({
        sessionId: effectiveSessionRecord.id,
        reason: "status-check-overdue",
      });
    }
  }

  return Response.json({
    status: effectiveIsActive ? "active" : "no_sandbox",
    hasSnapshot: !!effectiveSessionRecord.snapshotUrl,
    lifecycleVersion: effectiveSessionRecord.lifecycleVersion,
    lifecycle: {
      serverTime: Date.now(),
      state: effectiveSessionRecord.lifecycleState,
      lastActivityAt: effectiveSessionRecord.lastActivityAt?.getTime() ?? null,
      hibernateAfter: effectiveSessionRecord.hibernateAfter?.getTime() ?? null,
      sandboxExpiresAt:
        effectiveSessionRecord.sandboxExpiresAt?.getTime() ?? null,
    },
  } satisfies SandboxStatusResponse);
}
