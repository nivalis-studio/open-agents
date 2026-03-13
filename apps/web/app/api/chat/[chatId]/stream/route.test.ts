import { beforeEach, describe, expect, mock, test } from "bun:test";

interface TestSessionRecord {
  id: string;
  userId: string;
}

interface TestChatRecord {
  id: string;
  sessionId: string;
  activeStreamId: string | null;
}

const backgroundTasks: Promise<void>[] = [];
const clearedActiveStreamIds: Array<[string, string | null]> = [];

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

mock.module("next/server", () => ({
  after: (task: Promise<unknown> | (() => Promise<unknown>)) => {
    const promise = typeof task === "function" ? task() : task;
    backgroundTasks.push(Promise.resolve(promise).then(() => undefined));
  },
}));

mock.module("ai", () => ({
  createUIMessageStreamResponse: ({ stream }: { stream: ReadableStream }) =>
    new Response(stream, { status: 200 }),
}));

mock.module("workflow/api", () => ({
  start: async () => ({
    runId: "workflow-run-1",
    readable: new ReadableStream(),
    returnValue: Promise.resolve(getWorkflowApiMockState().workflowResult),
  }),
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

mock.module("@/lib/db/sessions", () => ({
  getChatById: async () => chatRecord,
  getSessionById: async () => sessionRecord,
  updateChatActiveStreamId: async (chatId: string, value: string | null) => {
    clearedActiveStreamIds.push([chatId, value]);
  },
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

describe("/api/chat/[chatId]/stream", () => {
  beforeEach(() => {
    const workflowApiState = getWorkflowApiMockState();

    backgroundTasks.length = 0;
    workflowApiState.startCalls.length = 0;
    workflowApiState.getReadableCalls.length = 0;
    workflowApiState.cancelCalls.length = 0;
    workflowApiState.shouldThrowOnGetRun = false;
    clearedActiveStreamIds.length = 0;

    sessionRecord = {
      id: "session-1",
      userId: "user-1",
    };

    chatRecord = {
      id: "chat-1",
      sessionId: "session-1",
      activeStreamId: null,
    };
  });

  test("returns 204 when the chat has no active workflow run", async () => {
    const { GET } = await importRouteModule();

    const response = await GET(
      new Request("http://localhost/api/chat/chat-1/stream"),
      {
        params: Promise.resolve({ chatId: "chat-1" }),
      },
    );

    expect(response.status).toBe(204);
    expect(getWorkflowApiMockState().getReadableCalls).toEqual([]);
  });

  test("resumes the active workflow stream with the provided startIndex", async () => {
    chatRecord.activeStreamId = "123456:workflow-run-1";
    const { GET } = await importRouteModule();

    const response = await GET(
      new Request("http://localhost/api/chat/chat-1/stream?startIndex=7"),
      {
        params: Promise.resolve({ chatId: "chat-1" }),
      },
    );

    expect(response.ok).toBe(true);
    expect(getWorkflowApiMockState().getReadableCalls).toEqual([
      { startIndex: 7 },
    ]);
  });

  test("clears stale active stream ids when the workflow run cannot be resumed", async () => {
    getWorkflowApiMockState().shouldThrowOnGetRun = true;
    chatRecord.activeStreamId = "123456:workflow-run-1";
    const { GET } = await importRouteModule();

    const response = await GET(
      new Request("http://localhost/api/chat/chat-1/stream?startIndex=3"),
      {
        params: Promise.resolve({ chatId: "chat-1" }),
      },
    );

    await Promise.all(backgroundTasks);

    expect(response.status).toBe(204);
    expect(clearedActiveStreamIds).toEqual([["chat-1", null]]);
  });
});
