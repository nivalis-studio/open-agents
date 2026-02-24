import { createHash } from "node:crypto";
import {
  discoverSkills,
  gateway,
} from "@open-harness/agent";
import { connectSandbox } from "@open-harness/sandbox";
import { DEFAULT_SANDBOX_PORTS } from "@/lib/sandbox/config";
import {
  convertToModelMessages,
  type GatewayModelId,
  type LanguageModel,
  type UIMessageChunk,
} from "ai";
import { start } from "workflow/api";
import type { WebAgentUIMessage } from "@/app/types";
import { durableChatWorkflow } from "@/app/workflows/durable-chat";
import { webAgent } from "@/app/config";
import {
  createChatMessageIfNotExists,
  getChatById,
  getSessionById,
  isFirstChatMessage,
  updateChat,
  updateSession,
} from "@/lib/db/sessions";
import { getRepoToken } from "@/lib/github/get-repo-token";
import { getUserGitHubToken } from "@/lib/github/user-token";
import { getUserPreferences } from "@/lib/db/user-preferences";
import { DEFAULT_MODEL_ID } from "@/lib/models";
import { buildActiveLifecycleUpdate } from "@/lib/sandbox/lifecycle";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";

const SKILLS_CACHE_TTL_MS = 60_000;

type DiscoveredSkills = Awaited<ReturnType<typeof discoverSkills>>;

const discoveredSkillsCache = new Map<
  string,
  { skills: DiscoveredSkills; expiresAt: number }
>();
const remoteAuthFingerprintBySessionId = new Map<string, string>();

const getRemoteAuthFingerprint = (authUrl: string) =>
  createHash("sha256").update(authUrl).digest("hex");

const getSkillCacheKey = (sessionId: string, workingDirectory: string) =>
  `${sessionId}:${workingDirectory}`;

const pruneExpiredSkillCache = (now: number) => {
  for (const [key, entry] of discoveredSkillsCache) {
    if (entry.expiresAt <= now) {
      discoveredSkillsCache.delete(key);
    }
  }
};

interface ChatRequestBody {
  messages: WebAgentUIMessage[];
  sessionId?: string;
  chatId?: string;
}

