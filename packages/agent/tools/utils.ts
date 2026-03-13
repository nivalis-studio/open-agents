import { connectSandbox, type Sandbox } from "@open-harness/sandbox";
import type { LanguageModel, ModelMessage } from "ai";
import * as path from "path";
import { createLanguageModelFromDescriptor } from "../models";
import type {
  ApprovalConfig,
  ApprovalRule,
  AgentRuntimeContext,
  LiveAgentContext,
  SerializableRuntimeContext,
} from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSandbox(value: unknown): value is Sandbox {
  return isRecord(value) && typeof value.workingDirectory === "string";
}

export function isLiveAgentContext(value: unknown): value is LiveAgentContext {
  return (
    isRecord(value) &&
    "sandbox" in value &&
    isSandbox(value.sandbox) &&
    "approval" in value &&
    "model" in value
  );
}

export function isSerializableRuntimeContext(
  value: unknown,
): value is SerializableRuntimeContext {
  return (
    isRecord(value) &&
    typeof value.sandboxId === "string" &&
    value.sandboxId.length > 0 &&
    typeof value.workingDirectory === "string" &&
    value.workingDirectory.length > 0 &&
    "approval" in value &&
    "model" in value
  );
}

function getContextKeys(value: unknown): string {
  if (!isRecord(value)) {
    return "Context is undefined or null";
  }

  return `Context keys: ${Object.keys(value).join(", ")}`;
}

function getRuntimeContext(
  experimental_context: unknown,
): AgentRuntimeContext | undefined {
  if (isLiveAgentContext(experimental_context)) {
    return experimental_context;
  }

  if (isSerializableRuntimeContext(experimental_context)) {
    return experimental_context;
  }

  return undefined;
}

const sandboxCache = new Map<string, Promise<Sandbox>>();

export function clearSandboxCache(): void {
  sandboxCache.clear();
}

/**
 * Check if a file path is within a given directory.
 * Used as a security boundary to prevent path traversal attacks.
 *
 * @param filePath - The path to check
 * @param directory - The directory that should contain the path
 * @returns true if filePath is within or equal to directory
 */
export function isPathWithinDirectory(
  filePath: string,
  directory: string,
): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedDir = path.resolve(directory);
  return (
    resolvedPath.startsWith(resolvedDir + path.sep) ||
    resolvedPath === resolvedDir
  );
}

/**
 * Convert a path into a compact, model-friendly display path.
 *
 * Paths inside the sandbox working directory are returned relative to that
 * directory (e.g., "src/index.ts") to avoid repeating long absolute prefixes.
 * Paths outside the working directory remain absolute for clarity and safety.
 */
export function toDisplayPath(
  filePath: string,
  workingDirectory: string,
): string {
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workingDirectory, filePath);

  if (!isPathWithinDirectory(absolutePath, workingDirectory)) {
    return absolutePath.replace(/\\/g, "/");
  }

  const relativePath = path.relative(workingDirectory, absolutePath);
  if (relativePath === "") {
    return ".";
  }

  return relativePath.replace(/\\/g, "/");
}

/**
 * Get sandbox from experimental context with null safety.
 * When the context only contains serializable runtime metadata, reconnects the
 * sandbox lazily from `sandboxId` and caches it process-locally.
 */
export async function getSandbox(
  experimental_context: unknown,
  toolName?: string,
): Promise<Sandbox> {
  const context = getRuntimeContext(experimental_context);

  if (isLiveAgentContext(context)) {
    return context.sandbox;
  }

  if (context?.sandboxId) {
    const cachedSandbox = sandboxCache.get(context.sandboxId);
    if (cachedSandbox) {
      return cachedSandbox;
    }

    const sandboxPromise = connectSandbox({
      type: context.sandboxType,
      sandboxId: context.sandboxId,
      ...(context.expiresAt !== undefined
        ? { expiresAt: context.expiresAt }
        : {}),
    });

    sandboxCache.set(context.sandboxId, sandboxPromise);

    try {
      return await sandboxPromise;
    } catch (error) {
      sandboxCache.delete(context.sandboxId);
      throw error;
    }
  }

  const toolInfo = toolName ? ` (tool: ${toolName})` : "";
  throw new Error(
    `Sandbox not initialized in context${toolInfo}. ${getContextKeys(experimental_context)}. ` +
      "Ensure the agent runtime provides either a live sandbox or serializable sandbox metadata.",
  );
}

/**
 * Check if the approval config implies full trust (auto-approve everything within sandbox).
 * Returns true for background and delegated modes.
 *
 * This is a type guard - after checking, TypeScript narrows the type.
 *
 * @param approval - The approval configuration
 * @returns true if the context implies full trust
 */
