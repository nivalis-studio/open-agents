import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const getCalls: Array<{ sandboxId: string }> = [];

mock.module("@vercel/sandbox", () => ({
  Sandbox: {
    create: async () => ({
      sandboxId: "sbx-created",
      routes: [],
      domain: (_port: number) => "https://sbx-created.vercel.run",
      runCommand: async () => ({
        cmdId: "cmd-1",
        exitCode: 0,
        stdout: async () => "",
        wait: async () => ({
          exitCode: 0,
          stdout: async () => "",
          stderr: async () => "",
        }),
      }),
      writeFiles: async (_files: { path: string; content: Buffer }[]) => {},
      readFileToBuffer: async (_opts: { path: string }) => Buffer.from(""),
      snapshot: async () => ({ snapshotId: "snap-1" }),
      stop: async () => {},
      extendTimeout: async (_duration: number) => {},
    }),
    get: async ({ sandboxId }: { sandboxId: string }) => {
      getCalls.push({ sandboxId });
      return {
        sandboxId,
        routes: [],
        domain: (_port: number) => "https://sbx-test.vercel.run",
        runCommand: async () => ({
          cmdId: "cmd-1",
          exitCode: 0,
          stdout: async () => "",
          wait: async () => ({
            exitCode: 0,
            stdout: async () => "",
            stderr: async () => "",
          }),
        }),
        writeFiles: async (_files: { path: string; content: Buffer }[]) => {},
        readFileToBuffer: async (_opts: { path: string }) => Buffer.from(""),
        snapshot: async () => ({ snapshotId: "snap-1" }),
        stop: async () => {},
        extendTimeout: async (_duration: number) => {},
      };
    },
  },
}));

let connectModule: typeof import("./connect");
const originalOidcToken = process.env.VERCEL_OIDC_TOKEN;

function createFakeOidcToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ owner_id: "team_test", project_id: "prj_test" }),
    "utf-8",
  ).toString("base64url");

  return `header.${payload}.signature`;
}

beforeAll(async () => {
  connectModule = await import("./connect");
});

beforeEach(() => {
  getCalls.length = 0;
});

afterEach(() => {
  if (originalOidcToken) {
    process.env.VERCEL_OIDC_TOKEN = originalOidcToken;
    return;
  }

  delete process.env.VERCEL_OIDC_TOKEN;
});

describe("connectVercel reconnect mode", () => {
  test("uses stateless adapter when VERCEL_OIDC_TOKEN is present", async () => {
    process.env.VERCEL_OIDC_TOKEN = createFakeOidcToken();

    const sandbox = await connectModule.connectVercel({
      sandboxId: "sbx-stateless",
    });

    expect(sandbox.type).toBe("cloud");
    expect("id" in sandbox).toBeTrue();
    if ("id" in sandbox) {
      expect(sandbox.id).toBe("sbx-stateless");
    }
    expect(getCalls).toHaveLength(0);
  });

  test("falls back to SDK reconnect when OIDC token is absent", async () => {
    delete process.env.VERCEL_OIDC_TOKEN;

    const sandbox = await connectModule.connectVercel({
      sandboxId: "sbx-stateful",
    });

    expect(sandbox.type).toBe("cloud");
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0]?.sandboxId).toBe("sbx-stateful");
  });
});
