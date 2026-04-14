const GITHUB_REPO_PATH_SEGMENT_PATTERN = /^[.\w-]+$/;
const GITHUB_HOSTNAME = "github.com";

export interface ParsedGitHubRepoUrl {
  owner: string;
  repo: string;
  repoUrl: string;
  cloneUrl: string;
}

export function isValidGitHubRepoOwner(owner: string): boolean {
  return GITHUB_REPO_PATH_SEGMENT_PATTERN.test(owner);
}

export function isValidGitHubRepoName(repoName: string): boolean {
  return GITHUB_REPO_PATH_SEGMENT_PATTERN.test(repoName);
}

export function buildGitHubRepoUrl(params: {
  owner: string;
  repo: string;
  withGitSuffix?: boolean;
}): string | null {
  const { owner, repo, withGitSuffix = false } = params;

  if (!isValidGitHubRepoOwner(owner) || !isValidGitHubRepoName(repo)) {
    return null;
  }

  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  return `https://${GITHUB_HOSTNAME}/${encodedOwner}/${encodedRepo}${withGitSuffix ? ".git" : ""}`;
}

export function parseGitHubRepoUrl(
  repoUrl: string,
): ParsedGitHubRepoUrl | null {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== GITHUB_HOSTNAME ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }

  const pathSegments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (pathSegments.length !== 2) {
    return null;
  }

  const [owner, repoSegment] = pathSegments;
  const repo = repoSegment?.endsWith(".git")
    ? repoSegment.slice(0, -4)
    : repoSegment;

  if (
    !owner ||
    !repo ||
    !isValidGitHubRepoOwner(owner) ||
    !isValidGitHubRepoName(repo)
  ) {
    return null;
  }

  const normalizedRepoUrl = buildGitHubRepoUrl({ owner, repo });
  const normalizedCloneUrl = buildGitHubRepoUrl({
    owner,
    repo,
    withGitSuffix: true,
  });
  if (!normalizedRepoUrl || !normalizedCloneUrl) {
    return null;
  }

  return {
    owner,
    repo,
    repoUrl: normalizedRepoUrl,
    cloneUrl: normalizedCloneUrl,
  };
}

export function buildGitHubAuthRemoteUrl(params: {
  token: string;
  owner: string;
  repo: string;
}): string | null {
  const { token, owner, repo } = params;
  const remoteUrl = buildGitHubRepoUrl({ owner, repo, withGitSuffix: true });

  if (!remoteUrl) {
    return null;
  }

  return remoteUrl.replace(
    "https://",
    `https://x-access-token:${encodeURIComponent(token)}@`,
  );
}
