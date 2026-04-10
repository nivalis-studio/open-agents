import { discoverSkills } from "@open-harness/agent";
import { connectSandbox } from "@open-harness/sandbox";
import { getUserGitHubToken } from "@/lib/github/user-token";
import { getEnabledMCPConnections } from "@/lib/db/mcp-connections";
import {
  resolveMCPTools,
  closeMCPClients,
  type ResolvedMCPTools,
} from "@/lib/mcp/client";
import { DEFAULT_SANDBOX_PORTS } from "@/lib/sandbox/config";
import {
  getVercelCliSandboxSetup,
  syncVercelCliAuthToSandbox,
} from "@/lib/sandbox/vercel-cli-auth";
import { getSandboxSkillDirectories } from "@/lib/skills/directories";
import { getCachedSkills, setCachedSkills } from "@/lib/skills-cache";
import type { SessionRecord } from "./chat-context";

type DiscoveredSkills = Awaited<ReturnType<typeof discoverSkills>>;
type ConnectedSandbox = Awaited<ReturnType<typeof connectSandbox>>;
type ActiveSandboxState = NonNullable<SessionRecord["sandboxState"]>;

async function loadSessionSkills(
  sessionId: string,
  sandboxState: ActiveSandboxState,
  sandbox: ConnectedSandbox,
): Promise<DiscoveredSkills> {
  const cachedSkills = await getCachedSkills(sessionId, sandboxState);
  if (cachedSkills !== null) {
    return cachedSkills;
  }

  // Discover project-level skills from the sandbox working directory plus
  // global skills installed outside the repo working tree.
  // TODO: Optimize if this becomes a bottleneck (~20ms no skills, ~130ms with 5 skills)
  const skillDirs = await getSandboxSkillDirectories(sandbox);

  const discoveredSkills = await discoverSkills(sandbox, skillDirs);
  await setCachedSkills(sessionId, sandboxState, discoveredSkills);
  return discoveredSkills;
}

export { closeMCPClients };
export type { ResolvedMCPTools };

const EMPTY_MCP_RESULT: ResolvedMCPTools = {
  tools: {},
  clients: [],
  connectionDescriptions: [],
};

export async function createChatRuntime(params: {
  userId: string;
  sessionId: string;
  sessionRecord: SessionRecord;
}): Promise<{
  sandbox: ConnectedSandbox;
  skills: DiscoveredSkills;
  mcpResult: ResolvedMCPTools;
}> {
  const { userId, sessionId, sessionRecord } = params;

  const sandboxState = sessionRecord.sandboxState;
  if (!sandboxState) {
    throw new Error("Sandbox state is required to create chat runtime");
  }

  const [githubToken, vercelCliSetup] = await Promise.all([
    getUserGitHubToken(userId),
    getVercelCliSandboxSetup({ userId, sessionRecord }).catch((error) => {
      console.warn(
        `Failed to prepare Vercel CLI setup for session ${sessionId}:`,
        error,
      );
      return null;
    }),
  ]);

  const sandbox = await connectSandbox(sandboxState, {
    githubToken: githubToken ?? undefined,
    ports: DEFAULT_SANDBOX_PORTS,
  });

  if (vercelCliSetup) {
    try {
      await syncVercelCliAuthToSandbox({ sandbox, setup: vercelCliSetup });
    } catch (error) {
      console.warn(
        `Failed to sync Vercel CLI auth for session ${sessionId}:`,
        error,
      );
    }
  }

  const skills = await loadSessionSkills(sessionId, sandboxState, sandbox);

  // Resolve MCP connections for this session
  const enabledMcpIds =
    (sessionRecord as SessionRecord & { enabledMcpConnectionIds?: string[] })
      .enabledMcpConnectionIds ?? [];

  let mcpResult: ResolvedMCPTools = EMPTY_MCP_RESULT;
  if (enabledMcpIds.length > 0) {
    try {
      const connections = await getEnabledMCPConnections(userId, enabledMcpIds);
      if (connections.length > 0) {
        mcpResult = await resolveMCPTools(connections);
      }
    } catch (error) {
      console.error(
        `Failed to resolve MCP tools for session ${sessionId}:`,
        error,
      );
    }
  }

  return {
    sandbox,
    skills,
    mcpResult,
  };
}
