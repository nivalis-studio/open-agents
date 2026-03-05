import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

interface MockApiResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

const EMPTY_PROJECTS_RESPONSE: MockApiResponse = {
  ok: true,
  status: 200,
  body: { projects: [] },
};

// Track fetch calls
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let teamsApiResponse: MockApiResponse = {
  ok: true,
  status: 200,
  body: { teams: [] },
};
let projectApiResponsesByScope: Record<string, MockApiResponse> = {
  personal: EMPTY_PROJECTS_RESPONSE,
};

function toResponse(response: MockApiResponse): Response {
  return {
    ok: response.ok,
    status: response.status,
    text: async () => JSON.stringify(response.body),
    json: async () => response.body,
  } as Response;
}

async function withSuppressedConsoleError<T>(fn: () => Promise<T>): Promise<T> {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = originalConsoleError;
  }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  fetchCalls.push({ url, init });

  const parsed = new URL(url);

  if (parsed.pathname === "/v2/teams") {
    return toResponse(teamsApiResponse);
  }

  if (parsed.pathname === "/v10/projects") {
    const teamId = parsed.searchParams.get("teamId");
    const slug = parsed.searchParams.get("slug");
    const scopeKey = teamId ?? (slug ? `slug:${slug}` : "personal");
    const response =
      projectApiResponsesByScope[scopeKey] ?? EMPTY_PROJECTS_RESPONSE;
    return toResponse(response);
  }

  return toResponse({
    ok: false,
    status: 404,
    body: { error: "not_found" },
  });
}) as typeof globalThis.fetch;