export async function POST(req: Request) {
  // 1. Validate session
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { messages, sessionId, chatId } = body;

  // 2. Require sessionId and chatId
  if (!sessionId || !chatId) {
    return Response.json(
      { error: "sessionId and chatId are required" },
      { status: 400 },
    );
  }

  // 3. Verify session + chat ownership
  const [sessionRecord, chat] = await Promise.all([
    getSessionById(sessionId),
    getChatById(chatId),
  ]);

  if (!sessionRecord) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  if (sessionRecord.userId !== session.user.id) {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }
  if (!chat || chat.sessionId !== sessionId) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  // 4. Require active sandbox
  if (!isSandboxActive(sessionRecord.sandboxState)) {
    return Response.json({ error: "Sandbox not initialized" }, { status: 400 });
  }

  // Refresh lifecycle activity timestamps
  const requestStartedAt = new Date();
  await updateSession(sessionId, {
    ...buildActiveLifecycleUpdate(sessionRecord.sandboxState, {
      activityAt: requestStartedAt,
    }),
  });

  const modelMessages = await convertToModelMessages(messages, {
    ignoreIncompleteToolCalls: true,
    tools: webAgent.tools,
  });

  // Resolve GitHub token
  let githubToken: string | null = null;
  if (sessionRecord.repoOwner) {
    try {
      const tokenResult = await getRepoToken(
        session.user.id,
        sessionRecord.repoOwner,
      );
      githubToken = tokenResult.token;
    } catch {
      githubToken = await getUserGitHubToken();
    }
  } else {
    githubToken = await getUserGitHubToken();
  }

  // Connect sandbox
  const sandbox = await connectSandbox(sessionRecord.sandboxState, {
    env: githubToken ? { GITHUB_TOKEN: githubToken } : undefined,
    ports: DEFAULT_SANDBOX_PORTS,
  });

  // Refresh git remote auth
  if (githubToken && sessionRecord.repoOwner && sessionRecord.repoName) {
    const authUrl = `https://x-access-token:${githubToken}@github.com/${sessionRecord.repoOwner}/${sessionRecord.repoName}.git`;
    const authFingerprint = getRemoteAuthFingerprint(authUrl);
    const previousAuthFingerprint =
      remoteAuthFingerprintBySessionId.get(sessionId);

    if (previousAuthFingerprint !== authFingerprint) {
      const remoteResult = await sandbox.exec(
        `git remote set-url origin "${authUrl}"`,
        sandbox.workingDirectory,
        5000,
      );

      if (!remoteResult.success) {
        console.warn(
          `Failed to refresh git remote auth for session ${sessionId}: ${remoteResult.stderr ?? remoteResult.stdout}`,
        );
      } else {
        remoteAuthFingerprintBySessionId.set(sessionId, authFingerprint);
      }
    }
  } else {
    remoteAuthFingerprintBySessionId.delete(sessionId);
  }

  // Discover skills
  const skillBaseFolders = [".claude", ".agents"];
  const skillDirs = skillBaseFolders.map(
    (folder) => `${sandbox.workingDirectory}/${folder}/skills`,
  );
  const now = Date.now();
  pruneExpiredSkillCache(now);
  const skillCacheKey = getSkillCacheKey(sessionId, sandbox.workingDirectory);
  const cachedSkills = discoveredSkillsCache.get(skillCacheKey);

  let skills: DiscoveredSkills;
  if (cachedSkills && cachedSkills.expiresAt > now) {
    skills = cachedSkills.skills;
  } else {
    skills = await discoverSkills(sandbox, skillDirs);
    discoveredSkillsCache.set(skillCacheKey, {
      skills,
      expiresAt: now + SKILLS_CACHE_TTL_MS,
    });
  }

  // Save user message immediately (incremental persistence)
  if (chatId && messages.length > 0) {
    const latestMessage = messages[messages.length - 1];
    if (
      latestMessage &&
      latestMessage.role === "user" &&
      typeof latestMessage.id === "string" &&
      latestMessage.id.length > 0
    ) {
      try {
        const createdUserMessage = await createChatMessageIfNotExists({
          id: latestMessage.id,
          chatId,
          role: "user",
          parts: latestMessage,
        });

        const shouldSetTitle =
          createdUserMessage !== undefined &&
          (await isFirstChatMessage(chatId, createdUserMessage.id));

        if (shouldSetTitle) {
          const textContent = latestMessage.parts
            .filter(
              (part): part is { type: "text"; text: string } =>
                part.type === "text",
            )
            .map((part) => part.text)
            .join(" ")
            .trim();

          if (textContent.length > 0) {
            const title =
              textContent.length > 30
                ? `${textContent.slice(0, 30)}...`
                : textContent;
            await updateChat(chatId, { title });
          }
        }
      } catch (error) {
        console.error("Failed to save latest chat message:", error);
      }
    }
  }

  // Resolve model
  const modelId = chat.modelId ?? DEFAULT_MODEL_ID;
  let model;
  try {
    model = gateway(modelId as GatewayModelId);
  } catch (error) {
    console.error(
      `Invalid model ID "${modelId}", falling back to default:`,
      error,
    );
    model = gateway(DEFAULT_MODEL_ID as GatewayModelId);
  }

  // Resolve subagent model
  let subagentModel: LanguageModel | undefined;
  try {
    const preferences = await getUserPreferences(session.user.id);
    if (preferences.defaultSubagentModelId) {
      subagentModel = gateway(
        preferences.defaultSubagentModelId as GatewayModelId,
      );
    }
  } catch (error) {
    console.error("Failed to resolve subagent model preference:", error);
  }

  // Start the durable workflow
  const run = await start(durableChatWorkflow, [
    modelMessages,
    {
      sandbox,
      model,
      subagentModel,
      approval: {
        type: "interactive" as const,
        autoApprove: "all" as const,
        sessionRules: [],
      },
      ...(skills.length > 0 && { skills }),
    },
  ]);

  // Store run ID as activeStreamId so the client can reconnect
  await updateChat(chatId, { activeStreamId: run.runId });

  // Return the workflow's readable stream as a UIMessageChunk stream
  const stream = run.getReadable<UIMessageChunk>();

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-workflow-run-id": run.runId,
    },
  });
}