export function shouldAutoApprove(
  approval: ApprovalConfig,
): approval is { type: "background" } | { type: "delegated" } {
  return approval.type === "background" || approval.type === "delegated";
}

/**
 * Get the approval context from experimental_context.
 * Used by needsApproval functions to access approval configuration and the
 * serialized working directory without requiring a live sandbox connection.
 */
export function getApprovalContext(
  experimental_context: unknown,
  toolName?: string,
): {
  workingDirectory: string;
  approval: ApprovalConfig;
} {
  const context = getRuntimeContext(experimental_context);

  // Default to interactive mode with no auto-approve if approval config is missing
  const defaultApproval: ApprovalConfig = {
    type: "interactive",
    autoApprove: "off",
    sessionRules: [],
  };

  if (isLiveAgentContext(context)) {
    return {
      workingDirectory: context.sandbox.workingDirectory,
      approval: context.approval ?? defaultApproval,
    };
  }

  if (isSerializableRuntimeContext(context)) {
    return {
      workingDirectory: context.workingDirectory,
      approval: context.approval ?? defaultApproval,
    };
  }

  const toolInfo = toolName ? ` (tool: ${toolName})` : "";
  throw new Error(
    `Approval context not initialized${toolInfo}. ${getContextKeys(experimental_context)}. ` +
      "Ensure the agent runtime provides workingDirectory and approval metadata.",
  );
}

/**
 * Get model from experimental context with null safety.
 * Reconstructs the model from a serializable descriptor when needed.
 */
export function getModel(
  experimental_context: unknown,
  toolName?: string,
): LanguageModel {
  const context = getRuntimeContext(experimental_context);

  if (isLiveAgentContext(context) && context.model) {
    return context.model;
  }

  if (isSerializableRuntimeContext(context) && context.model) {
    return createLanguageModelFromDescriptor(context.model);
  }

  const toolInfo = toolName ? ` (tool: ${toolName})` : "";
  throw new Error(
    `Model not initialized in context${toolInfo}. ${getContextKeys(experimental_context)}. ` +
      "Ensure the agent runtime provides either a live model or model descriptor.",
  );
}

/**
 * Get subagent model from experimental context, falling back to the main model.
 * Returns the dedicated subagent model if configured, otherwise the main agent model.
 */
export function getSubagentModel(
  experimental_context: unknown,
  toolName?: string,
): LanguageModel {
  const context = getRuntimeContext(experimental_context);

  if (isLiveAgentContext(context)) {
    if (!context.model) {
      const toolInfo = toolName ? ` (tool: ${toolName})` : "";
      throw new Error(
        `Model not initialized in context${toolInfo}. Ensure the agent runtime provides a model.`,
      );
    }
    return context.subagentModel ?? context.model;
  }

  if (isSerializableRuntimeContext(context)) {
    return createLanguageModelFromDescriptor(
      context.subagentModel ?? context.model,
    );
  }

  const toolInfo = toolName ? ` (tool: ${toolName})` : "";
  throw new Error(
    `Model not initialized in context${toolInfo}. ${getContextKeys(experimental_context)}. ` +
      "Ensure the agent runtime provides either a live model or model descriptor.",
  );
}

/**
 * Simple glob pattern matching for approval rules.
 * Supports patterns like "src/**", "**\/*.ts", "src/components/**".
 *
 * @param filePath - The absolute file path to check
 * @param glob - The glob pattern to match against
 * @param baseDir - The base directory for relative glob patterns
 * @param options - Optional settings
 * @param options.allowOutsideBase - If true, allow matching paths outside baseDir (for read approval rules)
 * @returns true if the file path matches the glob pattern
 */
