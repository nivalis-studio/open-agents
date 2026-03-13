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

const clearedActiveStreamIds: Array<[string, string | null]> = [];

let sessionRecord: TestSessionRecord;
let chatRecord: TestChatRecord;

mock.module("workflow/api", () => ({
  start: async () => ({
    runId: "workflow-run-1",
    readable: new ReadableStream(),
    returnValue: Promise.resolve(getWorkflowApiMockState().workflowResult),
  }),
  getRun: (_runId: string) => ({
    getReadable: () => new ReadableStream(),
    cancel: async () => {
      getWorkflowApiMockState().cancelCalls.push(_runId);
    },
  }),
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

describe("/api/chat/[chatId]/stop", () => {
  beforeEach(() => {
    const workflowApiState = getWorkflowApiMockState();
    workflowApiState.cancelCalls.length = 0;
    clearedActiveStreamIds.length = 0;

    sessionRecord = {
      id: "session-1",
      userId: "user-1",
    };

    chatRecord = {
      id: "chat-1",
      sessionId: "session-1",
      activeStreamId: "123456:workflow-run-1",
    };
  });

  test("cancels the active workflow run and clears the chat stream id", async () => {
    const { POST } = await importRouteModule();

    const response = await POST(
      new Request("http://localhost/api/chat/chat-1/stop"),
      {
        params: Promise.resolve({ chatId: "chat-1" }),
      },
    );

    expect(response.ok).toBe(true);
    expect(getWorkflowApiMockState().cancelCalls).toEqual(["workflow-run-1"]);
    expect(clearedActiveStreamIds).toEqual([["chat-1", null]]);
  });

  test("returns success without cancelling when there is no active stream", async () => {
    chatRecord.activeStreamId = null;
    const { POST } = await importRouteModule();

    const response = await POST(
      new Request("http://localhost/api/chat/chat-1/stop"),
      {
        params: Promise.resolve({ chatId: "chat-1" }),
      },
    );

    expect(response.ok).toBe(true);
    expect(getWorkflowApiMockState().cancelCalls).toEqual([]);
    expect(clearedActiveStreamIds).toEqual([]);
  });
});
