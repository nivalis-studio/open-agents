import type { Sandbox, SandboxState } from "@open-harness/sandbox";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { modelDescriptorSchema, type ModelDescriptor } from "./models";
import type { SkillMetadata } from "./skills/types";

export const todoStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type TodoStatus = z.infer<typeof todoStatusSchema>;

export const todoItemSchema = z.object({
  id: z.string().describe("Unique identifier for the todo item"),
  content: z.string().describe("The task description"),
  status: todoStatusSchema.describe(
    "Current status. Only ONE task should be in_progress at a time.",
  ),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

/**
 * Approval configuration using a discriminated union that makes the trust model explicit.
 *
 * - 'interactive': Human in the loop, local development. Uses autoApprove and sessionRules.
 * - 'background': Async execution, cloud sandbox. Auto-approve all tools, checkpoint via git.
 * - 'delegated': Subagent inherits trust from parent agent. Auto-approve all tools.
 */
export type ApprovalConfig =
  | {
      type: "interactive";
      autoApprove: "off" | "edits" | "all";
      sessionRules: ApprovalRule[];
    }
  | { type: "background" }
  | { type: "delegated" };

export const approvalRuleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("command-prefix"),
    tool: z.literal("bash"),
    prefix: z.string().min(1, "Prefix cannot be empty"),
  }),
  z.object({
    type: z.literal("path-glob"),
    tool: z.enum(["read", "write", "edit", "grep", "glob"]),
    glob: z.string(),
  }),
  z.object({
    type: z.literal("subagent-type"),
    tool: z.literal("task"),
    subagentType: z.enum(["explorer", "executor"]),
  }),
  z.object({
    type: z.literal("skill"),
    tool: z.literal("skill"),
    skillName: z.string().min(1, "Skill name cannot be empty"),
  }),
]);

export type ApprovalRule = z.infer<typeof approvalRuleSchema>;

export const approvalConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("interactive"),
    autoApprove: z.enum(["off", "edits", "all"]).default("off"),
    sessionRules: z.array(approvalRuleSchema).default([]),
  }),
  z.object({ type: z.literal("background") }),
  z.object({ type: z.literal("delegated") }),
]);

export const compactionContextSchema = z.object({
  contextLimit: z.number().int().positive().optional(),
  lastInputTokens: z.number().int().nonnegative().optional(),
});

export type CompactionContext = z.infer<typeof compactionContextSchema>;

const sandboxTypeSchema = z.literal("vercel");

type RestorableSandboxType = Extract<SandboxState, { type: "vercel" }>["type"];

export const sandboxRuntimeMetadataSchema = z.object({
  sandboxId: z.string().min(1),
  sandboxType: sandboxTypeSchema.default("vercel"),
  workingDirectory: z.string().min(1),
  currentBranch: z.string().optional(),
  environmentDetails: z.string().optional(),
  host: z.string().optional(),
  expiresAt: z.number().int().nonnegative().optional(),
  timeout: z.number().int().positive().optional(),
});

export type SandboxRuntimeMetadata = {
  sandboxId: string;
  sandboxType: RestorableSandboxType;
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
  host?: string;
  expiresAt?: number;
  timeout?: number;
};

export const serializableRuntimeContextSchema =
  sandboxRuntimeMetadataSchema.extend({
    approval: approvalConfigSchema,
    skills: z.custom<SkillMetadata[]>().optional(),
    model: modelDescriptorSchema,
    subagentModel: modelDescriptorSchema.optional(),
    customInstructions: z.string().optional(),
    context: compactionContextSchema.optional(),
  });

export interface SerializableRuntimeContext extends SandboxRuntimeMetadata {
  approval: ApprovalConfig;
  skills?: SkillMetadata[];
  model: ModelDescriptor;
  subagentModel?: ModelDescriptor;
  customInstructions?: string;
  context?: CompactionContext;
}

export interface LiveAgentContext {
  sandbox: Sandbox;
  approval: ApprovalConfig;
  skills?: SkillMetadata[];
  model: LanguageModel;
  subagentModel?: LanguageModel;
  customInstructions?: string;
  context?: CompactionContext;
}

export type AgentRuntimeContext = SerializableRuntimeContext | LiveAgentContext;

export const EVICTION_THRESHOLD_BYTES = 80 * 1024;