export function pathMatchesGlob(
  filePath: string,
  glob: string,
  baseDir: string,
  options?: { allowOutsideBase?: boolean },
): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(baseDir);

  // By default, ensure the path is within the base directory
  // This can be skipped for read approval rules which apply to paths outside the working directory
  if (!options?.allowOutsideBase) {
    if (!isPathWithinDirectory(resolvedPath, resolvedBase)) {
      return false;
    }
  }

  // Get the relative path from the base directory
  // Normalize to POSIX separators for consistent matching
  const relativePath = path
    .relative(resolvedBase, resolvedPath)
    .replace(/\\/g, "/");

  // Convert glob pattern to regex
  // First escape regex metacharacters (except * which we handle specially)
  // Then handle ** (match any directory depth), * (match any chars except /)
  try {
    const globRegex = glob
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // Escape regex metacharacters
      .replace(/\*\*/g, "<<<GLOBSTAR>>>") // Temporary placeholder
      .replace(/\*/g, "[^/]*") // * matches anything except /
      .replace(/<<<GLOBSTAR>>>/g, ".*") // ** matches anything including /
      .replace(/\//g, "\\/"); // Escape path separators

    const regex = new RegExp(`^${globRegex}`);
    if (regex.test(relativePath)) {
      return true;
    }
    // If glob ends with /** and path doesn't end with /, try adding trailing /
    // This allows directory paths to match their own glob (e.g., "apps" matches "apps/**")
    if (glob.endsWith("/**") && !relativePath.endsWith("/")) {
      return regex.test(relativePath + "/");
    }
    return false;
  } catch {
    // If regex construction fails (malformed pattern), treat as no match
    return false;
  }
}

/**
 * Tools that can have path-glob approval rules.
 */
export type PathToolName = "read" | "write" | "edit" | "grep" | "glob";

/**
 * Check if a file path matches any path-glob approval rules for a specific tool.
 * Rules can apply to paths outside the working directory, so we allow matching outside the base.
 */
export function pathMatchesApprovalRule(
  filePath: string,
  tool: PathToolName,
  workingDirectory: string,
  approvalRules: ApprovalRule[],
): boolean {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workingDirectory, filePath);

  for (const rule of approvalRules) {
    if (rule.type === "path-glob" && rule.tool === tool) {
      if (
        pathMatchesGlob(absolutePath, rule.glob, workingDirectory, {
          allowOutsideBase: true,
        })
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Options for checking if a path-based operation needs approval.
 */
type PathApprovalOptions = {
  /** The file path to check */
  path: string;
  /** The tool making the request */
  tool: PathToolName;
  /** The approval config (must be interactive - use shouldAutoApprove first) */
  approval: {
    type: "interactive";
    autoApprove: "off" | "edits" | "all";
    sessionRules: ApprovalRule[];
  };
  /** The working directory for path resolution */
  workingDirectory: string;
};

/**
 * Determines if a path-based operation needs approval.
 *
 * Call shouldAutoApprove() first - this function assumes interactive mode.
 *
 * Logic:
 * - Read-only tools (read, grep, glob): auto-approve inside working dir, check session rules outside
 * - Write tools (write, edit): check session rules first, then working dir + autoApprove setting
 *
 * @returns true if approval is needed, false if auto-approved
 */
export function pathNeedsApproval(options: PathApprovalOptions): boolean {
  const { path: filePath, tool, approval, workingDirectory } = options;

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workingDirectory, filePath);

  const isInsideWorkingDir = isPathWithinDirectory(
    absolutePath,
    workingDirectory,
  );
  const isWriteTool = tool === "write" || tool === "edit";

  if (isWriteTool) {
    // Write tools: session rules can auto-approve any path (inside or outside)
    if (
      pathMatchesApprovalRule(
        filePath,
        tool,
        workingDirectory,
        approval.sessionRules,
      )
    ) {
      return false;
    }

    // Outside working directory without matching rule = needs approval
    if (!isInsideWorkingDir) {
      return true;
    }

    // Inside working directory: check autoApprove setting
    if (approval.autoApprove === "edits" || approval.autoApprove === "all") {
      return false;
    }

    // Inside working directory but autoApprove doesn't cover edits
    return true;
  }

  // Read-only tools: inside working directory = auto-approve
  if (isInsideWorkingDir) {
    return false;
  }

  // Outside working directory: check session rules
  if (
    pathMatchesApprovalRule(
      filePath,
      tool,
      workingDirectory,
      approval.sessionRules,
    )
  ) {
    return false;
  }

  // Outside working directory without matching rule = needs approval
  return true;
}

/**
 * Escape a string for safe use in a single-quoted shell argument.
 * Wraps the string in single quotes and escapes any embedded single quotes.
 */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export type ToolNeedsApprovalFunction<INPUT> = (
  input: INPUT,
  options: {
    /**
     * The ID of the tool call. You can use it e.g. when sending tool-call related information with stream data.
     */
    toolCallId: string;

    /**
     * Messages that were sent to the language model to initiate the response that contained the tool call.
     * The messages **do not** include the system prompt nor the assistant response that contained the tool call.
     */
    messages: ModelMessage[];

    /**
     * Additional context.
     *
     * Experimental (can break in patch releases).
     */
    experimental_context?: unknown;
  },
) => boolean | PromiseLike<boolean>;
