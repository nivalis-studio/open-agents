import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

interface TestSessionRecord {
  id: string;
  userId: string;
  title: string;
  cloneUrl: string;
  repoOwner: string;
  repoName: string;
  sandboxState: {
    type: "vercel";
    sandboxId: string;
  };
}

interface TestChatRecord {
  sessionId: string;
  modelId: string | null;
  activeStreamId: string | null;
}

const autoCommitCalls: Array<Record<string, unknown>> = [];
const backgroundTasks: Promise<void>[] = [];
const fetchCalls: string[] = [];
const compareAndSetCalls: Array<[string, string | null, string | null]> = [];

interface WorkflowApiMockState {
  startCalls: unknown[];
  getReadableCalls: Array<{ startIndex?: number }>;
  cancelCalls: string[];
  shouldThrowOnGetRun: boolean;
  workflowResult: {
    persisted: boolean;
    naturalFinish: boolean;
    autoCommitEligible: boolean;
  };
}

function getWorkflowApiMockState(): WorkflowApiMockState {
  const existing = Reflect.get(globalThis, "__workflowApiMockState");
  if (existing) {
    return existing as WorkflowApiMockState;
  }

  const initialState: WorkflowApiMockState = {
    startCalls: [],
    getReadableCalls: [],
    cancelCalls: [],
    shouldThrowOnGetRun: false,
    workflowResult: {
      persisted: true,
      naturalFinish: true,
      autoCommitEligible: true,
    },
  };
  Reflect.set(globalThis, "__workflowApiMockState", initialState);
  return initialState;
}

let sessionRecord: TestSessionRecord;
let chatRecord: TestChatRecord;

const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetchCalls.push(String(input));
  return new Response("{}", {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}) as typeof fetch;

mock.module("next/server", () => ({
  after: (task: Promise<unknown>) => {
    backgroundTasks.push(Promise.resolve(task).then(() => undefined));
  },
}));

mock.module("workflow/api", () => ({
  start: async (_workflow: unknown, args: unknown[]) => {
    const state = getWorkflowApiMockState();
    state.startCalls.push(args[0]);
    return {
      runId: "workflow-run-1",
      readable: new ReadableStream(),
      returnValue: Promise.resolve(state.workflowResult),
    };
  },
  getRun: (_runId: string) => {
    const state = getWorkflowApiMockState();
    if (state.shouldThrowOnGetRun) {
      throw new Error("missing-run");
    }

    return {
      getReadable: (options: { startIndex?: number }) => {
        state.getReadableCalls.push(options);
        return new ReadableStream();
      },
      cancel: async () => {
        state.cancelCalls.push(_runId);
      },
    };
  },
}));

mock.module("@/app/workflows/chat", () => ({
  chatWorkflow: async () => {},
}));

mock.module("@/lib/db/sessions", () => ({
  compareAndSetChatActiveStreamId: async (
    chatId: string,
    expected: string | null,
    next: string | null,
  ) => {
    compareAndSetCalls.push([chatId, expected, next]);
    return true;
  },
  createChatMessageIfNotExists: async () => undefined,
  getChatById: async () => chatRecord,
  getSessionById: async () => sessionRecord,
  isFirstChatMessage: async () => false,
  touchChat: async () => {},
  updateChat: async () => {},
  updateSession: async (
    _sessionId: string,
    patch: Record<string, unknown>,
  ) => ({
    ...sessionRecord,
    ...patch,
  }),
}));

mock.module("@/lib/db/user-preferences", () => ({
  getUserPreferences: async () => ({
    autoCommitPush: true,
    modelVariants: [],
  }),
}));

mock.module("@/lib/chat-auto-commit", () => ({
  runAutoCommitInBackground: async (params: Record<string, unknown>) => {
    autoCommitCalls.push(params);
  },
}));

mock.module("@/lib/model-variants", () => ({
  resolveModelSelection: (modelId: string) => ({
    isMissingVariant: false,
    resolvedModelId: modelId,
    providerOptionsByProvider: undefined,
  }),
}));

