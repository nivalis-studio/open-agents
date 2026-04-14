import { after } from "next/server";
import { z } from "zod";
import {
  deleteSession,
  getSessionById,
  updateSession,
} from "@/lib/db/sessions";
import { archiveSession } from "@/lib/sandbox/archive-session";
import { hasRuntimeSandboxState } from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";

const updateSessionRequestSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    status: z.enum(["running", "completed", "failed", "archived"]).optional(),
    linesAdded: z.number().int().nonnegative().optional(),
    linesRemoved: z.number().int().nonnegative().optional(),
    prNumber: z.number().int().nonnegative().optional(),
    prStatus: z.enum(["open", "merged", "closed"]).optional(),
  })
  .strict();

type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { sessionId } = await params;
  const existingSession = await getSessionById(sessionId);

  if (!existingSession) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  if (existingSession.userId !== session.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  return Response.json({ session: existingSession });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { sessionId } = await params;
  const existingSession = await getSessionById(sessionId);

  if (!existingSession) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  if (existingSession.userId !== session.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsedBody = updateSessionRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return Response.json(
      { error: "Invalid session update payload" },
      { status: 400 },
    );
  }

  const requestBody = parsedBody.data;

  const shouldStopSandboxAfterArchive =
    requestBody.status === "archived" && existingSession.status !== "archived";

  const shouldUnarchive =
    requestBody.status === "running" && existingSession.status === "archived";

  if (
    shouldUnarchive &&
    !existingSession.snapshotUrl &&
    hasRuntimeSandboxState(existingSession.sandboxState)
  ) {
    return Response.json(
      {
        error:
          "Sandbox is still being paused for this archived session. Please try unarchiving again in a few seconds.",
      },
      { status: 409 },
    );
  }

  const updatePayload: UpdateSessionRequest &
    Partial<{
      lifecycleState: "archived" | null;
      lifecycleError: null;
      sandboxExpiresAt: null;
      hibernateAfter: null;
    }> = { ...requestBody };

  if (shouldUnarchive) {
    // Reset lifecycle state so the session can be resumed normally.
    // If there is saved sandbox state, the client will surface Resume again.
    updatePayload.lifecycleState = null;
    updatePayload.lifecycleError = null;
  }

  const updatedSession = shouldStopSandboxAfterArchive
    ? (
        await archiveSession(sessionId, {
          currentSession: existingSession,
          update: updatePayload,
          logPrefix: "[Sessions]",
          scheduleBackgroundWork: after,
        })
      ).session
    : await updateSession(sessionId, updatePayload);

  if (!updatedSession) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  return Response.json({ session: updatedSession });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { sessionId } = await params;
  const existingSession = await getSessionById(sessionId);

  if (!existingSession) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  if (existingSession.userId !== session.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await deleteSession(sessionId);
  return Response.json({ success: true });
}
