import { beforeEach, describe, expect, mock, test } from "bun:test";

interface TestSessionRecord {
  id: string;
  userId: string;
  sandboxState: {
    type: "vercel";
  } | null;
}

interface TestChatRecord {
  sessionId: string;
  modelId: string | null;
  activeStreamId: string | null;
}

const scheduleLatestMessagePersistenceCalls: Array<{
  chatId: string;
  messages: unknown[];
}> = [];
const updateSessionCalls: Array<{
  sessionId: string;
  patch: Record<string, unknown>;
}> = [];
const startCalls: Array<{
  workflow: unknown;
  args: unknown[];
}> = [];
let sessionRecord: TestSessionRecord | null;
let chatRecord: TestChatRecord | null;
let currentAuthSession: { user: { id: string } } | null;
let sandboxIsActive = true;
let workflowStartRunId = "workflow-run-1";
let preferences: {
  defaultSubagentModelId?: string;
  modelVariants?: unknown[];
} | null = { modelVariants: [] };

const mockChatWorkflow = async () => undefined;

mock.module("ai", () => ({
  createUIMessageStreamResponse: ({ headers }: { headers?: HeadersInit }) =>
    new Response("ok", {
      status: 200,
      headers,
    }),
}));

mock.module("workflow/api", () => ({
  start: async (workflow: unknown, args: unknown[]) => {
    startCalls.push({ workflow, args });
    return {
      runId: workflowStartRunId,
      readable: new ReadableStream(),
    };
  },
}));

mock.module("@/app/workflows/chat", () => ({
  chatWorkflow: mockChatWorkflow,
}));

mock.module("@/lib/db/sessions", () => ({
  compareAndSetChatActiveStreamId: async () => true,
  getChatById: async () => chatRecord,
  getSessionById: async () => sessionRecord,
  updateSession: async (sessionId: string, patch: Record<string, unknown>) => {
    updateSessionCalls.push({ sessionId, patch });
    return patch;
  },
}));

mock.module("@/lib/db/user-preferences", () => ({
  getUserPreferences: async () => preferences,
}));

mock.module("@/lib/sandbox/lifecycle", () => ({
  buildActiveLifecycleUpdate: () => ({ lifecycleState: "active" }),
}));

mock.module("@/lib/sandbox/utils", () => ({
  isSandboxActive: () => sandboxIsActive,
}));

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => currentAuthSession,
}));

mock.module("./_lib/message-persistence", () => ({
  persistAssistantMessageFromStream: async () => undefined,
  scheduleLatestMessagePersistence: (chatId: string, messages: unknown[]) => {
    scheduleLatestMessagePersistenceCalls.push({ chatId, messages });
    return null;
  },
}));

const routeModulePromise = import("./route");

function createRequest(body: string) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
}

function createValidRequest() {
  return createRequest(
    JSON.stringify({
      sessionId: "session-1",
      chatId: "chat-1",
      messages: [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Fix the bug" }],
        },
      ],
    }),
  );
}

describe("/api/chat route", () => {
  beforeEach(() => {
    scheduleLatestMessagePersistenceCalls.length = 0;
    updateSessionCalls.length = 0;
    startCalls.length = 0;
    sandboxIsActive = true;
    workflowStartRunId = "workflow-run-1";
    currentAuthSession = {
      user: {
        id: "user-1",
      },
    };
    preferences = { modelVariants: [] };
    sessionRecord = {
      id: "session-1",
      userId: "user-1",
      sandboxState: {
        type: "vercel",
      },
    };
    chatRecord = {
      sessionId: "session-1",
      modelId: null,
      activeStreamId: null,
    };
  });

  test("starts the durable chat workflow for a valid request", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(createValidRequest());

    expect(response.ok).toBe(true);
    expect(response.headers.get("x-workflow-run-id")).toBe("workflow-run-1");
    expect(scheduleLatestMessagePersistenceCalls).toEqual([
      {
        chatId: "chat-1",
        messages: [
          {
            id: "user-1",
            role: "user",
            parts: [{ type: "text", text: "Fix the bug" }],
          },
        ],
      },
    ]);
    expect(updateSessionCalls).toEqual([
      {
        sessionId: "session-1",
        patch: { lifecycleState: "active" },
      },
    ]);
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]).toMatchObject({
      workflow: mockChatWorkflow,
      args: [
        {
          userId: "user-1",
          sessionId: "session-1",
          chatId: "chat-1",
          messages: [
            {
              id: "user-1",
              role: "user",
              parts: [{ type: "text", text: "Fix the bug" }],
            },
          ],
          requestStartedAtMs: expect.any(Number),
          model: { id: "anthropic/claude-haiku-4.5" },
        },
      ],
    });
  });

  test("includes the subagent model selection when configured", async () => {
    preferences = {
      modelVariants: [
        {
          id: "variant:subagent-model",
          name: "Subagent model",
          baseModelId: "openai/gpt-5-mini",
          providerOptions: {},
        },
      ],
      defaultSubagentModelId: "variant:subagent-model",
    };

    const { POST } = await routeModulePromise;

    const response = await POST(createValidRequest());

    expect(response.ok).toBe(true);
    expect(startCalls[0]?.args[0]).toMatchObject({
      subagentModel: { id: "openai/gpt-5-mini" },
    });
  });

  test("returns 401 when not authenticated", async () => {
    currentAuthSession = null;
    const { POST } = await routeModulePromise;

    const response = await POST(createValidRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Not authenticated",
    });
  });

  test("returns 400 for invalid JSON body", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(createRequest("{"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid JSON body",
    });
  });

  test("returns 400 when sessionId and chatId are missing", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      createRequest(
        JSON.stringify({
          messages: [
            {
              id: "user-1",
              role: "user",
              parts: [{ type: "text", text: "Fix the bug" }],
            },
          ],
        }),
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "sessionId and chatId are required",
    });
  });

  test("returns 404 when session does not exist", async () => {
    sessionRecord = null;
    const { POST } = await routeModulePromise;

    const response = await POST(createValidRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Session not found",
    });
  });

  test("returns 403 when session is not owned by the user", async () => {
    if (!sessionRecord) {
      throw new Error("sessionRecord must be set");
    }
    sessionRecord.userId = "user-2";

    const { POST } = await routeModulePromise;

    const response = await POST(createValidRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorized",
    });
  });

  test("returns 400 when sandbox is not active", async () => {
    sandboxIsActive = false;
    const { POST } = await routeModulePromise;

    const response = await POST(createValidRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Sandbox not initialized",
    });
  });
});
