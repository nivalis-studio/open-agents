import { describe, expect, test } from "bun:test";

import {
  buildGitHubAuthRemoteUrl,
  buildGitHubRepoUrl,
  isValidGitHubRepoName,
  isValidGitHubRepoOwner,
  parseGitHubRepoUrl,
} from "./repo-identifiers";

describe("repo-identifiers", () => {
  test("accepts safe GitHub owner and repo segments", () => {
    expect(isValidGitHubRepoOwner("vercel")).toBe(true);
    expect(isValidGitHubRepoOwner("vercel-labs")).toBe(true);
    expect(isValidGitHubRepoName("open-harness")).toBe(true);
    expect(isValidGitHubRepoName("open_harness.v2")).toBe(true);
  });

  test("rejects unsafe GitHub owner and repo segments", () => {
    expect(isValidGitHubRepoOwner('vercel" && echo nope && "')).toBe(false);
    expect(isValidGitHubRepoName("open harness")).toBe(false);
  });

  test("builds encoded GitHub repository URLs for valid coordinates", () => {
    expect(buildGitHubRepoUrl({ owner: "vercel", repo: "open-harness" })).toBe(
      "https://github.com/vercel/open-harness",
    );
    expect(
      buildGitHubRepoUrl({
        owner: "vercel",
        repo: "open-harness",
        withGitSuffix: true,
      }),
    ).toBe("https://github.com/vercel/open-harness.git");
  });

  test("parses canonical GitHub repository URLs", () => {
    expect(parseGitHubRepoUrl("https://github.com/vercel/ai.git")).toEqual({
      owner: "vercel",
      repo: "ai",
      repoUrl: "https://github.com/vercel/ai",
      cloneUrl: "https://github.com/vercel/ai.git",
    });
  });

  test("rejects ambiguous or attacker-controlled GitHub URLs", () => {
    expect(parseGitHubRepoUrl("http://github.com/vercel/ai")).toBeNull();
    expect(
      parseGitHubRepoUrl("https://github.com/vercel/ai?tab=readme"),
    ).toBeNull();
    expect(
      parseGitHubRepoUrl("https://github.com@evil.example/vercel/ai"),
    ).toBeNull();
    expect(
      parseGitHubRepoUrl("https://github.com/vercel/ai/tree/main"),
    ).toBeNull();
  });

  test("builds an encoded auth remote url for valid coordinates", () => {
    expect(
      buildGitHubAuthRemoteUrl({
        token: "ghp token/with?chars",
        owner: "vercel",
        repo: "open-harness",
      }),
    ).toBe(
      "https://x-access-token:ghp%20token%2Fwith%3Fchars@github.com/vercel/open-harness.git",
    );
  });

  test("returns null when the owner or repo is unsafe", () => {
    expect(
      buildGitHubAuthRemoteUrl({
        token: "ghp_test",
        owner: 'vercel" && echo nope && "',
        repo: "open-harness",
      }),
    ).toBeNull();
    expect(
      buildGitHubRepoUrl({
        owner: "vercel",
        repo: "open harness",
      }),
    ).toBeNull();
  });
});