const { resolveVercelProject } = await import("./project-resolution");

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveVercelProject", () => {
  beforeEach(() => {
    fetchCalls = [];
    teamsApiResponse = { ok: true, status: 200, body: { teams: [] } };
    projectApiResponsesByScope = {
      personal: { ok: true, status: 200, body: { projects: [] } },
    };
  });

  test("returns project_unresolved when no projects match in any scope", async () => {
    teamsApiResponse = {
      ok: true,
      status: 200,
      body: { teams: [{ id: "team_1", slug: "acme" }] },
    };
    projectApiResponsesByScope = {
      personal: { ok: true, status: 200, body: { projects: [] } },
      team_1: { ok: true, status: 200, body: { projects: [] } },
    };

    const result = await resolveVercelProject({
      vercelToken: "tok_test",
      repoOwner: "acme",
      repoName: "app",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("project_unresolved");
    }

    expect(fetchCalls.length).toBe(4);
    expect(fetchCalls[0]!.url).toContain("/v2/teams");
    const personalCall = fetchCalls.find(
      (call) =>
        call.url.includes("/v10/projects") &&
        !call.url.includes("teamId=") &&
        !call.url.includes("slug="),
    );
    expect(personalCall?.url).toContain(
      "repoUrl=https%3A%2F%2Fgithub.com%2Facme%2Fapp",
    );
    expect(personalCall?.init?.headers).toEqual({
      Authorization: "Bearer tok_test",
    });
    const slugCall = fetchCalls.find((call) => call.url.includes("slug=acme"));
    expect(slugCall).toBeDefined();
    const teamCall = fetchCalls.find((call) =>
      call.url.includes("teamId=team_1"),
    );
    expect(teamCall).toBeDefined();
  });

  test("returns project info when exactly one project matches in personal scope", async () => {
    projectApiResponsesByScope.personal = {
      ok: true,
      status: 200,
      body: {
        projects: [
          {
            id: "prj_123",
            name: "my-app",
            accountId: "team_456",
            link: { type: "github", org: "acme", repo: "app" },
          },
        ],
      },
    };

    const result = await resolveVercelProject({
      vercelToken: "tok_test",
      repoOwner: "acme",
      repoName: "app",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.projectId).toBe("prj_123");
      expect(result.project.projectName).toBe("my-app");
      expect(result.project.orgId).toBe("team_456");
      expect(result.project.orgSlug).toBe("acme");
    }
  });

  test("resolves project from team scope when personal scope has no match", async () => {
    teamsApiResponse = {
      ok: true,
      status: 200,
      body: { teams: [{ id: "team_456", slug: "vercel-labs" }] },
    };
    projectApiResponsesByScope = {
      personal: { ok: true, status: 200, body: { projects: [] } },
      team_456: {
        ok: true,
        status: 200,
        body: {
          projects: [
            {
              id: "prj_team",
              name: "open-harness",
              accountId: "team_456",
            },
          ],
        },
      },
    };

    const result = await resolveVercelProject({
      vercelToken: "tok_test",
      repoOwner: "vercel-labs",
      repoName: "open-harness",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.projectId).toBe("prj_team");
      expect(result.project.orgId).toBe("team_456");
      expect(result.project.orgSlug).toBe("vercel-labs");
    }

    const teamCall = fetchCalls.find((call) =>
      call.url.includes("teamId=team_456"),
    );
    expect(teamCall).toBeDefined();
  });

  test("resolves project from owner slug scope without team membership", async () => {
    projectApiResponsesByScope = {
      personal: { ok: true, status: 200, body: { projects: [] } },
      "slug:vercel-labs": {
        ok: true,
        status: 200,
        body: {
          projects: [
            {
              id: "prj_slug",
              name: "open-harness",
              accountId: "team_999",
            },
          ],
        },
      },
    };

    const result = await resolveVercelProject({
      vercelToken: "tok_test",
      repoOwner: "vercel-labs",
      repoName: "open-harness",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.projectId).toBe("prj_slug");
      expect(result.project.orgSlug).toBe("vercel-labs");
    }

    const slugCall = fetchCalls.find((call) =>
      call.url.includes("slug=vercel-labs"),
    );
    expect(slugCall).toBeDefined();
  });

  test("dedupes duplicate project ids across all scopes", async () => {
    teamsApiResponse = {
      ok: true,
      status: 200,
      body: { teams: [{ id: "team_1", slug: "acme" }] },
    };

    projectApiResponsesByScope = {
      personal: {
        ok: true,
        status: 200,
        body: {
          projects: [{ id: "prj_shared", name: "app", accountId: "team_1" }],
        },
      },
      "slug:acme": {
        ok: true,
        status: 200,
        body: {
          projects: [{ id: "prj_shared", name: "app", accountId: "team_1" }],
        },
      },
      team_1: {
        ok: true,
        status: 200,
        body: {
          projects: [{ id: "prj_shared", name: "app", accountId: "team_1" }],
        },
      },
    };

    const result = await resolveVercelProject({
      vercelToken: "tok_test",
      repoOwner: "acme",
      repoName: "app",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.projectId).toBe("prj_shared");
      expect(result.project.orgSlug).toBe("acme");
    }
  });

  test("returns project_ambiguous when multiple unique projects match", async () => {
    teamsApiResponse = {
      ok: true,
      status: 200,
      body: { teams: [{ id: "team_1", slug: "acme" }] },
    };
    projectApiResponsesByScope = {
      personal: {
        ok: true,
        status: 200,
        body: {
          projects: [{ id: "prj_1", name: "app-1", accountId: "team_1" }],
        },
      },
      team_1: {
        ok: true,
        status: 200,
        body: {
          projects: [{ id: "prj_2", name: "app-2", accountId: "team_1" }],
        },
      },
    };

    const result = await resolveVercelProject({
      vercelToken: "tok_test",
      repoOwner: "acme",
      repoName: "app",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("project_ambiguous");
      expect(result.message).toContain("2");
    }
  });

  test("returns api_error when all project lookups fail", async () => {
    projectApiResponsesByScope = {
      personal: {
        ok: false,
        status: 403,
        body: { error: "forbidden" },
      },
      "slug:acme": {
        ok: false,
        status: 403,
        body: { error: "forbidden" },
      },
    };

    const result = await withSuppressedConsoleError(() =>
      resolveVercelProject({
        vercelToken: "tok_bad",
        repoOwner: "acme",
        repoName: "app",
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("api_error");
      expect(result.message).toContain("403");
    }
  });

  test("returns api_error on network failure", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = await withSuppressedConsoleError(() =>
        resolveVercelProject({
          vercelToken: "tok_test",
          repoOwner: "acme",
          repoName: "app",
        }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("api_error");
        expect(result.message).toContain("network down");
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handles project without link/org gracefully", async () => {
    projectApiResponsesByScope.personal = {
      ok: true,
      status: 200,
      body: {
        projects: [
          {
            id: "prj_solo",
            name: "solo-app",
            accountId: "user_789",
          },
        ],
      },
    };

    const result = await resolveVercelProject({
      vercelToken: "tok_test",
      repoOwner: "user",
      repoName: "solo-app",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.projectId).toBe("prj_solo");
      expect(result.project.orgId).toBe("user_789");
      expect(result.project.orgSlug).toBeUndefined();
    }
  });
});
