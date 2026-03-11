import { afterEach, describe, expect, mock, test } from "bun:test";
import { VercelRestClient } from "./rest-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("VercelRestClient", () => {
  test("kills commands via the cmd endpoint", async () => {
    const fetchMock = mock((input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new VercelRestClient({
      token: "token",
      teamId: "team_test",
    });

    await client.killCommand({
      sandboxId: "sbx-123",
      commandId: "cmd-456",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toBe(
      "https://vercel.com/api/v1/sandboxes/sbx-123/cmd/cmd-456/kill?teamId=team_test",
    );
  });
});
