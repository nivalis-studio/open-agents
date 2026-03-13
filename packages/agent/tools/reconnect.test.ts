import { beforeEach, describe, expect, mock, test } from "bun:test";

let connectCalls: Array<Record<string, unknown>> = [];
let execCalls: Array<{ command: string; cwd: string; timeoutMs: number }> = [];

const sandbox = {
  type: "cloud" as const,
  workingDirectory: "/repo",
  access: async (_filePath: string) => {},
  stat: async (_filePath: string) => ({
    isDirectory: () => false,
    isFile: () => true,
    size: 4,
    mtimeMs: Date.now(),
  }),
  readFile: async (_filePath: string, _encoding: BufferEncoding) => "text",
  writeFile: async (
    _filePath: string,
    _content: string,
    _encoding: BufferEncoding,
  ) => {},
  mkdir: async (_dirPath: string, _options?: { recursive?: boolean }) => {},
  readdir: async () => [],
  exec: async (command: string, cwd: string, timeoutMs: number) => {
    execCalls.push({ command, cwd, timeoutMs });
    return {
      success: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      truncated: false,
    };
  },
  stop: async () => {},
};

mock.module("@open-harness/sandbox", () => ({
  connectSandbox: async (state: Record<string, unknown>) => {
    connectCalls.push(state);
    return sandbox;
  },
}));

const utilsModulePromise = import("./utils");
const readModulePromise = import("./read");
const bashModulePromise = import("./bash");

function executionOptions(experimental_context?: unknown) {
  return {
    toolCallId: "tool-call-1",
    messages: [],
    experimental_context,
  };
}

function createSerializableContext() {
  return {
    sandboxId: "sandbox-1",
    sandboxType: "vercel" as const,
    workingDirectory: "/repo",
    approval: {
      type: "delegated" as const,
    },
    model: {
      modelId: "anthropic/claude-haiku-4.5",
    },
  };
}

describe("sandbox reconnection", () => {
  beforeEach(async () => {
    connectCalls = [];
    execCalls = [];
    const { clearSandboxCache } = await utilsModulePromise;
    clearSandboxCache();
  });

  test("getSandbox reconnects lazily from sandboxId and caches by sandbox id", async () => {
    const { getSandbox } = await utilsModulePromise;
    const context = createSerializableContext();

    const firstSandbox = await getSandbox(context, "read");
    const secondSandbox = await getSandbox(context, "write");

    expect(firstSandbox).toBe(sandbox);
    expect(secondSandbox).toBe(sandbox);
    expect(connectCalls).toEqual([
      {
        type: "vercel",
        sandboxId: "sandbox-1",
      },
    ]);
  });

  test("readFileTool reconnects from sandboxId before reading", async () => {
    const { readFileTool } = await readModulePromise;
    const result = await readFileTool().execute?.(
      { filePath: "notes.txt" },
      executionOptions(createSerializableContext()),
    );

    expect(connectCalls).toHaveLength(1);
    expect(result).toEqual({
      success: true,
      path: "notes.txt",
      totalLines: 1,
      startLine: 1,
      endLine: 1,
      content: "1: text",
    });
  });

  test("bashTool reconnects from sandboxId before executing commands", async () => {
    const { bashTool } = await bashModulePromise;
    const result = await bashTool().execute?.(
      { command: "ls" },
      executionOptions(createSerializableContext()),
    );

    expect(connectCalls).toHaveLength(1);
    expect(execCalls).toEqual([
      {
        command: "ls",
        cwd: "/repo",
        timeoutMs: 120000,
      },
    ]);
    expect(result).toEqual({
      success: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
  });
});