mock.module("@/lib/models", () => ({
  DEFAULT_MODEL_ID: "mock-model",
}));

mock.module("@/lib/sandbox/lifecycle", () => ({
  buildActiveLifecycleUpdate: () => ({}),
}));

mock.module("@/lib/sandbox/utils", () => ({
  isSandboxActive: () => true,
}));

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => ({
    user: {
      id: "user-1",
    },
  }),
}));

async function importRouteModule() {
  return import(`./route?test=${Math.random()}`);
}

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("/api/chat workflow execution", () => {
  beforeEach(() => {
    const workflowApiState = getWorkflowApiMockState();

    autoCommitCalls.length = 0;
    backgroundTasks.length = 0;
    fetchCalls.length = 0;
    compareAndSetCalls.length = 0;
    workflowApiState.startCalls.length = 0;
    workflowApiState.getReadableCalls.length = 0;
    workflowApiState.cancelCalls.length = 0;
    workflowApiState.shouldThrowOnGetRun = false;
    workflowApiState.workflowResult = {
      persisted: true,
      naturalFinish: true,
      autoCommitEligible: true,
    };

    sessionRecord = {
      id: "session-1",
      userId: "user-1",
      title: "Session title",
      cloneUrl: "https://github.com/acme/repo.git",
      repoOwner: "acme",
      repoName: "repo",
      sandboxState: {
        type: "vercel",
        sandboxId: "sandbox-1",
      },
    };

    chatRecord = {
      sessionId: "session-1",
      modelId: null,
      activeStreamId: null,
    };
  });

  test("starts a workflow, stores active stream ownership, and returns the run id header", async () => {
    const { POST } = await importRouteModule();

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: "session=abc",
        },
        body: JSON.stringify({
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
      }),
    );

    await Promise.all(backgroundTasks);

    const workflowApiState = getWorkflowApiMockState();

    expect(response.ok).toBe(true);
    expect(response.headers.get("x-workflow-run-id")).toBe("workflow-run-1");
    expect(workflowApiState.startCalls).toHaveLength(1);
    expect(workflowApiState.startCalls[0]).toMatchObject({
      userId: "user-1",
      sessionId: "session-1",
      chatId: "chat-1",
      repoOwner: "acme",
      repoName: "repo",
    });
    expect(workflowApiState.startCalls[0]).toSatisfy(
      (value: unknown) =>
        typeof value === "object" &&
        value !== null &&
        typeof Reflect.get(value, "requestStartedAtMs") === "number",
    );

    expect(compareAndSetCalls).toHaveLength(1);
    expect(compareAndSetCalls[0]?.[0]).toBe("chat-1");
    expect(compareAndSetCalls[0]?.[1]).toBeNull();
    expect(compareAndSetCalls[0]?.[2]).toSatisfy(
      (value: unknown) =>
        typeof value === "string" && value.endsWith(":workflow-run-1"),
    );

    expect(autoCommitCalls).toHaveLength(1);
    expect(autoCommitCalls[0]).toMatchObject({
      sessionId: "session-1",
      sessionTitle: "Session title",
      repoOwner: "acme",
      repoName: "repo",
    });
    expect(fetchCalls).toEqual([
      "http://localhost/api/sessions/session-1/diff",
    ]);
  });

  test("skips follow-up side effects when the workflow does not finish naturally", async () => {
    getWorkflowApiMockState().workflowResult = {
      persisted: false,
      naturalFinish: false,
      autoCommitEligible: false,
    };

    const { POST } = await importRouteModule();

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: "session=abc",
        },
        body: JSON.stringify({
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
      }),
    );

    await Promise.all(backgroundTasks);

    expect(response.ok).toBe(true);
    expect(autoCommitCalls).toHaveLength(0);
    expect(fetchCalls).toEqual([]);
  });
});
