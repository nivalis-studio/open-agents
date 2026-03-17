import { getSessionById } from "@/lib/db/sessions";

export type ActiveSessionRecord = NonNullable<
  Awaited<ReturnType<typeof getSessionById>>
> & {
  sandboxState: NonNullable<
    NonNullable<Awaited<ReturnType<typeof getSessionById>>>["sandboxState"]
  >;
};

async function resolveGitHubToken(
  userId: string,
  sessionRecord: ActiveSessionRecord,
): Promise<string | null> {
  const [{ getRepoToken }, { getUserGitHubToken }] = await Promise.all([
    import("@/lib/github/get-repo-token"),
    import("@/lib/github/user-token"),
  ]);

  if (sessionRecord.repoOwner) {
    try {
      const tokenResult = await getRepoToken(userId, sessionRecord.repoOwner);
      return tokenResult.token;
    } catch {
      return getUserGitHubToken();
    }
  }

  return getUserGitHubToken();
}

export async function createWorkflowChatRuntime(params: {
  userId: string;
  sessionRecord: ActiveSessionRecord;
}) {
  const [{ discoverSkills }, { connectSandbox }, { DEFAULT_SANDBOX_PORTS }] =
    await Promise.all([
      import("@open-harness/agent"),
      import("@open-harness/sandbox"),
      import("@/lib/sandbox/config"),
    ]);

  const githubToken = await resolveGitHubToken(
    params.userId,
    params.sessionRecord,
  );
  const sandbox = await connectSandbox(params.sessionRecord.sandboxState, {
    env: githubToken ? { GITHUB_TOKEN: githubToken } : undefined,
    ports: DEFAULT_SANDBOX_PORTS,
  });

  if (
    githubToken &&
    params.sessionRecord.repoOwner &&
    params.sessionRecord.repoName
  ) {
    const authUrl = `https://x-access-token:${githubToken}@github.com/${params.sessionRecord.repoOwner}/${params.sessionRecord.repoName}.git`;
    const remoteResult = await sandbox.exec(
      `git remote set-url origin "${authUrl}"`,
      sandbox.workingDirectory,
      5000,
    );

    if (!remoteResult.success) {
      console.warn(
        `Failed to refresh git remote auth for session ${params.sessionRecord.id}: ${remoteResult.stderr ?? remoteResult.stdout}`,
      );
    }
  }

  const skillDirs = [".claude", ".agents"].map(
    (folder) => `${sandbox.workingDirectory}/${folder}/skills`,
  );
  const skills = await discoverSkills(sandbox, skillDirs);

  return {
    sandbox,
    skills,
  };
}
